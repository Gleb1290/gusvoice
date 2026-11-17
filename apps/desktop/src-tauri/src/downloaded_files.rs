use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Mutex;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
    VOLUME_NAME_DOS,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDOK, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL, SW_SHOWNORMAL,
};

#[derive(PartialEq)]
struct FileIdentity {
    canonical_path: PathBuf,
    volume: u32,
    index: (u32, u32),
    created: (u32, u32),
}

struct SavedDownload {
    path: PathBuf,
    source: String,
    identity: FileIdentity,
}

static DOWNLOADS: Mutex<Vec<SavedDownload>> = Mutex::new(Vec::new());
static RESERVED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(super) struct Reservation {
    pub path: PathBuf,
    key: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut reserved) = RESERVED.lock() {
            reserved.retain(|key| *key != self.key);
        }
    }
}

/// WebView2 may start two downloads before either destination exists on disk.
pub(super) fn reserve(
    dir: &Path,
    candidates: impl Iterator<Item = PathBuf>,
) -> Option<Reservation> {
    let canonical_dir = dir.canonicalize().ok()?;
    let mut reserved = RESERVED.lock().ok()?;
    for path in candidates {
        let key = canonical_dir
            .join(path.file_name()?)
            .to_string_lossy()
            .to_lowercase();
        if reserved.contains(&key) {
            continue;
        }
        match std::fs::symlink_metadata(&path) {
            Ok(_) => continue,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        reserved.push(key.clone());
        return Some(Reservation { path, key });
    }
    None
}

fn disk_path(path: &Path) -> bool {
    path.is_absolute()
        && matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(..) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..))
        )
        && path.components().all(|part| match part {
            Component::Normal(name) => !name.encode_wide().any(|c| c == 0 || c == b':' as u16),
            Component::ParentDir => false,
            _ => true,
        })
}

fn path_from_handle(handle: HANDLE) -> Option<PathBuf> {
    let mut wide = vec![0u16; 512];
    let mut len = unsafe { GetFinalPathNameByHandleW(handle, &mut wide, VOLUME_NAME_DOS) } as usize;
    if len >= wide.len() {
        wide.resize(len, 0);
        len = unsafe { GetFinalPathNameByHandleW(handle, &mut wide, VOLUME_NAME_DOS) } as usize;
    }
    if len == 0 || len >= wide.len() {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&wide[..len])))
}

/// Allow WebView2 to finish closing its handle at completion. Only the shell call pins the file
/// against deletion. A moved, replaced or redirected download must go through download again.
fn inspect(path: &Path, pin: bool) -> io::Result<Option<(File, FileIdentity)>> {
    if !disk_path(path) {
        return Ok(None);
    }
    let mut share = FILE_SHARE_READ | FILE_SHARE_WRITE;
    if !pin {
        share |= FILE_SHARE_DELETE;
    }
    let file = match OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode(share.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        if GetFileType(handle) != FILE_TYPE_DISK {
            return Ok(None);
        }
        GetFileInformationByHandle(handle, &mut info).map_err(io::Error::other)?;
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT).0 != 0 {
        return Ok(None);
    }
    let canonical_path = path_from_handle(handle).ok_or_else(io::Error::last_os_error)?;
    if !disk_path(&canonical_path) {
        return Ok(None);
    }
    let identity = FileIdentity {
        canonical_path,
        volume: info.dwVolumeSerialNumber,
        index: (info.nFileIndexHigh, info.nFileIndexLow),
        created: (
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
        ),
    };
    Ok(Some((file, identity)))
}

/// Only an exact blob completion can identify a client download. An ordinary URL can be shared
/// by different attachments, and a second download can reuse a path after deletion.
pub(super) fn remember(path: &str, source: &str) {
    let path = PathBuf::from(path);
    let identity = source
        .starts_with("blob:")
        .then(|| inspect(&path, false).ok().flatten())
        .flatten();
    if let Ok(mut downloads) = DOWNLOADS.lock() {
        downloads.retain(|entry| entry.path != path);
        if let Some((_, identity)) = identity {
            downloads.push(SavedDownload {
                path,
                source: source.into(),
                identity,
            });
            if downloads.len() > super::SAVED_FILES_MAX {
                downloads.remove(0);
            }
        }
    }
}

