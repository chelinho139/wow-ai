//! One-shot WAV signals consumed by the addon. No timers or persisted counters:
//! the future runtime owns scheduling, exclusive access and counter persistence.
use crate::publication::{Report, write_installed_files};
use std::{io, path::PathBuf};

/// Same 10ms, 8-bit mono PCM silence as the legacy backend.
pub fn silent_wav() -> Vec<u8> {
    let mut out = Vec::with_capacity(124);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&116_u32.to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&8000_u32.to_le_bytes());
    out.extend_from_slice(&8000_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&8_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&80_u32.to_le_bytes());
    out.resize(124, 128);
    out
}

#[derive(Clone, Copy)]
pub enum Kind {
    Acknowledgement,
    ReplyReady,
}

pub struct Signals {
    addon: PathBuf,
    slots: u16,
    actions: u16,
    presence: u16,
}

impl Signals {
    /// `addon` is the installed WoWAI folder, not its AddOns parent.
    /// Presence needs >50 entries so clearing the lookahead cannot erase this beat.
    pub fn new(addon: PathBuf, slots: u16, actions: u16, presence: u16) -> io::Result<Self> {
        if !(1..=999).contains(&slots)
            || !(1..=99).contains(&actions)
            || !(51..=9999).contains(&presence)
        {
            return Err(io::Error::other(
                "invalid signal pool sizes (slots 1..999, actions 1..99, presence 51..9999)",
            ));
        }
        Ok(Self {
            addon,
            slots,
            actions,
            presence,
        })
    }
    fn slot(&self, id: u64) -> io::Result<u64> {
        if id == 0 || id > (1_u64 << 53) - 1 {
            return Err(io::Error::other(
                "message id must be a positive safe integer",
            ));
        }
        Ok((id - 1) % u64::from(self.slots) + 1)
    }
    pub fn set(&self, kind: Kind, id: u64, raised: bool) -> io::Result<Report> {
        let dir = match kind {
            Kind::Acknowledgement => "ack",
            Kind::ReplyReady => "sig",
        };
        let path = self
            .addon
            .join(dir)
            .join(format!("{:03}.wav", self.slot(id)?));
        let wav = silent_wav();
        write_installed_files(vec![(path, if raised { &wav } else { &[] })])
    }
    pub fn activity(&self, id: u64, action: u16) -> io::Result<Report> {
        if !(1..=self.actions).contains(&action) {
            return Err(io::Error::other("activity index outside installed pool"));
        }
        let path = self
            .addon
            .join("act")
            .join(format!("{:03}", self.slot(id)?))
            .join(format!("{action:02}.wav"));
        write_installed_files(vec![(path, &silent_wav())])
    }
    pub fn reset_activity(&self, id: u64) -> io::Result<Report> {
        let folder = self
            .addon
            .join("act")
            .join(format!("{:03}", self.slot(id)?));
        write_installed_files(
            (1..=self.actions)
                .map(|n| (folder.join(format!("{n:02}.wav")), &[][..]))
                .collect(),
        )
    }
    /// Returns the next counter plus per-file results. Runtime must inspect failures
    /// and persist the counter in Rust-owned state before claiming a successful beat.
    /// Clearing files does not undo WoW's cached reads; wrap can require a game restart.
    pub fn presence(&self, previous: u16) -> io::Result<(u16, Report)> {
        if previous > self.presence {
            return Err(io::Error::other("presence counter outside pool"));
        }
        let next = previous % self.presence + 1;
        let folder = self.addon.join("presence");
        let wav = silent_wav();
        let mut targets = vec![(folder.join(format!("{next:04}.wav")), wav.as_slice())];
        for offset in 1..=50 {
            let n = (u32::from(next) - 1 + offset) % u32::from(self.presence) + 1;
            targets.push((folder.join(format!("{n:04}.wav")), &[]));
        }
        Ok((next, write_installed_files(targets)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "wow-ai-signals-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn install(&self, name: &str, content: &[u8]) {
            let p = self.0.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
        fn signals(&self) -> Signals {
            Signals::new(self.0.clone(), 200, 2, 60).unwrap()
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn wav_matches_legacy_bytes() {
        assert_eq!(silent_wav(), include_bytes!("../tests/fixtures/silent.wav"));
    }
    #[test]
    fn acknowledgement_and_reply_signals_wrap_and_clear() {
        let tree = Tree::new();
        for (kind, name) in [
            (Kind::Acknowledgement, "ack/001.wav"),
            (Kind::ReplyReady, "sig/001.wav"),
        ] {
            tree.install(name, b"");
            assert!(
                tree.signals()
                    .set(kind, 201, true)
                    .unwrap()
                    .failed
                    .is_empty()
            );
            assert_eq!(fs::read(tree.0.join(name)).unwrap(), silent_wav());
            assert!(
                tree.signals()
                    .set(kind, 1, false)
                    .unwrap()
                    .failed
                    .is_empty()
            );
            assert!(fs::read(tree.0.join(name)).unwrap().is_empty());
        }
    }
    #[test]
    fn activity_raises_and_resets_only_its_message_slot() {
        let tree = Tree::new();
        tree.install("act/001/01.wav", b"");
        tree.install("act/001/02.wav", b"");
        tree.install("act/002/01.wav", b"keep");
        assert!(tree.signals().activity(201, 2).unwrap().failed.is_empty());
        assert_eq!(
            fs::read(tree.0.join("act/001/02.wav")).unwrap(),
            silent_wav()
        );
        assert_eq!(tree.signals().reset_activity(1).unwrap().written.len(), 2);
        assert!(fs::read(tree.0.join("act/001/02.wav")).unwrap().is_empty());
        assert_eq!(fs::read(tree.0.join("act/002/01.wav")).unwrap(), b"keep");
        assert!(tree.signals().activity(1, 3).is_err());
    }
    #[test]
    fn presence_wraps_and_clears_exactly_fifty_future_files() {
        let tree = Tree::new();
        for n in 1..=60 {
            tree.install(&format!("presence/{n:04}.wav"), b"old");
        }
        let (next, report) = tree.signals().presence(59).unwrap();
        assert_eq!(next, 60);
        assert_eq!(report.written.len(), 51);
        assert!(report.failed.is_empty());
        assert_eq!(
            fs::read(tree.0.join("presence/0060.wav")).unwrap(),
            silent_wav()
        );
        assert!(
            fs::read(tree.0.join("presence/0050.wav"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read(tree.0.join("presence/0051.wav")).unwrap(), b"old");
        assert_eq!(tree.signals().presence(60).unwrap().0, 1);
    }
    #[test]
    fn invalid_inputs_and_missing_files_fail_without_installing() {
        let tree = Tree::new();
        assert!(Signals::new(tree.0.clone(), 200, 60, 50).is_err());
        assert!(tree.signals().set(Kind::Acknowledgement, 0, true).is_err());
        assert!(tree.signals().set(Kind::ReplyReady, 1, true).is_err());
        assert!(tree.signals().presence(61).is_err());
        tree.install("presence/0001.wav", b"keep");
        assert!(tree.signals().presence(0).is_err());
        assert_eq!(fs::read(tree.0.join("presence/0001.wav")).unwrap(), b"keep");
    }
    #[cfg(windows)]
    #[test]
    fn locked_signal_reports_failure_without_destroying_previous_content() {
        use std::os::windows::fs::OpenOptionsExt;
        let tree = Tree::new();
        tree.install("ack/001.wav", b"keep");
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(tree.0.join("ack/001.wav"))
            .unwrap();
        let report = tree.signals().set(Kind::Acknowledgement, 1, true).unwrap();
        assert!(report.written.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert_eq!(fs::read_dir(tree.0.join("ack")).unwrap().count(), 1);
        drop(_lock);
        assert_eq!(fs::read(tree.0.join("ack/001.wav")).unwrap(), b"keep");
    }
}
