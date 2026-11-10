//! Latest full reply for each retained live chat, isolated from truncated history.
use crate::{config::read_bounded, publication::atomic_write, slots::Reply};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cache {
    target: Option<PathBuf>,
    replies: Vec<Reply>,
}
fn load(data: &Path, target: Option<&Path>) -> io::Result<Cache> {
    let path = data.join("reforged-live-replies.json");
    if let Ok(meta) = fs::symlink_metadata(&path)
        && !meta.file_type().is_file()
    {
        return Err(io::Error::other("live reply cache must be a regular file"));
    }
    let bytes = match read_bounded(&path, 4_194_304) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(Cache {
                target: target.map(Path::to_path_buf),
                replies: vec![],
            });
        }
        Err(e) => return Err(e),
    };
    let cache: Cache = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if cache.target.as_deref() != target {
        return Err(io::Error::other(
            "live replies belong to a different addon target; use a separate data_dir",
        ));
    }
    Ok(cache)
}
fn save(data: &Path, cache: &Cache) -> io::Result<()> {
    let body = serde_json::to_vec(cache).map_err(io::Error::other)?;
    if body.len() > 4_194_304 {
        return Err(io::Error::other("live reply cache exceeds storage budget"));
    }
    atomic_write(&data.join("reforged-live-replies.json"), &body)
}
pub(crate) fn all(data: &Path, target: Option<&Path>) -> io::Result<Vec<Reply>> {
    Ok(load(data, target)?.replies)
}
pub(crate) fn put(data: &Path, target: Option<&Path>, reply: Reply) -> io::Result<Vec<Reply>> {
    let mut cache = load(data, target)?;
    cache.replies.retain(|old| old.chat != reply.chat);
    cache.replies.push(reply);
    // Match the history retention budget. A chat cannot submit its next request
    // until its previous reply is consumed; retain the latest reply per chat.
    if cache.replies.len() > 16 {
        cache.replies.remove(0);
    }
    save(data, &cache)?;
    Ok(cache.replies)
}
pub(crate) fn forget(data: &Path, target: Option<&Path>, chat: &str) -> io::Result<()> {
    let mut cache = load(data, target)?;
    cache.replies.retain(|reply| reply.chat != chat);
    save(data, &cache)
}

/// A new bridge cannot own an agent from its predecessor. Never replay it.
pub(crate) fn interrupt_orphans(
    data: &Path,
    target: Option<&Path>,
    recovering: Option<(&str, u64)>,
) -> io::Result<bool> {
    let mut cache = load(data, target)?;
    let mut changed = false;
    for reply in &mut cache.replies {
        if matches!(reply.status, crate::slots::Status::Working)
            && recovering != Some((reply.chat.as_str(), reply.id))
        {
            reply.status = crate::slots::Status::Error;
            reply.text = "The bridge stopped during this request. Its outcome is unknown; it will not be resent automatically.".into();
            changed = true;
        }
    }
    if changed {
        save(data, &cache)?;
    }
    Ok(changed)
}
