//! Screen capture module for WoW AI pixel strip decoding.
//! On Windows, captures the WoW client window directly via GDI BitBlt.
//! On other platforms, provides mock and test capture capabilities.

use crate::frame::{self, Frame, Layout, RgbImage};
use std::{fmt, io, path::PathBuf};

#[derive(Debug, Clone)]
pub struct CaptureTarget {
    pub process_name: String,
    pub client_folder: Option<String>,
    /// Exact executable selected by `--wow`, when live capture must be bound to
    /// one installation instead of the legacy name/folder heuristic.
    pub executable_path: Option<PathBuf>,
    pub layout: Layout,
}

impl Default for CaptureTarget {
    fn default() -> Self {
        Self {
            process_name: "Wow.exe".into(),
            client_folder: Some("_forever_".into()),
            executable_path: None,
            layout: Layout::default(),
        }
    }
}

impl CaptureTarget {
    /// Bind capture to one already-resolved executable path. The caller should
    /// canonicalize the path before constructing the target.
    pub fn for_executable(executable_path: PathBuf) -> Self {
        let process_name = executable_path
            .to_string_lossy()
            .rsplit(['\\', '/'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("Wow.exe")
            .to_owned();
        Self {
            process_name,
            client_folder: None,
            executable_path: Some(executable_path),
            layout: Layout::default(),
        }
    }

    /// Match the full path reported by the operating system. Exact Windows
    /// targets tolerate case, separator and extended-path prefix differences.
    pub fn matches_process_path(&self, candidate: &str) -> bool {
        if let Some(expected) = &self.executable_path {
            return normalize_windows_path(candidate)
                == normalize_windows_path(&expected.to_string_lossy());
        }

        let candidate = candidate.replace('/', "\\");
        let mut components = candidate.rsplit('\\');
        let name = components.next().unwrap_or_default();
        let configured_has_extension = self.process_name.to_ascii_lowercase().ends_with(".exe");
        let configured_stem =
            configured_has_extension.then(|| &self.process_name[..self.process_name.len() - 4]);
        let matches_name = name.eq_ignore_ascii_case(&self.process_name)
            || configured_stem.is_some_and(|stem| name.eq_ignore_ascii_case(stem))
            || (!configured_has_extension
                && name.eq_ignore_ascii_case(&format!("{}.exe", self.process_name)));
        if !matches_name {
            return false;
        }

        self.client_folder.as_ref().is_none_or(|required| {
            components
                .next()
                .is_some_and(|folder| folder.eq_ignore_ascii_case(required))
        })
    }
}

fn normalize_windows_path(path: &str) -> String {
    let path = path.replace('/', "\\");
    let path = path
        .strip_prefix("\\\\?\\UNC\\")
        .map(|rest| format!("\\\\{rest}"))
        .or_else(|| path.strip_prefix("\\\\?\\").map(str::to_owned))
        .or_else(|| path.strip_prefix("\\??\\").map(str::to_owned))
        .unwrap_or(path);
    path.trim_end_matches('\\').to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub pid: u32,
    pub title: String,
    pub path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CaptureEvent {
    Attached(WindowInfo),
    Waiting {
        process: String,
        folder: Option<String>,
    },
    Minimized,
    Frame(Frame),
    StripRejected(String),
}

impl fmt::Display for CaptureEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Attached(info) => write!(f, "attached to '{}' (pid {})", info.title, info.pid),
            Self::Waiting { process, folder } => {
                if let Some(folder) = folder {
                    write!(f, "waiting for {process} window in {folder}")
                } else {
                    write!(f, "waiting for {process} window")
                }
            }
            Self::Minimized => write!(f, "game window is minimized"),
            Self::Frame(frame) => write!(
                f,
                "decoded frame #{} ({} bytes)",
                frame.id,
                frame.text.len()
            ),
            Self::StripRejected(err) => write!(f, "strip seen but rejected: {err}"),
        }
    }
}

pub type DecodedFrame = (Frame, (usize, usize));

/// Decodes an RGB pixel buffer using the standard strip layout and 0..=8 origin search.
pub fn decode_rgb(
    rgb_bytes: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    layout: Layout,
    hint: Option<(usize, usize)>,
) -> Result<Option<DecodedFrame>, frame::Error> {
    let img = RgbImage::new(rgb_bytes, width, height, stride)?;
    match frame::find(&img, layout, hint)? {
        Some(located) => Ok(Some((located.frame, located.origin))),
        None => Ok(None),
    }
}

