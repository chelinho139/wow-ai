//! Process-tree lifetime containment for provider processes.
//!
//! On Windows, the bridge joins an unnamed Job Object configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before it can launch a provider. Future
//! provider processes inherit membership in that job at creation, so there is
//! no spawn/assign gap. The bridge retains the only job handle for its entire
//! lifetime; Windows closes it when the bridge exits and terminates remaining
//! members of the job.
//!
//! See <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>.

use std::io;

/// Establish process-tree containment before launching any provider process.
///
/// Non-Windows platforms currently have no equivalent lifetime guarantee. Their
/// normal timeout and shutdown cleanup still applies while the bridge is alive.
#[cfg(not(windows))]
pub fn ensure_contained() -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, mem, ptr, sync::OnceLock};

    type Bool = i32;
    type Dword = u32;
    type Handle = *mut c_void;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
    const HANDLE_FLAG_INHERIT: Dword = 0x0000_0001;

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: Dword,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: Dword,
        affinity: usize,
        priority_class: Dword,
        scheduling_class: Dword,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            information_class: i32,
            information: *const c_void,
            information_length: Dword,
        ) -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn GetCurrentProcess() -> Handle;
        fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
    }

    #[derive(Clone)]
    struct StoredError {
        kind: io::ErrorKind,
        message: String,
    }

    impl StoredError {
        fn capture(context: &str) -> Self {
            let source = io::Error::last_os_error();
            Self {
                kind: source.kind(),
                message: format!("{context}: {source}"),
            }
        }

        fn to_io(&self) -> io::Error {
            io::Error::new(self.kind, self.message.clone())
        }
    }

    // The value is the retained HANDLE represented as an integer so the static
    // is Send + Sync. It is intentionally never closed while the process lives:
    // closing the last handle would terminate the bridge after it joins the job.
    static JOB: OnceLock<Result<usize, StoredError>> = OnceLock::new();

    fn initialize() -> Result<usize, StoredError> {
        // SAFETY: null security attributes and name request an unnamed job with
        // a non-inheritable handle. All returned handles are checked before use.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(StoredError::capture("could not create provider Job Object"));
        }

        let mut limits = JobObjectExtendedLimitInformation::default();
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let information_length = match Dword::try_from(mem::size_of_val(&limits)) {
            Ok(length) => length,
            Err(_) => {
                // SAFETY: the handle is valid and the bridge has not joined it.
                unsafe { CloseHandle(job) };
                return Err(StoredError {
                    kind: io::ErrorKind::InvalidData,
                    message: "Job Object limit structure exceeds DWORD size".into(),
                });
            }
        };

        // Explicitly clear inheritance even though CreateJobObjectW with null
        // security attributes already returns a non-inheritable handle.
        // SAFETY: job is a valid handle and flags follow SetHandleInformation.
        if unsafe { SetHandleInformation(job, HANDLE_FLAG_INHERIT, 0) } == 0 {
            let error = StoredError::capture("could not make provider Job Object private");
            // SAFETY: the bridge has not joined the job, so closing is harmless.
            unsafe { CloseHandle(job) };
            return Err(error);
        }

        // SAFETY: both the structure pointer and byte size are valid for the
        // JobObjectExtendedLimitInformation information class.
        if unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&raw const limits).cast(),
                information_length,
            )
        } == 0
        {
            let error = StoredError::capture("could not configure provider Job Object");
            // SAFETY: the bridge has not joined the job, so closing is harmless.
            unsafe { CloseHandle(job) };
            return Err(error);
        }

        // Assign the bridge itself before any provider is spawned. Windows then
        // places descendants in the same job as part of process creation.
        // SAFETY: both handles are valid process/job handles for this operation.
        if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
            let error = StoredError::capture("could not contain provider process tree");
            // SAFETY: assignment failed, so closing cannot terminate the bridge.
            unsafe { CloseHandle(job) };
            return Err(error);
        }

        Ok(job as usize)
    }

    pub fn ensure_contained() -> io::Result<()> {
        match JOB.get_or_init(initialize) {
            Ok(handle) => {
                debug_assert_ne!(*handle, 0);
                Ok(())
            }
            Err(error) => Err(error.to_io()),
        }
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = {
        assert!(mem::size_of::<JobObjectBasicLimitInformation>() == 64);
        assert!(mem::size_of::<IoCounters>() == 48);
        assert!(mem::size_of::<JobObjectExtendedLimitInformation>() == 144);
    };
}

#[cfg(windows)]
pub use windows::ensure_contained;

#[cfg(test)]
mod tests {
    #[test]
    fn containment_initialization_is_idempotent() {
        super::ensure_contained().unwrap();
        super::ensure_contained().unwrap();
    }
}
