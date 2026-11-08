//! Pure pixel-strip decoder. Input is a top-down RGB screenshot supplied by a
//! future platform capture backend; no OS capture or image-file dependencies.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidImage,
    InvalidLayout,
    OutOfBounds,
    Length,
    Checksum,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pixel frame: {self:?}")
    }
}
impl std::error::Error for Error {}

pub struct RgbImage<'a> {
    bytes: &'a [u8],
    width: usize,
    height: usize,
    stride: usize,
}
impl<'a> RgbImage<'a> {
    /// Rows may contain padding. Buffer must contain all full rows.
    pub fn new(bytes: &'a [u8], width: usize, height: usize, stride: usize) -> Result<Self, Error> {
        let row = width.checked_mul(3).ok_or(Error::InvalidImage)?;
        let size = stride.checked_mul(height).ok_or(Error::InvalidImage)?;
        if width == 0 || height == 0 || stride < row || bytes.len() < size {
            return Err(Error::InvalidImage);
        }
        Ok(Self {
            bytes,
            width,
            height,
            stride,
        })
    }
}

#[derive(Clone, Copy)]
pub struct Layout {
    pub cell_px: usize,
    pub columns: usize,
    pub rows: usize,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            cell_px: 4,
            columns: 200,
            rows: 48,
        }
    }
}
impl Layout {
    fn dimensions(self) -> Result<(usize, usize, usize), Error> {
        if self.cell_px == 0 || self.columns == 0 || self.rows == 0 {
            return Err(Error::InvalidLayout);
        }
        let w = self
            .cell_px
            .checked_mul(self.columns)
            .ok_or(Error::InvalidLayout)?;
        let h = self
            .cell_px
            .checked_mul(self.rows)
            .ok_or(Error::InvalidLayout)?;
        let count = self
            .columns
            .checked_mul(self.rows)
            .ok_or(Error::InvalidLayout)?;
        let capacity = count.checked_mul(3).ok_or(Error::InvalidLayout)? / 8;
        if capacity < 8 {
            return Err(Error::InvalidLayout);
        }
        Ok((w, h, count))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub id: u16,
    /// UTF-8 replacement decoding matches the legacy capture implementation.
    pub text: String,
}

/// None means no magic header; malformed strips return an explicit error.
/// Checksum covers the ID, payload length and payload, excluding the magic.
pub fn decode_at(
    image: &RgbImage<'_>,
    layout: Layout,
    origin: (usize, usize),
) -> Result<Option<Frame>, Error> {
    let (width, height, count) = layout.dimensions()?;
    let (ox, oy) = origin;
    if ox.checked_add(width).is_none_or(|x| x > image.width)
        || oy.checked_add(height).is_none_or(|y| y > image.height)
    {
        return Err(Error::OutOfBounds);
    }
    let mut bytes = Vec::new();
    let (mut acc, mut bits, mut needed) = (0_u16, 0_usize, 6_usize);
    for i in 0..count {
        let x = ox + i % layout.columns * layout.cell_px + layout.cell_px / 2;
        let y = oy + i / layout.columns * layout.cell_px + layout.cell_px / 2;
        let offset = y * image.stride + x * 3;
        let rgb = &image.bytes[offset..offset + 3];
        let cell = (u16::from(rgb[0] >= 128) << 2)
            | (u16::from(rgb[1] >= 128) << 1)
            | u16::from(rgb[2] >= 128);
        acc = (acc << 3) | cell;
        bits += 3;
        if bits >= 8 {
            bytes.push((acc >> (bits - 8)) as u8);
            bits -= 8;
            acc &= (1 << bits) - 1;
            if bytes.len() == 2 && bytes[..2] != [0xc7, 0x1a] {
                return Ok(None);
            }
            if bytes.len() == 6 {
                needed = 8 + usize::from(u16::from_be_bytes([bytes[4], bytes[5]]));
                if needed > count * 3 / 8 {
                    return Err(Error::Length);
                }
            }
            if bytes.len() == needed {
                break;
            }
        }
    }
    if bytes.len() < needed {
        return Err(Error::Length);
    }
    let (mut s1, mut s2) = (0_u16, 0_u16);
    for &b in &bytes[2..needed - 2] {
        s1 = (s1 + u16::from(b)) % 255;
        s2 = (s2 + s1) % 255;
    }
    if bytes[needed - 2..] != [s1 as u8, s2 as u8] {
        return Err(Error::Checksum);
    }
    Ok(Some(Frame {
        id: u16::from_be_bytes([bytes[2], bytes[3]]),
        text: String::from_utf8_lossy(&bytes[6..needed - 2]).into_owned(),
    }))
}

#[derive(Debug, PartialEq, Eq)]
pub struct LocatedFrame {
    pub frame: Frame,
    pub origin: (usize, usize),
}

/// Search the same 0..8 pixel window as the legacy X11 decoder, trying the last
/// successful origin first. Returns the first magic-bearing frame or its error.
pub fn find(
    image: &RgbImage<'_>,
    layout: Layout,
    hint: Option<(usize, usize)>,
) -> Result<Option<LocatedFrame>, Error> {
    layout.dimensions()?;
    let candidates = hint
        .into_iter()
        .chain((0..=8).flat_map(|y| (0..=8).map(move |x| (x, y))));
    for origin in candidates {
        match decode_at(image, layout, origin) {
            Ok(Some(frame)) => return Ok(Some(LocatedFrame { frame, origin })),
            Ok(None) | Err(Error::OutOfBounds) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}