#[cfg(windows)]
pub mod platform {
    use super::*;
    use std::{ffi::c_void, mem, ptr};

    // Preserve Win32 ABI names inside this binding-only module.
    #[allow(non_snake_case, clippy::upper_case_acronyms)]
    mod ffi {
        use std::ffi::c_void;

        pub type HWND = *mut c_void;
        pub type HDC = *mut c_void;
        pub type HBITMAP = *mut c_void;
        pub type HGDIOBJ = *mut c_void;
        pub type HANDLE = *mut c_void;
        pub type BOOL = i32;
        pub type DWORD = u32;

        #[repr(C)]
        #[derive(Default, Clone, Copy)]
        pub struct POINT {
            pub x: i32,
            pub y: i32,
        }

        #[repr(C)]
        pub struct BITMAPINFOHEADER {
            pub biSize: DWORD,
            pub biWidth: i32,
            pub biHeight: i32,
            pub biPlanes: u16,
            pub biBitCount: u16,
            pub biCompression: DWORD,
            pub biSizeImage: DWORD,
            pub biXPelsPerMeter: i32,
            pub biYPelsPerMeter: i32,
            pub biClrUsed: DWORD,
            pub biClrImportant: DWORD,
        }

        #[repr(C)]
        pub struct BITMAPINFO {
            pub bmiHeader: BITMAPINFOHEADER,
            pub bmiColors: [u32; 1],
        }

        pub const BI_RGB: DWORD = 0;
        pub const SRCCOPY: DWORD = 0x00CC0020;
        pub const DIB_RGB_COLORS: u32 = 0;
        pub const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

        #[link(name = "user32")]
        unsafe extern "system" {
            pub fn SetProcessDPIAware() -> BOOL;
            pub fn IsIconic(hWnd: HWND) -> BOOL;
            pub fn IsWindowVisible(hWnd: HWND) -> BOOL;
            pub fn ClientToScreen(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;
            pub fn GetDC(hWnd: HWND) -> HDC;
            pub fn ReleaseDC(hWnd: HWND, hDC: HDC) -> i32;
            pub fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
            pub fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
            pub fn EnumWindows(
                lpEnumFunc: unsafe extern "system" fn(HWND, isize) -> BOOL,
                lParam: isize,
            ) -> BOOL;
        }

        #[link(name = "gdi32")]
        unsafe extern "system" {
            pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
            pub fn CreateDIBSection(
                hdc: HDC,
                pbmi: *const BITMAPINFO,
                usage: u32,
                ppvBits: *mut *mut c_void,
                hSection: HANDLE,
                offset: DWORD,
            ) -> HBITMAP;
            pub fn SelectObject(hdc: HDC, h: HGDIOBJ) -> HGDIOBJ;
            pub fn BitBlt(
                hdc: HDC,
                x: i32,
                y: i32,
                cx: i32,
                cy: i32,
                hdcSrc: HDC,
                x1: i32,
                y1: i32,
                rop: DWORD,
            ) -> BOOL;
            pub fn GdiFlush() -> BOOL;
            pub fn DeleteDC(hdc: HDC) -> BOOL;
            pub fn DeleteObject(ho: HGDIOBJ) -> BOOL;
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            pub fn OpenProcess(
                dwDesiredAccess: DWORD,
                bInheritHandle: BOOL,
                dwProcessId: DWORD,
            ) -> HANDLE;
            pub fn CloseHandle(hObject: HANDLE) -> BOOL;
            pub fn QueryFullProcessImageNameW(
                hProcess: HANDLE,
                dwFlags: DWORD,
                lpExeName: *mut u16,
                lpdwSize: *mut DWORD,
            ) -> BOOL;
        }
    }

    pub fn set_dpi_aware() {
        unsafe {
            ffi::SetProcessDPIAware();
        }
    }

    struct EnumContext<'a> {
        target: &'a CaptureTarget,
        found: Option<WindowInfo>,
    }