fn registered_file(
    wanted: &Path,
    source: &str,
    pin: bool,
) -> Result<Option<(File, FileIdentity)>, String> {
    let downloads = DOWNLOADS.lock().map_err(|e| e.to_string())?;
    let Some(saved) = downloads
        .iter()
        .find(|entry| entry.path == wanted && entry.source == source)
    else {
        return Ok(None);
    };
    Ok(inspect(&saved.path, pin)
        .map_err(|e| e.to_string())?
        .filter(|(_, identity)| *identity == saved.identity))
}

fn requires_confirmation(path: &Path) -> bool {
    // Allow only familiar passive formats to open immediately. Active documents, shortcuts
    // and unfamiliar extensions all require a fresh native confirmation.
    const PASSIVE: &[&str] = &[
        "txt", "log", "json", "md", "csv", "pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp",
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "tif", "tiff", "heic", "mp3",
        "wav", "flac", "ogg", "opus", "m4a", "aac", "mp4", "webm", "mkv", "avi", "mov", "zip",
        "7z", "rar", "tar", "gz", "bz2", "xz", "zst",
    ];
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return true;
    };
    !PASSIVE
        .iter()
        .any(|passive| ext.eq_ignore_ascii_case(passive))
}

fn confirm_download(hwnd: HWND, name: &str) -> bool {
    let message =
        format!("Открыть «{name}»? Файл может содержать исполняемый код или активное содержимое.");
    let wide: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            Some(hwnd),
            PCWSTR(wide.as_ptr()),
            w!("Открыть скачанный файл?"),
            MB_OKCANCEL | MB_DEFBUTTON2 | MB_ICONWARNING,
        ) == IDOK
    }
}

