//! Exclusive ownership of the Rust backend's private data directory.
//!
//! This guard does not coordinate access to the shared WoW addon tree and does
//! not prevent the legacy Node backend from publishing there. The runtime must
//! enforce that separate boundary before it writes addon files.

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

const LOCK_FILE: &str = ".wow-ai-reforged.lock";

/// Holds the operating-system lock for one canonical Rust data directory.
///
/// The lock file deliberately remains on disk when this value is dropped. Its
/// inode is stable across runtime restarts; dropping the open file releases the
/// OS lock. No PID-based stale-lock detection or lock-file deletion is used.
#[derive(Debug)]
pub struct OwnershipGuard {
    data_dir: PathBuf,
    lock_path: PathBuf,
    _lock: File,
}

impl OwnershipGuard {
    /// Create (if needed), canonicalize, and exclusively lock a Rust data directory.
    pub fn acquire(data_dir: impl AsRef<Path>) -> io::Result<Self> {
        fs::create_dir_all(data_dir.as_ref())?;
        let data_dir = fs::canonicalize(data_dir.as_ref())?;
        if !fs::metadata(&data_dir)?.is_dir() {
            return Err(io::Error::other(format!(
                "Rust data path is not a directory: {}",
                data_dir.display()
            )));
        }

        let lock_path = data_dir.join(LOCK_FILE);
        let lock = open_regular_lock_file(&lock_path)?;
        lock.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "another Rust backend owns data directory {}",
                    data_dir.display()
                ),
            ),
            fs::TryLockError::Error(error) => error,
        })?;

        Ok(Self {
            data_dir,
            lock_path,
            _lock: lock,
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}

fn open_regular_lock_file(path: &Path) -> io::Result<File> {
    // On Windows create_new on an existing directory can return AccessDenied,
    // rather than AlreadyExists. Validate existing entries before opening too.
    match fs::symlink_metadata(path) {
        Ok(_) => reject_non_regular_lock_path(path)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let lock = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            reject_non_regular_lock_path(path)?;
            OpenOptions::new().read(true).write(true).open(path)?
        }
        Err(error) => return Err(error),
    };

    // Check again after opening. This catches replacement with a symlink or
    // another non-regular filesystem entry between the first check and open.
    reject_non_regular_lock_path(path)?;
    if !lock.metadata()?.is_file() {
        return Err(io::Error::other(format!(
            "ownership lock is not a regular file: {}",
            path.display()
        )));
    }
    Ok(lock)
}

fn reject_non_regular_lock_path(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other(format!(
            "refusing symlink ownership lock: {}",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(io::Error::other(format!(
            "ownership lock is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "wow-ai-ownership-{}-{nonce}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_canonical_directory_and_persistent_lock_file() {
        let temp = TestDir::new();
        let nested = temp.0.join("rust-data");
        let canonical;
        let lock_path;
        {
            let guard = OwnershipGuard::acquire(&nested).unwrap();
            canonical = fs::canonicalize(&nested).unwrap();
            lock_path = canonical.join(LOCK_FILE);
            assert_eq!(guard.data_dir(), canonical);
            assert_eq!(guard.lock_path(), lock_path);
            assert!(fs::metadata(&lock_path).unwrap().is_file());
        }
        assert!(lock_path.is_file(), "lock inode remains after release");
    }

    #[test]
    fn rejects_contention_then_allows_reacquire_after_release() {
        let temp = TestDir::new();
        let first = OwnershipGuard::acquire(&temp.0).unwrap();
        let error = OwnershipGuard::acquire(&temp.0).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(first);
        OwnershipGuard::acquire(&temp.0).unwrap();
    }

    #[test]
    fn preserves_existing_data_and_lock_contents() {
        let temp = TestDir::new();
        fs::create_dir_all(&temp.0).unwrap();
        let state = temp.0.join("state.json");
        let lock = temp.0.join(LOCK_FILE);
        fs::write(&state, b"legacy-independent Rust state").unwrap();
        fs::write(&lock, b"persistent marker").unwrap();

        let guard = OwnershipGuard::acquire(&temp.0).unwrap();
        assert_eq!(fs::read(&state).unwrap(), b"legacy-independent Rust state");
        drop(guard);
        assert_eq!(fs::read(&state).unwrap(), b"legacy-independent Rust state");
        assert_eq!(fs::read(&lock).unwrap(), b"persistent marker");
    }

    #[test]
    fn rejects_non_regular_lock_path() {
        let temp = TestDir::new();
        fs::create_dir_all(temp.0.join(LOCK_FILE)).unwrap();
        let error = OwnershipGuard::acquire(&temp.0).unwrap_err();
        assert!(error.to_string().contains("not a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_lock_without_changing_target() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        fs::create_dir_all(&temp.0).unwrap();
        let target = temp.0.join("target");
        fs::write(&target, b"do not touch").unwrap();
        symlink(&target, temp.0.join(LOCK_FILE)).unwrap();

        let error = OwnershipGuard::acquire(&temp.0).unwrap_err();
        assert!(error.to_string().contains("symlink"));
        assert_eq!(fs::read(target).unwrap(), b"do not touch");
    }
}
