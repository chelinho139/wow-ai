//! Bounded, headless process execution. No shell command interpolation.
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};

pub struct Request<'a> {
    pub program: &'a Path,
    pub args: &'a [OsString],
    pub cwd: &'a Path,
    pub input: Option<&'a [u8]>,
    pub env: &'a [(OsString, Option<OsString>)],
    pub timeout: Duration,
    pub max_output: usize,
}
#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

enum Event {
    Data(bool, Vec<u8>),
    Closed(bool),
    Input(io::Result<()>),
    Failed(io::Error),
}
fn reader(
    mut source: impl Read + Send + 'static,
    stdout: bool,
    tx: SyncSender<Event>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0_u8; 4096];
        loop {
            match source.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Event::Closed(stdout));
                    return;
                }
                Ok(n) => {
                    if tx.send(Event::Data(stdout, buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    let _ = tx.send(Event::Failed(e));
                    return;
                }
            }
        }
    })
}

fn wait_for_tree_killer(name: &str, killer: io::Result<Child>) -> io::Result<()> {
    let mut killer = killer.map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("could not start {name} for process-tree cleanup: {e}"),
        )
    })?;
    let deadline = Instant::now();
    loop {
        match killer.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(io::Error::other(format!(
                    "{name} failed process-tree cleanup with {status}"
                )));
            }
            Ok(None) if deadline.elapsed() < Duration::from_secs(1) => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = killer.kill();
                let _ = killer.try_wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{name} did not finish process-tree cleanup within one second"),
                ));
            }
            Err(e) => {
                return Err(io::Error::new(
                    e.kind(),
                    format!("could not read {name} process-tree cleanup status: {e}"),
                ));
            }
        }
    }
}

