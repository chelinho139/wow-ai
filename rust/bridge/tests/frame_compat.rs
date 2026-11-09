use wow_ai_reforged::frame::{self, Error, Layout, RgbImage};

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

// Top-down, padded RGB buffer. Only centers carry data, which also verifies
// the sampling coordinates rather than merely accepting any point in a cell.
fn render(cells: &[u8], origin: (usize, usize), on: u8, off: u8) -> (Vec<u8>, usize, usize, usize) {
    let (width, height) = (808, 200);
    let stride = width * 3 + 5;
    let mut pixels = vec![33; stride * height];
    for (i, &cell) in cells.iter().enumerate() {
        let x = origin.0 + i % 200 * 4 + 2;
        let y = origin.1 + i / 200 * 4 + 2;
        for channel in 0..3 {
            pixels[y * stride + x * 3 + channel] =
                if cell & (4 >> channel) != 0 { on } else { off };
        }
    }
    (pixels, width, height, stride)
}

#[test]
fn real_lua_encoded_frames_survive_threshold_noise_offsets_and_row_padding() {
    for (id, payload, cells) in fixtures() {
        for (on, off) in [(255, 0), (135, 120), (128, 127)] {
            let (pixels, w, h, stride) = render(&cells, (5, 7), on, off);
            let image = RgbImage::new(&pixels, w, h, stride).unwrap();
            let located = frame::find(&image, Layout::default(), None)
                .unwrap()
                .unwrap();
            assert_eq!(located.origin, (5, 7));
            assert_eq!(located.frame.id, id);
            assert_eq!(located.frame.text, String::from_utf8_lossy(&payload));
            let hinted = frame::find(&image, Layout::default(), Some((5, 7)))
                .unwrap()
                .unwrap();
            assert_eq!(hinted, located);
        }
    }
}

#[test]
fn corrupted_checksum_length_and_missing_magic_are_distinct() {
    let (_, _, original) = fixtures().remove(0);
    for (kind, expected) in [
        (0, Ok(None)),
        (1, Err(Error::Checksum)),
        (2, Err(Error::Length)),
    ] {
        let mut cells = original.clone();
        match kind {
            0 => cells[0] ^= 4,
            1 => *cells.last_mut().unwrap() ^= 4,
            _ => cells[11..16].fill(7),
        }
        let (pixels, w, h, stride) = render(&cells, (0, 0), 255, 0);
        let image = RgbImage::new(&pixels, w, h, stride).unwrap();
        assert_eq!(
            frame::decode_at(&image, Layout::default(), (0, 0)),
            expected
        );
    }
}

#[test]
fn invalid_images_layouts_and_origins_are_rejected_without_panics() {
    assert!(RgbImage::new(&[], 0, 0, 0).is_err());
    assert!(RgbImage::new(&[], usize::MAX, 2, usize::MAX).is_err());
    assert!(RgbImage::new(&[0; 12], 2, 2, 5).is_err());
    assert!(RgbImage::new(&[0; 11], 2, 2, 6).is_err());
    let (pixels, w, h, stride) = render(&[], (0, 0), 255, 0);
    let image = RgbImage::new(&pixels, w, h, stride).unwrap();
    for layout in [
        Layout {
            cell_px: 0,
            columns: 200,
            rows: 48,
        },
        Layout {
            cell_px: 4,
            columns: usize::MAX,
            rows: 48,
        },
        Layout {
            cell_px: 1,
            columns: 1,
            rows: 1,
        },
    ] {
        assert_eq!(
            frame::decode_at(&image, layout, (0, 0)),
            Err(Error::InvalidLayout)
        );
    }
    assert_eq!(
        frame::decode_at(&image, Layout::default(), (usize::MAX, 0)),
        Err(Error::OutOfBounds)
    );
    assert_eq!(
        frame::find(&image, Layout::default(), Some((usize::MAX, 0))).unwrap(),
        None
    );
}
