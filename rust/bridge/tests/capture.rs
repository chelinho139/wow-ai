use wow_ai_reforged::{
    capture::{CaptureEvent, CaptureSession, CaptureTarget, WindowInfo, decode_rgb},
    frame::Layout,
};

fn fixtures() -> Vec<(u16, Vec<u8>, Vec<u8>)> {
    include_str!("fixtures/frames.tsv")
        .lines()
        .map(|line| {
            let p: Vec<_> = line.split('\t').collect();
            let payload = (0..p[1].len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&p[1][i..i + 2], 16).unwrap())
                .collect();
            (
                p[0].parse().unwrap(),
                payload,
                p[2].split(',').map(|c| c.parse().unwrap()).collect(),
            )
        })
        .collect()
}

fn render(cells: &[u8], origin: (usize, usize)) -> (Vec<u8>, usize, usize, usize) {
    let (width, height) = (808, 200);
    let stride = width * 3;
    let mut pixels = vec![0; stride * height];
    for (i, &cell) in cells.iter().enumerate() {
        let x = origin.0 + i % 200 * 4 + 2;
        let y = origin.1 + i / 200 * 4 + 2;
        for channel in 0..3 {
            pixels[y * stride + x * 3 + channel] = if cell & (4 >> channel) != 0 { 255 } else { 0 };
        }
    }
    (pixels, width, height, stride)
}

#[test]
fn decode_rgb_finds_frames_with_offsets() {
    for (id, payload, cells) in fixtures() {
        for origin in [(0, 0), (3, 4), (8, 8)] {
            let (pixels, w, h, stride) = render(&cells, origin);
            let decoded = decode_rgb(&pixels, w, h, stride, Layout::default(), None)
                .unwrap()
                .expect("expected frame to be decoded");
            assert_eq!(decoded.0.id, id);
            assert_eq!(decoded.0.text, String::from_utf8_lossy(&payload));
            assert_eq!(decoded.1, origin);
        }
    }
}

#[test]
fn capture_events_format_correctly() {
    let attached = CaptureEvent::Attached(WindowInfo {
        hwnd: 12345,
        pid: 9999,
        title: "World of Warcraft".into(),
        path: "C:\\Games\\WoW\\_forever_\\Wow.exe".into(),
    });
    assert_eq!(
        attached.to_string(),
        "attached to 'World of Warcraft' (pid 9999)"
    );

    let waiting = CaptureEvent::Waiting {
        process: "Wow.exe".into(),
        folder: Some("_forever_".into()),
    };
    assert_eq!(
        waiting.to_string(),
        "waiting for Wow.exe window in _forever_"
    );

    let minimized = CaptureEvent::Minimized;
    assert_eq!(minimized.to_string(), "game window is minimized");
}

#[test]
fn capture_session_initializes_with_defaults() {
    let session = CaptureSession::new(CaptureTarget::default());
    assert_eq!(session.target().process_name, "Wow.exe");
    assert_eq!(session.target().client_folder, Some("_forever_".into()));
    assert!(session.window().is_none());

    // On macOS/Linux where WoW is not running via Win32, poll returns Waiting
    #[cfg(not(windows))]
    {
        let mut session = session;
        let event = session.poll().unwrap();
        assert_eq!(
            event,
            Some(CaptureEvent::Waiting {
                process: "Wow.exe".into(),
                folder: Some("_forever_".into()),
            })
        );
    }
}

#[cfg(windows)]
#[test]
fn invalid_capture_geometry_is_rejected_before_using_win32_handles() {
    for (width, height) in [
        (0, 1),
        (1, 0),
        (usize::MAX, 1),
        (1, usize::MAX),
        (16384, 16384),
    ] {
        assert!(wow_ai_reforged::capture::platform::capture_client_rect(0, width, height).is_err());
    }
}