    unsafe extern "system" fn enum_window_proc(hwnd: ffi::HWND, lparam: isize) -> ffi::BOOL {
        // SAFETY: EnumWindows invokes this callback synchronously. lparam points
        // to the live EnumContext passed by find_window; all Win32 buffers below
        // are owned here and their lengths are passed to the matching APIs.
        unsafe {
            let ctx = &mut *(lparam as *mut EnumContext<'_>);
            if ffi::IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut pid: ffi::DWORD = 0;
            ffi::GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return 1;
            }
            let hproc = ffi::OpenProcess(ffi::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if hproc.is_null() {
                return 1;
            }
            let mut path_buf = [0u16; 1024];
            let mut size = path_buf.len() as ffi::DWORD;
            let success =
                ffi::QueryFullProcessImageNameW(hproc, 0, path_buf.as_mut_ptr(), &mut size);
            ffi::CloseHandle(hproc);
            if success == 0 || size == 0 {
                return 1;
            }
            let full_path = String::from_utf16_lossy(&path_buf[..size as usize]);
            if !ctx.target.matches_process_path(&full_path) {
                return 1;
            }

            let mut title_buf = [0u16; 512];
            let len = ffi::GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
            let title = if len > 0 {
                String::from_utf16_lossy(&title_buf[..len as usize])
            } else {
                String::new()
            };

            ctx.found = Some(WindowInfo {
                hwnd: hwnd as usize,
                pid,
                title,
                path: full_path,
            });

            0 // Stop enumeration once matched
        }
    }

    pub fn find_window(target: &CaptureTarget) -> Option<WindowInfo> {
        let mut ctx = EnumContext {
            target,
            found: None,
        };
        unsafe {
            ffi::EnumWindows(enum_window_proc, &mut ctx as *mut _ as isize);
        }
        ctx.found
    }

    pub fn is_iconic(hwnd: usize) -> bool {
        unsafe { ffi::IsIconic(hwnd as ffi::HWND) != 0 }
    }

    /// Captures the client area top-left rectangle of the given window.
    /// Returns raw RGB bytes with stride = width * 3.
    pub fn capture_client_rect(
        hwnd: usize,
        width: usize,
        height: usize,
    ) -> io::Result<Option<Vec<u8>>> {
        let dib_width =
            i32::try_from(width).map_err(|_| io::Error::other("capture width out of range"))?;
        let dib_height =
            i32::try_from(height).map_err(|_| io::Error::other("capture height out of range"))?;
        let row_stride = width
            .checked_mul(3)
            .and_then(|n| n.checked_add(3))
            .map(|n| n & !3)
            .ok_or_else(|| io::Error::other("capture stride overflow"))?;
        let total_bytes = row_stride
            .checked_mul(height)
            .filter(|n| *n > 0 && *n <= 16_777_216)
            .ok_or_else(|| io::Error::other("capture buffer outside supported bounds"))?;
        if width == 0 || height == 0 {
            return Err(io::Error::other("capture dimensions must be positive"));
        }
        let hwnd = hwnd as ffi::HWND;
        unsafe {
            if ffi::IsIconic(hwnd) != 0 {
                return Ok(None);
            }

            let mut pt = ffi::POINT { x: 0, y: 0 };
            if ffi::ClientToScreen(hwnd, &mut pt) == 0 {
                return Err(io::Error::other("ClientToScreen failed"));
            }

            let hdc_screen = ffi::GetDC(ptr::null_mut());
            if hdc_screen.is_null() {
                return Err(io::Error::other("GetDC(NULL) failed"));
            }

            let hdc_mem = ffi::CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ffi::ReleaseDC(ptr::null_mut(), hdc_screen);
                return Err(io::Error::other("CreateCompatibleDC failed"));
            }

            let mut bmi: ffi::BITMAPINFO = mem::zeroed();
            bmi.bmiHeader.biSize = mem::size_of::<ffi::BITMAPINFOHEADER>() as ffi::DWORD;
            bmi.bmiHeader.biWidth = dib_width;
            bmi.bmiHeader.biHeight = -dib_height; // Top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 24;
            bmi.bmiHeader.biCompression = ffi::BI_RGB;

            let mut bits: *mut c_void = ptr::null_mut();
            let hbmp = ffi::CreateDIBSection(
                hdc_mem,
                &bmi,
                ffi::DIB_RGB_COLORS,
                &mut bits,
                ptr::null_mut(),
                0,
            );

            if hbmp.is_null() || bits.is_null() {
                ffi::DeleteDC(hdc_mem);
                ffi::ReleaseDC(ptr::null_mut(), hdc_screen);
                return Err(io::Error::other("CreateDIBSection failed"));
            }

            let old_bmp = ffi::SelectObject(hdc_mem, hbmp as ffi::HGDIOBJ);
            if old_bmp.is_null() || old_bmp as isize == -1 {
                ffi::DeleteObject(hbmp as ffi::HGDIOBJ);
                ffi::DeleteDC(hdc_mem);
                ffi::ReleaseDC(ptr::null_mut(), hdc_screen);
                return Err(io::Error::other("SelectObject failed"));
            }

            let copy_ok = ffi::BitBlt(
                hdc_mem,
                0,
                0,
                width as i32,
                height as i32,
                hdc_screen,
                pt.x,
                pt.y,
                ffi::SRCCOPY,
            );

            // CreateDIBSection requires GDI drawing to be flushed before reading
            // the shared bitmap memory through its returned bits pointer.
            let copy_ok = copy_ok != 0 && ffi::GdiFlush() != 0;
            let mut rgb_output = Vec::with_capacity(width * height * 3);

            if copy_ok {
                let dib_slice = std::slice::from_raw_parts(bits as *const u8, total_bytes);
                for y in 0..height {
                    let row_start = y * row_stride;
                    for x in 0..width {
                        let px = row_start + x * 3;
                        // Windows DIB stores BGR; convert to RGB
                        let b = dib_slice[px];
                        let g = dib_slice[px + 1];
                        let r = dib_slice[px + 2];
                        rgb_output.push(r);
                        rgb_output.push(g);
                        rgb_output.push(b);
                    }
                }
            }

            ffi::SelectObject(hdc_mem, old_bmp);
            ffi::DeleteObject(hbmp as ffi::HGDIOBJ);
            ffi::DeleteDC(hdc_mem);
            ffi::ReleaseDC(ptr::null_mut(), hdc_screen);

            if !copy_ok {
                return Err(io::Error::other("BitBlt or GdiFlush screen copy failed"));
            }

            Ok(Some(rgb_output))
        }
    }
}

