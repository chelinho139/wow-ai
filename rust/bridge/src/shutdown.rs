//! Console handlers only set an atomic flag. The normal runtime thread performs
//! process cleanup and offline publication; no file I/O runs in the handler.
use std::{
    io,
    sync::atomic::{AtomicBool, Ordering},
};
static STOP: AtomicBool = AtomicBool::new(false);
pub fn requested() -> bool {
    STOP.load(Ordering::SeqCst)
}
pub struct Guard {
    #[cfg(unix)]
    previous: usize,
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}
#[cfg(windows)]
unsafe extern "system" fn console_handler(event: u32) -> i32 {
    if event == 0 || event == 1 {
        STOP.store(true, Ordering::SeqCst);
        1
    } else {
        0
    }
}
#[cfg(unix)]
unsafe extern "C" {
    fn signal(sig: i32, handler: usize) -> usize;
}
#[cfg(unix)]
extern "C" fn interrupt_handler(_: i32) {
    STOP.store(true, Ordering::SeqCst);
}

pub fn install() -> io::Result<Guard> {
    STOP.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    // SAFETY: callback has the console handler ABI and static lifetime.
    if unsafe { SetConsoleCtrlHandler(Some(console_handler), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(unix)]
    {
        // SAFETY: SIGINT callback has C ABI, static lifetime and only stores an atomic.
        let previous = unsafe { signal(2, interrupt_handler as *const () as usize) };
        if previous == usize::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(Guard { previous })
    }
    #[cfg(not(unix))]
    Ok(Guard {})
}
impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: removes exactly the callback registered by install.
        unsafe {
            SetConsoleCtrlHandler(Some(console_handler), 0);
        }
        #[cfg(unix)]
        // SAFETY: restores the handler value returned by signal for SIGINT.
        unsafe {
            signal(2, self.previous);
        }
    }
}