fn terminate(child: &mut Child) -> io::Result<()> {
    #[cfg(windows)]
    let tree_cleanup = {
        use std::os::windows::process::CommandExt;
        wait_for_tree_killer(
            "taskkill.exe",
            Command::new("taskkill.exe")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn(),
        )
    };
    #[cfg(unix)]
    let tree_cleanup = wait_for_tree_killer(
        "/bin/kill",
        Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn(),
    );
    let _ = child.kill();
    // Do not block on an unbounded OS wait during error cleanup.
    let deadline = Instant::now();
    while matches!(child.try_wait(), Ok(None)) && deadline.elapsed() < Duration::from_secs(1) {
        thread::sleep(Duration::from_millis(10));
    }
    let direct_cleanup = match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(io::Error::other(
            "agent process is still running after cleanup grace",
        )),
        Err(e) => Err(io::Error::other(format!(
            "cannot confirm agent process termination: {e}"
        ))),
    };
    match (tree_cleanup, direct_cleanup) {
        (Err(tree), Err(direct)) => Err(io::Error::other(format!(
            "{direct}; process-tree cleanup is also unconfirmed: {tree}"
        ))),
        (Ok(()), Err(direct)) => Err(direct),
        (Err(tree), Ok(())) => Err(io::Error::other(format!(
            "direct agent stopped, but process-tree cleanup is unconfirmed: {tree}"
        ))),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub fn run(request: Request<'_>) -> io::Result<Output> {
    run_with_tick(request, || Ok(()))
}

pub fn run_with_tick(
    request: Request<'_>,
    mut on_tick: impl FnMut() -> io::Result<()>,
) -> io::Result<Output> {
    if request.timeout.is_zero() || request.max_output == 0 {
        return Err(io::Error::other("invalid process limits"));
    }
    crate::process_lifetime::ensure_contained()?;
    let mut command = Command::new(request.program);
    command
        .args(request.args)
        .current_dir(request.cwd)
        .stdin(if request.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in request.env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let command_units = std::iter::once(request.program.as_os_str())
            .chain(request.args.iter().map(OsString::as_os_str))
            .map(|arg| {
                arg.encode_wide()
                    .count()
                    .saturating_mul(2)
                    .saturating_add(3)
            })
            .sum::<usize>();
        if command_units > 30000 {
            return Err(io::Error::other(
                "agent arguments exceed the conservative Windows command-line budget; shorten the prompt or launcher arguments",
            ));
        }
    }
    let mut child = command.spawn()?;
    let (tx, rx) = mpsc::sync_channel(4);
    let mut workers = vec![
        reader(child.stdout.take().unwrap(), true, tx.clone()),
        reader(child.stderr.take().unwrap(), false, tx.clone()),
    ];
    let mut input_done = request.input.is_none();
    if let Some(input) = request.input {
        let mut stdin = child.stdin.take().unwrap();
        let input = input.to_vec();
        let tx = tx.clone();
        workers.push(thread::spawn(move || {
            let result = stdin.write_all(&input);
            drop(stdin);
            let _ = tx.send(Event::Input(result));
        }));
    }
    drop(tx);
    let start = Instant::now();
    let (mut stdout_done, mut stderr_done) = (false, false);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut result = (|| {
        loop {
            if start.elapsed() >= request.timeout {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "agent exceeded timeout",
                ));
            }
            on_tick()?;
            let status = child.try_wait()?;
            if let Some(status) = status
                && stdout_done
                && stderr_done
                && input_done
            {
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(Event::Data(is_stdout, bytes)) => {
                    if stdout
                        .len()
                        .saturating_add(stderr.len())
                        .saturating_add(bytes.len())
                        > request.max_output
                    {
                        return Err(io::Error::other("agent output exceeded limit"));
                    }
                    if is_stdout {
                        stdout.extend(bytes);
                    } else {
                        stderr.extend(bytes);
                    }
                }
                Ok(Event::Closed(is_stdout)) => {
                    if is_stdout {
                        stdout_done = true;
                    } else {
                        stderr_done = true;
                    }
                }
                Ok(Event::Input(result)) => {
                    input_done = true;
                    if let Err(e) = result
                        && e.kind() != io::ErrorKind::BrokenPipe
                    {
                        return Err(e);
                    }
                }
                Ok(Event::Failed(e)) => return Err(e),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    })();
    if result.is_err()
        && let Err(cleanup) = terminate(&mut child)
    {
        result = Err(io::Error::other(format!(
            "{}; cleanup failed: {cleanup}",
            result.as_ref().unwrap_err()
        )));
    }
    drop(rx);
    let cleanup = Instant::now();
    while workers.iter().any(|w| !w.is_finished()) && cleanup.elapsed() < Duration::from_secs(1) {
        thread::sleep(Duration::from_millis(10));
    }
    let unsettled = workers.iter().any(|w| !w.is_finished());
    for worker in workers {
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
    if unsettled {
        return Err(io::Error::other(format!(
            "{}; I/O workers did not settle during cleanup grace",
            result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_else(|| "agent exited".into())
        )));
    }
    result
}

/// Reject Windows shell launchers; select an executable and optional launcher
/// arguments explicitly (e.g. node.exe + agent.js) rather than invoking cmd.exe.
pub fn validate_program(path: &Path) -> io::Result<()> {
    if let Some(ext) = path.extension().and_then(|s| s.to_str())
        && ["cmd", "bat", "ps1"]
            .iter()
            .any(|e| ext.eq_ignore_ascii_case(e))
    {
        return Err(io::Error::other(
            "configure the underlying agent executable, not a shell launcher",
        ));
    }
    if !path.is_absolute() {
        return Err(io::Error::other(
            "agent executable must be an absolute path",
        ));
    }
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("agent executable not found: {}", path.display()),
        ));
    }
    Ok(())
}

pub fn resolve_path(base: &Path, value: &Path) -> PathBuf {
    if value.is_absolute() {
        value.into()
    } else {
        base.join(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_cleanup_reports_launcher_failure() {
        let error = wait_for_tree_killer(
            "missing-killer",
            Err(io::Error::new(io::ErrorKind::NotFound, "not installed")),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(error.to_string().contains("could not start missing-killer"));
    }

    #[test]
    fn tree_cleanup_reports_nonzero_exit() {
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--definitely-not-a-test-harness-option")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let error = wait_for_tree_killer("fake-killer", child).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("fake-killer failed process-tree cleanup")
        );
    }
}
