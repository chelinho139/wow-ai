//! Native setup with embedded assets. Runtime files are preserved. Differing
//! static assets require explicit update mode, which backs up old files first.
//! This is not a multi-file transaction. Stop WoW and both bridges before setup.
use crate::{config::read_bounded, ownership::OwnershipGuard, signals::silent_wav};
use serde::Serialize;
use std::{
    borrow::Cow,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const SLOTS: u16 = 200;
pub const ACTIONS: u16 = 60;
pub const PRESENCE: u16 = 2000;

struct Asset {
    path: PathBuf,
    body: Cow<'static, [u8]>,
    mutable: bool,
}
impl Asset {
    fn new(path: impl Into<PathBuf>, body: impl Into<Cow<'static, [u8]>>, mutable: bool) -> Self {
        Self {
            path: path.into(),
            body: body.into(),
            mutable,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub addons_dir: PathBuf,
    pub created: usize,
    pub preserved: usize,
    pub updated: usize,
    pub backup_dir: Option<PathBuf>,
}

fn assets() -> Vec<Asset> {
    let mut list = vec![
        Asset::new(
            "WoWAI/WoWAI.toc",
            &include_bytes!("../../../addon/WoWAI/WoWAI.toc")[..],
            false,
        ),
        Asset::new(
            "WoWAI/WoWAI.lua",
            &include_bytes!("../../../addon/WoWAI/WoWAI.lua")[..],
            false,
        ),
        Asset::new(
            "WoWAI/Codec.lua",
            &include_bytes!("../../../addon/WoWAI/Codec.lua")[..],
            false,
        ),
        Asset::new(
            "WoWAI/Map.lua",
            &include_bytes!("../../../addon/WoWAI/Map.lua")[..],
            false,
        ),
        Asset::new(
            "WoWAI/Inbox.lua",
            &include_bytes!("../../../addon/WoWAI/Inbox.lua")[..],
            true,
        ),
        Asset::new(
            "WoWAI/AgentPrimer.md",
            &include_bytes!("../../../docs/WOW-ADDON-PRIMER.md")[..],
            false,
        ),
        Asset::new(
            "WoWAI/LICENSE",
            &include_bytes!("../../../LICENSE")[..],
            false,
        ),
        Asset::new("WoWAI/ctl/empty.wav", &b""[..], false),
        Asset::new("WoWAI/ctl/valid.wav", silent_wav(), false),
    ];
    for n in 1..=SLOTS {
        let slot = format!("WoWAI_S{n:03}");
        let toc = format!(
            "## Interface: 16001\n## Title: WoW AI slot {n:03}\n## Notes: Reply slot for WoW AI. Load-on-demand; leave it enabled.\n## LoadOnDemand: 1\n## Dependencies: WoWAI\n\nInbox.lua\n"
        );
        list.push(Asset::new(
            format!("{slot}/{slot}.toc"),
            toc.into_bytes(),
            false,
        ));
        list.push(Asset::new(
            format!("{slot}/Inbox.lua"),
            &b"WoWAI_SlotData = nil\n"[..],
            true,
        ));
        for kind in ["sig", "ack"] {
            list.push(Asset::new(
                format!("WoWAI/{kind}/{n:03}.wav"),
                &b""[..],
                true,
            ));
        }
        for action in 1..=ACTIONS {
            list.push(Asset::new(
                format!("WoWAI/act/{n:03}/{action:02}.wav"),
                &b""[..],
                true,
            ));
        }
    }
    for n in 1..=PRESENCE {
        list.push(Asset::new(
            format!("WoWAI/presence/{n:04}.wav"),
            &b""[..],
            true,
        ));
    }
    list
}

fn validate_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_dir() || meta.file_type().is_symlink() => {
            Err(io::Error::other(format!(
                "expected a regular directory, refusing links or files: {}",
                path.display()
            )))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
fn directories(root: &Path, relative: &Path, create: bool) -> io::Result<()> {
    let mut cursor = root.to_path_buf();
    validate_directory(&cursor)?;
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(io::Error::other("invalid embedded asset path"));
        }
        cursor.push(component);
        validate_directory(&cursor)?;
        if create {
            match fs::create_dir(&cursor) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => validate_directory(&cursor)?,
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}
fn check_existing(root: &Path, asset: &Asset, updates: bool) -> io::Result<bool> {
    directories(root, asset.path.parent().unwrap(), false)?;
    let path = root.join(&asset.path);
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if !meta.file_type().is_file() || meta.file_type().is_symlink() {
                return Err(io::Error::other(format!(
                    "expected regular file, refusing links or directories: {}",
                    path.display()
                )));
            }
            if !asset.mutable && read_bounded(&path, 4_194_304)? != asset.body.as_ref() && !updates
            {
                return Err(io::Error::other(format!(
                    "existing addon asset differs: {}. No existing file will be overwritten; review your installed addon version first",
                    path.display()
                )));
            }
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// `client` must be the actual Windows client directory containing Wow.exe,
/// normally `_forever_`, not the launcher installation's parent directory.
pub fn install(client: &Path) -> io::Result<Report> {
    install_inner(client, false)
}
/// Explicitly update differing static assets, backing up each old file first.
/// Runtime files and unknown addons are never overwritten.
pub fn update(client: &Path) -> io::Result<Report> {
    install_inner(client, true)
}
fn install_inner(client: &Path, updates: bool) -> io::Result<Report> {
    let client = match client.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            return Err(io::Error::new(
                e.kind(),
                format!(
                    "--wow must name the client directory containing Wow.exe (normally _forever_): {e}"
                ),
            ));
        }
    };
    if !client.is_dir() || !client.join("Wow.exe").is_file() {
        return Err(io::Error::other(
            "--wow must name the client directory containing Wow.exe (normally _forever_)",
        ));
    }
    directories(&client, Path::new("Interface/AddOns"), false)?;
    let addons = client.join("Interface/AddOns");
    let assets = assets();
    // Check the entire existing tree before creating even the ownership lock.
    for asset in &assets {
        check_existing(&addons, asset, updates)?;
    }
    directories(&client, Path::new("Interface/AddOns"), true)?;
    // This only serializes Rust setup processes, not the legacy Node installer.
    let guard = OwnershipGuard::acquire(&addons)?;
    let addons = guard.data_dir();
    for asset in &assets {
        check_existing(addons, asset, updates)?;
    }
    let mut report = Report {
        addons_dir: addons.into(),
        created: 0,
        preserved: 0,
        updated: 0,
        backup_dir: None,
    };
    for asset in &assets {
        if check_existing(addons, asset, updates)? {
            let path = addons.join(&asset.path);
            if updates && !asset.mutable && read_bounded(&path, 4_194_304)? != asset.body.as_ref() {
                if report.backup_dir.is_none() {
                    use std::time::{SystemTime, UNIX_EPOCH};
                    directories(&client, Path::new("Interface/WoWAI-Reforged-Backups"), true)?;
                    let unique = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(io::Error::other)?
                        .as_nanos();
                    let backup = client
                        .join("Interface/WoWAI-Reforged-Backups")
                        .join(format!("{}-{unique}", std::process::id()));
                    fs::create_dir(&backup)?;
                    report.backup_dir = Some(backup);
                }
                let backup = report.backup_dir.as_ref().unwrap();
                directories(backup, asset.path.parent().unwrap(), true)?;
                let old = read_bounded(&path, 4_194_304)?;
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(backup.join(&asset.path))?;
                file.write_all(&old)?;
                file.sync_all()?;
                drop(file);
                crate::publication::atomic_write(&path, &asset.body)?;
                report.updated += 1;
            } else {
                report.preserved += 1;
            }
            continue;
        }
        directories(addons, asset.path.parent().unwrap(), true)?;
        let path = addons.join(&asset.path);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                check_existing(addons, asset, updates)?;
                report.preserved += 1;
                continue;
            }
            Err(e) => {
                return Err(io::Error::new(
                    e.kind(),
                    format!("setup could not create {}: {e}", path.display()),
                ));
            }
        };
        let result = file.write_all(&asset.body).and_then(|()| file.flush());
        drop(file);
        if let Err(e) = result {
            let _ = fs::remove_file(&path);
            return Err(io::Error::new(
                e.kind(),
                format!(
                    "setup could not finish {}: {e}; completed files were retained, rerun setup to continue",
                    path.display()
                ),
            ));
        }
        report.created += 1;
    }
    Ok(report)
}

/// Creates a starter `config.json` if the target path does not already exist.
/// Returns `Ok(true)` if created, `Ok(false)` if it already existed.
pub fn init_starter_config(config_path: &Path, addons_dir: &Path) -> io::Result<bool> {
    if config_path.exists() {
        return Ok(false);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut agents = serde_json::Map::new();
    let context = crate::discovery::Environment::current();
    for kind in crate::discovery::AGENTS {
        let mut value = serde_json::json!({"permission_mode":"default"});
        if let Ok(found) = crate::discovery::resolve(
            kind,
            &crate::agents::AgentSettings::default(),
            &cwd,
            &context,
        ) {
            value["executable"] = serde_json::json!(found.executable);
            if !found.launcher_args.is_empty() {
                value["launcher_args"] = serde_json::json!(found.launcher_args);
            }
        }
        agents.insert(kind.id().into(), value);
    }
    let template = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version":1,"project_dir":cwd.to_string_lossy().replace('\\',"/"),
        "data_dir":"./reforged-data","addon_dir":addons_dir.to_string_lossy().replace('\\',"/"),
        "agent":"codex","timeout_ms":1800000,"max_output_bytes":1048576,"agents":agents
    }))
    .map_err(io::Error::other)?;

    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(config_path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    file.write_all(&template)?;
    file.sync_all()?;
    Ok(true)
}