fn launch_download(hwnd: HWND, identity: &FileIdentity) -> Result<(), String> {
    let resolved = identity
        .canonical_path
        .to_str()
        .ok_or("недопустимый путь")?;
    // Use the resolved path. ShellExecute expects ordinary DOS or UNC paths.
    let shell_path = if let Some(unc) = resolved.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        resolved
            .strip_prefix(r"\\?\")
            .unwrap_or(resolved)
            .to_owned()
    };
    // Removing the verbatim prefix must still name the same file under Win32 path rules.
    let Some((_shell_handle, shell_identity)) =
        inspect(Path::new(&shell_path), true).map_err(|e| e.to_string())?
    else {
        return Err("недопустимый путь".into());
    };
    if shell_identity != *identity {
        return Err("недопустимый путь".into());
    }
    let wide: Vec<u16> = shell_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = ShellExecuteW(
            Some(hwnd),
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        CoUninitialize();
        result
    };
    if (result.0 as isize) <= 32 {
        return Err(format!("ShellExecuteW failed ({})", result.0 as isize));
    }
    Ok(())
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DownloadOpen {
    Missing,
    Cancelled,
    Opened,
}

fn open_saved_download(
    wanted: &Path,
    source: &str,
    confirm: impl FnOnce(&str) -> bool,
    launch: impl FnOnce(&FileIdentity) -> Result<(), String>,
) -> Result<DownloadOpen, String> {
    let Some((handle, identity)) = registered_file(wanted, source, false)? else {
        return Ok(DownloadOpen::Missing);
    };
    drop(handle);
    if requires_confirmation(&identity.canonical_path) {
        let name = identity
            .canonical_path
            .file_name()
            .ok_or("файл без имени")?;
        if !confirm(&name.to_string_lossy()) {
            return Ok(DownloadOpen::Cancelled);
        }
    }
    // The dialog holds neither the registry lock nor a file handle. A different file may have
    // arrived at the same path while it was open, even with the same source.
    let Some((_pin, current)) = registered_file(wanted, source, true)? else {
        return Ok(DownloadOpen::Missing);
    };
    if current != identity {
        return Ok(DownloadOpen::Missing);
    }
    launch(&current)?;
    Ok(DownloadOpen::Opened)
}

#[tauri::command]
pub(super) async fn gv_downloaded_file(
    window: tauri::WebviewWindow,
    path: String,
    source: String,
) -> Result<DownloadOpen, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        open_saved_download(
            Path::new(&path),
            &source,
            |name| confirm_download(hwnd, name),
            |identity| launch_download(hwnd, identity),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(format!("gusvoice-download-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn completed_copy_requires_its_source_and_original_file() {
        let dir = TestDir::new("saved");
        let path = dir.0.join("отчёт (1).txt");
        std::fs::write(&path, b"original").unwrap();
        let path_str = path.to_str().unwrap();
        let lookup = |source: &str| {
            registered_file(&path, source, false)
                .unwrap()
                .map(|(_, identity)| {
                    identity
                        .canonical_path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
        };
        assert_eq!(lookup("blob:first"), None);
        let download_handle = OpenOptions::new()
            .access_mode(windows::Win32::Storage::FileSystem::DELETE.0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
            .open(&path)
            .unwrap();
        remember(path_str, "blob:first");
        assert_eq!(lookup("blob:first").as_deref(), Some("отчёт (1).txt"));
        drop(download_handle);
        assert_eq!(lookup("blob:second"), None);
        std::fs::rename(&path, dir.0.join("moved.txt")).unwrap();
        assert_eq!(lookup("blob:first"), None);
        std::fs::write(&path, b"replacement").unwrap();
        assert_eq!(lookup("blob:first"), None);
        remember(path_str, "blob:second");
        assert_eq!(lookup("blob:second").as_deref(), Some("отчёт (1).txt"));
        assert_eq!(lookup("blob:first"), None);
    }

    #[test]
    fn active_and_unknown_types_require_confirmation_and_cancel_without_launching() {
        for name in [
            "file.CMD",
            "file.exe",
            "file.html",
            "file.svg",
            "file.docm",
            "file.xls",
            "file.lnk",
            "file.newtype",
            "file",
        ] {
            assert!(requires_confirmation(Path::new(name)), "{name}");
        }
        for name in [
            "file (1).TXT",
            "file.png",
            "file.mp4",
            "file.zip",
            "file.pdf",
            "file.docx",
            "file.csv",
        ] {
            assert!(!requires_confirmation(Path::new(name)), "{name}");
        }

        let dir = TestDir::new("cancel");
        let path = dir.0.join("file (1).CMD");
        std::fs::write(&path, b"test fixture").unwrap();
        remember(path.to_str().unwrap(), "blob:cancel");
        let result = open_saved_download(
            &path,
            "blob:cancel",
            |name| {
                assert_eq!(name, "file (1).CMD");
                std::fs::rename(&path, dir.0.join("moved.txt")).unwrap();
                false
            },
            |_| panic!("отменённое открытие не вызывает ShellExecute"),
        );
        assert_eq!(result.unwrap(), DownloadOpen::Cancelled);
    }

    #[test]
    fn simultaneous_downloads_reserve_distinct_destinations() {
        let dir = TestDir::new("reserved");
        let first = dir.0.join("file.txt");
        let second = dir.0.join("file (1).txt");
        let candidates = || [first.clone(), second.clone()].into_iter();
        let a = reserve(&dir.0, candidates()).unwrap();
        let b = reserve(&dir.0, candidates()).unwrap();
        assert_eq!(a.path, first);
        assert_eq!(b.path, second);
        assert!(reserve(&dir.0, candidates()).is_none());
        drop(a);
        assert_eq!(reserve(&dir.0, candidates()).unwrap().path, first);
    }
}
