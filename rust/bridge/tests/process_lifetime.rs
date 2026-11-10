//! Windows-only abrupt-owner-death proof, using native process handles so PID
//! reuse cannot turn a terminated-process check into a false success.
#![cfg(windows)]
use std::{
    ffi::c_void,
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use wow_ai_reforged::process::{self, Request};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Owner(std::process::Child);
impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Workspace(PathBuf);
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn windows_job_owner_child() {
    let Ok(root) = std::env::var("WOW_AI_TEST_JOB_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let args = [
        "__fixture-agent".into(),
        "codex".into(),
        "spawn-child".into(),
        "--heartbeat-file".into(),
        root.join("heartbeat").into_os_string(),
        "--pid-file".into(),
        root.join("pids").into_os_string(),
    ];
    let _ = process::run(Request {
        program: std::path::Path::new(env!("CARGO_BIN_EXE_wow-ai-reforged")),
        args: &args,
        cwd: &root,
        input: None,
        env: &[],
        timeout: Duration::from_secs(30),
        max_output: 4096,
    });
    panic!("owner was supposed to be killed while its agent was running");
}

#[test]
fn abrupt_bridge_death_terminates_agent_and_descendant() {
    let root =
        Workspace(std::env::temp_dir().join(format!("reforged-job-death-{}", std::process::id())));
    fs::create_dir(&root.0).unwrap();
    let mut owner = Owner(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "windows_job_owner_child", "--nocapture"])
            .env("WOW_AI_TEST_JOB_ROOT", &root.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let start = Instant::now();
    let pids = loop {
        if let Ok(pids) = fs::read_to_string(root.0.join("pids"))
            && pids.split_whitespace().count() == 2
            && root.0.join("heartbeat").is_file()
        {
            break pids;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "contained provider did not start"
        );
        assert!(
            owner.0.try_wait().unwrap().is_none(),
            "owner failed before containment/launch"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let handles: Vec<_> = pids
        .split_whitespace()
        .map(|pid| {
            // SYNCHRONIZE; non-inheritable handles retained by this external observer.
            let handle = unsafe { OpenProcess(0x0010_0000, 0, pid.parse().unwrap()) };
            assert!(!handle.is_null(), "could not open live provider process");
            let handle = Handle(handle);
            assert_eq!(
                unsafe { WaitForSingleObject(handle.0, 0) },
                258,
                "process already exited"
            );
            handle
        })
        .collect();
    assert_eq!(handles.len(), 2);
    owner.0.kill().unwrap();
    owner.0.wait().unwrap();
    for handle in handles {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.0, 5000) },
            0,
            "provider or descendant survived bridge death"
        );
    }
}