#[cfg(not(windows))]
pub mod platform {
    use super::*;

    pub fn set_dpi_aware() {}

    pub fn find_window(_target: &CaptureTarget) -> Option<WindowInfo> {
        None
    }

    pub fn is_iconic(_hwnd: usize) -> bool {
        false
    }

    pub fn capture_client_rect(
        _hwnd: usize,
        _width: usize,
        _height: usize,
    ) -> io::Result<Option<Vec<u8>>> {
        Ok(None)
    }
}

pub struct CaptureSession {
    target: CaptureTarget,
    window: Option<WindowInfo>,
    origin_hint: Option<(usize, usize)>,
    last_message_key: Option<String>,
}

impl CaptureSession {
    pub fn new(target: CaptureTarget) -> Self {
        platform::set_dpi_aware();
        Self {
            target,
            window: None,
            origin_hint: None,
            last_message_key: None,
        }
    }

    pub fn target(&self) -> &CaptureTarget {
        &self.target
    }

    pub fn window(&self) -> Option<&WindowInfo> {
        self.window.as_ref()
    }

    /// Perform a single capture poll iteration.
    /// If no window is attached, attempts to find it.
    /// If attached, grabs the screen strip, decodes it, and returns any new Frame.
    pub fn poll(&mut self) -> io::Result<Option<CaptureEvent>> {
        if self.window.is_none() {
            if let Some(info) = platform::find_window(&self.target) {
                let event = CaptureEvent::Attached(info.clone());
                self.window = Some(info);
                return Ok(Some(event));
            }
            return Ok(Some(CaptureEvent::Waiting {
                process: self.target.process_name.clone(),
                folder: self.target.client_folder.clone(),
            }));
        }

        let info = self.window.as_ref().unwrap();
        if platform::is_iconic(info.hwnd) {
            return Ok(Some(CaptureEvent::Minimized));
        }

        let (width, height, _) = self
            .target
            .layout
            .dimensions()
            .map_err(|e| io::Error::other(e.to_string()))?;

        // Capture with 8 px extra width and height to give origin search room
        let capture_w = width + 8;
        let capture_h = height + 8;

        let rgb = match platform::capture_client_rect(info.hwnd, capture_w, capture_h) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(Some(CaptureEvent::Minimized)),
            Err(e) => {
                // Window may have been closed or detached
                self.window = None;
                return Err(e);
            }
        };

        match decode_rgb(
            &rgb,
            capture_w,
            capture_h,
            capture_w * 3,
            self.target.layout,
            self.origin_hint,
        ) {
            Ok(Some((frame, origin))) => {
                self.origin_hint = Some(origin);
                let key = format!("{}:{}", frame.id, frame.text);
                if self.last_message_key.as_ref() != Some(&key) {
                    self.last_message_key = Some(key);
                    Ok(Some(CaptureEvent::Frame(frame)))
                } else {
                    Ok(None) // Already emitted this frame
                }
            }
            Ok(None) => Ok(None),
            Err(e) => Ok(Some(CaptureEvent::StripRejected(e.to_string()))),
        }
    }
}
