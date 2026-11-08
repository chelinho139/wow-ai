//! Publication to an explicitly installed addon tree. Caller must own the tree
//! exclusively; cross-backend ownership enforcement belongs to the future runtime.
use crate::slots::{Snapshot, Target, serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Replace one file using a uniquely created sibling and rename. Existing content
/// remains intact if writing or replacement fails. This is not a multi-file transaction.
fn atomic_write(path: &Path, body: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    let temp = parent.join(format!(
        ".wow-ai-reforged-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = (|| {
        file.write_all(body)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[derive(Debug, Default)]
pub struct Report {
    pub written: Vec<PathBuf>,
    pub failed: Vec<(PathBuf, io::Error)>,
}

/// Require all destinations to be installed before writing. Return per-file
/// results so a partial publish cannot be mistaken for a completed broadcast.
/// Does not create slot addons: WoW must discover those before client startup.
pub fn publish(addon_dir: &Path, slots: u16, snapshot: &Snapshot) -> io::Result<Report> {
    if !(1..=999).contains(&slots) {
        return Err(io::Error::other("slot count must be 1..=999"));
    }
    let inbox = serialize(Target::Inbox, snapshot).map_err(io::Error::other)?;
    let body = serialize(Target::Slot, snapshot).map_err(io::Error::other)?;
    let mut targets = vec![(addon_dir.join("WoWAI/Inbox.lua"), inbox.as_bytes())];
    for n in 1..=slots {
        targets.push((
            addon_dir.join(format!("WoWAI_S{n:03}/Inbox.lua")),
            body.as_bytes(),
        ));
    }
    write_installed_files(targets)
}

pub(crate) fn write_installed_files(targets: Vec<(PathBuf, &[u8])>) -> io::Result<Report> {
    for (path, _) in &targets {
        if !fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(io::Error::other(format!(
                "not an installed regular file: {}",
                path.display()
            )));
        }
    }
    let mut report = Report::default();
    for (path, data) in targets {
        match atomic_write(&path, data) {
            Ok(()) => report.written.push(path),
            Err(error) => report.failed.push((path, error)),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wow-ai-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            timestamp: "2023-11-14T22:13:20.000Z".into(),
            now_seconds: 1700000000,
            cwd: String::new(),
            agent: "codex".into(),
            agents: vec!["codex".into()],
            replies: vec![],
        }
    }
    #[test]
    fn publishes_all_installed_files_and_replaces_existing_content() {
        let tree = Tree::new();
        for dir in ["WoWAI", "WoWAI_S001", "WoWAI_S002"] {
            fs::create_dir(tree.0.join(dir)).unwrap();
            fs::write(tree.0.join(dir).join("Inbox.lua"), "old").unwrap();
        }
        for _ in 0..2 {
            let report = publish(&tree.0, 2, &snapshot()).unwrap();
            assert_eq!(report.written.len(), 3);
            assert!(report.failed.is_empty());
            assert!(
                fs::read_to_string(tree.0.join("WoWAI/Inbox.lua"))
                    .unwrap()
                    .contains("WoWAI_Inbox =")
            );
            for dir in ["WoWAI_S001", "WoWAI_S002"] {
                let path = tree.0.join(dir);
                assert!(
                    fs::read_to_string(path.join("Inbox.lua"))
                        .unwrap()
                        .contains("WoWAI_SlotData =")
                );
                assert_eq!(fs::read_dir(path).unwrap().count(), 1);
            }
        }
    }
    #[test]
    fn missing_slot_fails_before_modifying_inbox() {
        let tree = Tree::new();
        fs::create_dir(tree.0.join("WoWAI")).unwrap();
        let inbox = tree.0.join("WoWAI/Inbox.lua");
        fs::write(&inbox, "old").unwrap();
        assert!(publish(&tree.0, 1, &snapshot()).is_err());
        assert_eq!(fs::read_to_string(inbox).unwrap(), "old");
        assert!(publish(&tree.0, 0, &snapshot()).is_err());
    }
    #[test]
    fn failed_replacement_preserves_destination_and_cleans_temporary_file() {
        let tree = Tree::new();
        let dir = tree.0.join("destination");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("keep"), "old").unwrap();
        assert!(atomic_write(&dir, b"new").is_err());
        assert_eq!(fs::read_to_string(dir.join("keep")).unwrap(), "old");
        assert_eq!(fs::read_dir(&tree.0).unwrap().count(), 1);
    }
}
