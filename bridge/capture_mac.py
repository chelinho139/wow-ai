#!/usr/bin/env python3
"""macOS counterpart of capture.ps1 / capture_x11.py: screen-captures the
top-left corner of the native WoW: Forever client and decodes the ClaudeWoW pixel
strip (see Codec.lua in the addon). Prints one JSON line per new message to
stdout, with the same {info|warn|error|id,text} contract as the other capture
scripts. Started by bridge.js.

Uses only the Python stdlib plus osascript (window discovery) and, for the pixels,
CoreGraphics called in-process through ctypes: one CGWindowListCreateImage per
frame, no child process and no PNG. When that is unavailable (not macOS, the
symbols missing, Screen Recording not granted, or --backend screencapture) it
falls back to the built-in screencapture binary writing an uncompressed BMP to a
temp file, which is slower but needs no decoding either.

It needs two System Settings permissions for whatever starts it:
Automation/Accessibility (System Events, for window discovery) and Screen
Recording (the capture). macOS does not reliably prompt for them, so a missing
one shows up as a failure here rather than a dialog; --check names which.

  capture_mac.py --test-image strip.png   decode a PNG/BMP once and exit (tests)
  capture_mac.py --probe out.png          save what the capture sees once and exit
  capture_mac.py --check                  report the permissions, backend and display scale
  capture_mac.py --window-name NAME       match a window by title instead of process name
  capture_mac.py --backend screencapture  force the slow path (CLAUDE_WOW_MAC_BACKEND does the same; the old WOWAI_MAC_BACKEND still counts)
"""

import argparse
import ctypes
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zlib

p = argparse.ArgumentParser()
p.add_argument("--cell", type=int, default=4)
p.add_argument("--cells", type=int, default=200)
p.add_argument("--max-rows", type=int, default=48)
p.add_argument("--interval-ms", type=int, default=250)
p.add_argument("--process-name", default="World of Warcraft")
p.add_argument("--window-name", default="")
p.add_argument("--test-image", default="")
p.add_argument("--probe", default="")
p.add_argument("--check", action="store_true",
               help="report whether Screen Recording, window discovery and the display scale "
                    "are usable, then exit (used by setup.js)")
# macOS specific: how many pixels to search down for the strip (title bar + menu bar)
p.add_argument("--y-slack", type=int, default=80, help="vertical search margin in physical pixels")
# Region to capture, in screen points (independent of Retina scale). 0 = exactly
# what the decoder can reach: the strip plus its search margins. Every extra pixel
# is captured, copied and thrown away, so the default is deliberately tight.
p.add_argument("--region-w", type=int, default=0, help="0 = strip width + horizontal slack")
p.add_argument("--region-h", type=int, default=0, help="0 = strip height + --y-slack")
p.add_argument("--backend", choices=("auto", "native", "screencapture"),
               default=os.environ.get("CLAUDE_WOW_MAC_BACKEND", os.environ.get("WOWAI_MAC_BACKEND", "auto")),
               help="native = CoreGraphics in-process (fast); screencapture = the /usr/sbin binary "
                    "per frame (slow); auto = native when it loads, else screencapture")
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * CELL, MAXROWS * CELL
XSLACK = 8
YSLACK = args.y_slack
if args.region_w <= 0:
    args.region_w = W + XSLACK
if args.region_h <= 0:
    args.region_h = H + YSLACK


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Decoder: identical rules to capture.ps1 and capture_x11.py
# ---------------------------------------------------------------------------

def cell_value(px, c, r, ox=0, oy=0):
    rr, gg, bb = px(ox + c * CELL + CELL // 2, oy + r * CELL + CELL // 2)
    return (4 if rr >= 128 else 0) + (2 if gg >= 128 else 0) + (1 if bb >= 128 else 0)


def has_magic(px, ox, oy):
    acc = 0
    for i in range(6):  # 18 bits cover the two magic bytes
        acc = (acc << 3) | cell_value(px, i, 0, ox, oy)
    return (acc >> 2) == 0xC71A


def decode(px, ox=0, oy=0):
    acc = 0
    nbits = 0
    out = bytearray()
    needed = 6
    total = CELLS * MAXROWS
    for i in range(total):
        acc = (acc << 3) | cell_value(px, i % CELLS, i // CELLS, ox, oy)
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != 0xC7 or out[1] != 0x1A):
                return None
            if len(out) == 6:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text}


def find_and_decode(px, width, height, hint):
    """Decode at the last good offset, else search a top-left window for the magic.
    The vertical search window is larger because the macOS title bar pushes the
    UIParent top-left down."""
    cands = [hint] if hint else []
    cands += [(dx, dy) for dy in range(YSLACK + 1) for dx in range(XSLACK + 1)]
    for ox, oy in cands:
        if ox + W > width or oy + H > height:
            continue
        if has_magic(px, ox, oy):
            return decode(px, ox, oy), (ox, oy)
    return None, hint


# ---------------------------------------------------------------------------
# Image in/out. PNG: tests and --probe. BMP: what the screencapture fallback
# writes, chosen because it is raw pixels - the pure-Python PNG unfilter below
# costs ~200 ms a frame, more than the capture itself.
# ---------------------------------------------------------------------------

def read_bmp(path):
    """(px, width, height) for an uncompressed 24/32-bit BMP, top-down or bottom-up,
    BI_RGB or BI_BITFIELDS with the usual B,G,R(,A) byte order (screencapture -t bmp
    writes a top-down 32-bit BITFIELDS one)."""
    data = open(path, "rb").read()
    if data[:2] != b"BM" or len(data) < 54:
        raise ValueError("not a BMP")
    (offset,) = struct.unpack_from("<I", data, 10)
    hdr_size, width, height, _planes, bpp, compression = struct.unpack_from("<IiiHHI", data, 14)
    if hdr_size < 40 or bpp not in (24, 32) or compression not in (0, 3):
        raise ValueError("only uncompressed 24/32-bit BMPs are supported")
    if compression == 3:
        # Masks live at +54 in a V3 header and the same place in V4/V5; anything but
        # the plain B,G,R little-endian layout is not worth a slow path.
        rmask, gmask, bmask = struct.unpack_from("<III", data, 54)
        if (rmask, gmask, bmask) != (0x00FF0000, 0x0000FF00, 0x000000FF):
            raise ValueError("unsupported BMP channel masks")
    top_down = height < 0
    height = abs(height)
    bytes_pp = bpp // 8
    stride = (width * bytes_pp + 3) & ~3
    if len(data) < offset + stride * height:
        raise ValueError("truncated BMP")

    def px(x, y):
        row = y if top_down else height - 1 - y
        o = offset + row * stride + x * bytes_pp
        return data[o + 2], data[o + 1], data[o]
    return px, width, height


def read_image(path):
    with open(path, "rb") as fh:
        magic = fh.read(2)
    return read_bmp(path) if magic == b"BM" else read_png(path)


def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x, y):
        o = x * bpp
        row = rows[y]
        return row[o], row[o + 1], row[o + 2]
    return px, width, height


def write_png(path, px, width, height):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(px(x, y))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


if args.test_image:
    px, w, h = read_image(args.test_image)
    msg, _ = find_and_decode(px, w, h, None)
    emit(msg if msg else {"error": "no valid strip in image"})
    sys.exit(0)


# ---------------------------------------------------------------------------
# macOS window discovery and screen capture
# ---------------------------------------------------------------------------

# Screen Recording is the one permission the whole bridge depends on, and a denied
# one looks like a cryptic screencapture failure ("could not create image from
# rect"), repeated forever. Name it instead, here and in setup.js's --check.
PERMISSION_HINT = (
    "macOS has not granted Screen Recording to whatever started the bridge. "
    "Open System Settings > Privacy & Security > Screen & System Audio Recording, "
    "switch on the terminal app (iTerm, Terminal, VS Code, ...) you run the bridge "
    "from, then quit and reopen it - the permission only applies to a fresh launch."
)
# Window discovery goes through System Events, which two different permissions can
# block, with two different errors. Naming the wrong one sends the user to the wrong
# settings pane, so keep them apart.
AUTOMATION_HINT = (
    "macOS has not granted Automation (control of System Events) to whatever started "
    "the bridge, so the game window cannot be located. Open System Settings > Privacy "
    "& Security > Automation, find your terminal app and switch on System Events."
)
ACCESSIBILITY_HINT = (
    "macOS has not granted Accessibility to whatever started the bridge, so window "
    "positions cannot be read. Open System Settings > Privacy & Security > "
    "Accessibility and switch on your terminal app, then reopen it."
)


def classify_window_error(detail):
    """An osascript failure mapped to the settings pane that actually fixes it, or
    "" when we do not recognize it (better silent than pointing somewhere wrong)."""
    low = str(detail).lower()
    # -1743: not authorized to send Apple events -> Automation.
    for needle in ("-1743", "not authorized to send apple events", "not authorised to send apple events"):
        if needle in low:
            return AUTOMATION_HINT
    # -1719 and friends: assistive access -> Accessibility.
    for needle in ("-1719", "assistive", "accessibility"):
        if needle in low:
            return ACCESSIBILITY_HINT
    return ""


def classify_capture_error(detail):
    """Map a screencapture failure onto something the user can act on."""
    low = str(detail).lower()
    for needle in ("could not create image", "not authorized", "not permitted",
                   "permission", "screen recording"):
        if needle in low:
            return PERMISSION_HINT
    return ""


class CaptureError(RuntimeError):
    """A screencapture failure, with the cause spelled out when we recognize it."""

    def __init__(self, detail, hint=""):
        super().__init__(detail)
        self.detail = detail
        self.hint = hint or classify_capture_error(detail)

    def payload(self, prefix="screencapture failed"):
        out = {"warn": "%s: %s" % (prefix, self.detail)}
        if self.hint:
            out["hint"] = self.hint
        return out


def run_osascript(script):
    """Write the AppleScript to a temp file and run it; multi-line scripts are
    unreliable when passed inline to osascript -e."""
    fd, path = tempfile.mkstemp(suffix=".scpt")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(script)
        proc = subprocess.run(["osascript", path], capture_output=True, text=True, timeout=10)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "osascript failed")
    return proc.stdout.strip()


def find_window_bounds():
    """Return (x, y, w, h) in screen points for the best matching window."""
    want = args.process_name
    title = args.window_name

    if title:
        script = '''tell application "System Events"
    set allProcs to every process
    repeat with p in allProcs
        try
            set wins to every window of p whose name contains "%s"
            if (count wins) > 0 then
                set w to item 1 of wins
                tell w
                    set {x, y} to position
                    set {ww, hh} to size
                end tell
                return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
            end if
        end try
    end repeat
end tell
return ""''' % title.replace('"', '\\"')
    else:
        script = '''tell application "System Events"
    set pList to every process whose name contains "%s"
    if (count pList) = 0 then
        return ""
    end if
    set p to item 1 of pList
    tell p
        if not (exists front window) then
            return ""
        end if
        set w to front window
        tell w
            set {x, y} to position
            set {ww, hh} to size
        end tell
        return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
    end tell
end tell
return ""''' % want.replace('"', '\\"')

    out = run_osascript(script)
    if not out:
        return None
    parts = out.split(",")
    if len(parts) != 4:
        return None
    return tuple(int(float(p.strip())) for p in parts)


def find_window_bounds_safe():
    """(bounds, error) - never raises. An osascript failure used to escape the main
    loop and kill the capture process, which the bridge then restarted every 5 s."""
    try:
        return find_window_bounds(), None
    except Exception as e:
        detail = str(e).strip() or e.__class__.__name__
        return None, CaptureError(detail, classify_window_error(detail))


def capture_region(x, y, w, h, out_path):
    """Use screencapture to grab a region of the screen into an uncompressed BMP.
    Coordinates are in screen points (macOS logical coordinates); the resulting
    image is in device pixels, so on a Retina display it comes back larger than the
    region asked for (see capture_scale)."""
    cmd = [
        "screencapture",
        "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)),
        "-x",  # no sound
        "-t", "bmp",  # raw pixels: nothing to inflate or unfilter afterwards
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        raise CaptureError("screencapture did not finish within 5 s")
    except OSError as e:
        raise CaptureError("cannot run screencapture: %s" % e)
    # A denied permission still exits non-zero; a rect off-screen leaves no file.
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip() or ("exit status %d" % proc.returncode)
        raise CaptureError(detail)
    try:
        if os.path.getsize(out_path) == 0:
            raise CaptureError("screencapture wrote an empty file")
    except OSError:
        raise CaptureError("screencapture wrote no file")


class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]


class NativeCapture:
    """CoreGraphics through ctypes: CGWindowListCreateImage on the region, then a
    copy of its raw pixels. ~20 ms a frame here against ~300 ms for spawning
    screencapture and un-filtering its PNG in Python, and no temp file. Anything
    missing raises at construction, so the caller can fall back."""

    FRAMEWORKS = "/System/Library/Frameworks/%s.framework/%s"

    def __init__(self):
        if sys.platform != "darwin":
            raise OSError("CoreGraphics is macOS only")
        cg = ctypes.CDLL(self.FRAMEWORKS % ("CoreGraphics", "CoreGraphics"))
        cf = ctypes.CDLL(self.FRAMEWORKS % ("CoreFoundation", "CoreFoundation"))
        vp, sz, u32 = ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32
        protos = {
            "CGPreflightScreenCaptureAccess": (ctypes.c_bool, []),
            "CGWindowListCreateImage": (vp, [_CGRect, u32, u32, u32]),
            "CGImageGetWidth": (sz, [vp]),
            "CGImageGetHeight": (sz, [vp]),
            "CGImageGetBytesPerRow": (sz, [vp]),
            "CGImageGetBitsPerPixel": (sz, [vp]),
            "CGImageGetBitsPerComponent": (sz, [vp]),
            "CGImageGetBitmapInfo": (u32, [vp]),
            "CGImageGetDataProvider": (vp, [vp]),
            "CGDataProviderCopyData": (vp, [vp]),
            "CGImageRelease": (None, [vp]),
        }
        for name, (res, argt) in protos.items():
            fn = getattr(cg, name)  # AttributeError when an OS drops one -> fallback
            fn.restype, fn.argtypes = res, argt
        for name, (res, argt) in {"CFDataGetBytePtr": (vp, [vp]), "CFDataGetLength": (ctypes.c_long, [vp]),
                                  "CFRelease": (None, [vp])}.items():
            fn = getattr(cf, name)
            fn.restype, fn.argtypes = res, argt
        self.cg, self.cf = cg, cf

    def has_access(self):
        """Screen Recording granted to this process? Without it CoreGraphics does not
        fail, it quietly returns the wallpaper - so the caller must ask first."""
        return bool(self.cg.CGPreflightScreenCaptureAccess())

    @staticmethod
    def channel_offsets(bits_per_pixel, bitmap_info):
        """Byte offsets of (R, G, B) within a pixel for the layouts CoreGraphics hands
        out, or None for one we do not want to guess at (16-bit float HDR, ...)."""
        alpha = bitmap_info & 0x1F           # kCGBitmapAlphaInfoMask
        little = (bitmap_info & 0x7000) == 0x2000  # kCGBitmapByteOrder32Little
        alpha_first = alpha in (2, 4, 6)     # PremultipliedFirst, First, NoneSkipFirst
        if bits_per_pixel == 32:
            if alpha_first:
                return (2, 1, 0) if little else (1, 2, 3)   # BGRA / ARGB
            return (3, 2, 1) if little else (0, 1, 2)       # ABGR / RGBA
        if bits_per_pixel == 24 and alpha == 0 and not little:
            return (0, 1, 2)
        return None

    def capture(self, x, y, w, h):
        """(px, width, height) in device pixels, or None when CoreGraphics returned
        nothing (region off every display) or a pixel format we do not read."""
        cg, cf = self.cg, self.cf
        rect = _CGRect(_CGPoint(float(x), float(y)), _CGSize(float(w), float(h)))
        # kCGWindowListOptionOnScreenOnly, kCGNullWindowID, kCGWindowImageDefault
        img = cg.CGWindowListCreateImage(rect, 1, 0, 0)
        if not img:
            return None
        try:
            width, height = cg.CGImageGetWidth(img), cg.CGImageGetHeight(img)
            stride, bpp = cg.CGImageGetBytesPerRow(img), cg.CGImageGetBitsPerPixel(img)
            offs = self.channel_offsets(bpp, cg.CGImageGetBitmapInfo(img))
            if not offs or cg.CGImageGetBitsPerComponent(img) != 8 or not width or not height:
                return None
            cfdata = cg.CGDataProviderCopyData(cg.CGImageGetDataProvider(img))
            if not cfdata:
                return None
            try:
                data = ctypes.string_at(cf.CFDataGetBytePtr(cfdata), cf.CFDataGetLength(cfdata))
            finally:
                cf.CFRelease(cfdata)
        finally:
            cg.CGImageRelease(img)
        if len(data) < stride * height:
            return None
        ro, go, bo = offs
        bytes_pp = bpp // 8

        def px(px_x, px_y):
            o = px_y * stride + px_x * bytes_pp
            return data[o + ro], data[o + go], data[o + bo]
        return px, width, height


_native = None
_native_reason = ""


def native_backend():
    """The in-process backend, or None with the reason in native_reason(). Loaded
    once; the choice is per process, not per frame."""
    global _native, _native_reason
    if _native is None and not _native_reason:
        if args.backend == "screencapture":
            _native_reason = "--backend screencapture"
        else:
            try:
                _native = NativeCapture()
            except (OSError, AttributeError) as e:
                _native_reason = "CoreGraphics unavailable (%s)" % (str(e).strip() or e.__class__.__name__)
    return _native


def native_reason():
    native_backend()
    return _native_reason


def backend_name():
    """For --check and the startup line: what will actually take the pixels."""
    nat = native_backend()
    if nat is None:
        return "screencapture", native_reason()
    if not nat.has_access():
        return "screencapture", "CoreGraphics loaded but Screen Recording is not granted"
    return "native", "CoreGraphics in-process"


def capture_frame(x, y, w, h):
    """(px, width, height) for a screen region in points, by the fastest backend
    that works. Raises CaptureError like capture_region does."""
    nat = native_backend()
    # A denied permission makes CoreGraphics lie rather than fail; leave that case to
    # screencapture, whose error names the permission. Re-asked every frame while
    # denied so a grant that arrives mid-run is picked up.
    if nat is not None and nat.has_access():
        frame = nat.capture(x, y, w, h)
        if frame:
            return frame
        # Nothing came back (region off-screen?): screencapture will say why.
    fd, tmp = tempfile.mkstemp(suffix=".bmp")
    os.close(fd)
    try:
        capture_region(x, y, w, h, tmp)
        try:
            return read_bmp(tmp)
        except ValueError as e:
            raise CaptureError("screencapture wrote an unreadable image: %s" % e)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def capture_scale(asked_w, asked_h, got_w, got_h):
    """Device pixels per screen point in the captured PNG. The decoder samples cell
    centres assuming 1 addon pixel == 1 image pixel, so anything but 1 means the
    strip cannot be read (a Retina display gives 2). Reported rather than fixed."""
    if asked_w <= 0 or asked_h <= 0:
        return 1.0
    return round(max(got_w / float(asked_w), got_h / float(asked_h)), 3)


def grab():
    """Find the WoW window, capture the top-left region, and return a pixel accessor."""
    bounds, werr = find_window_bounds_safe()
    if werr:
        out = {"error": "cannot locate the game window: %s" % werr.detail}
        if werr.hint:
            out["hint"] = werr.hint
        return out
    if not bounds:
        return None
    x, y, ww, wh = bounds
    rw = min(args.region_w, ww)
    rh = min(args.region_h, wh)
    if rw <= 0 or rh <= 0:
        return None
    try:
        return capture_frame(x, y, rw, rh) + (rw, rh)
    except CaptureError as e:
        out = {"error": "screencapture failed: %s" % e.detail}
        if e.hint:
            out["hint"] = e.hint
        return out
    except Exception as e:
        return {"error": "screencapture failed: %s" % e}


def check():
    """One-shot environment report for setup.js: can we capture the screen, can we
    find windows, is the display scale one the decoder can read. Exits 0 when the
    two permissions are in place, whether or not the game happens to be running."""
    ok = True
    fd, tmp = tempfile.mkstemp(suffix=".bmp")
    os.close(fd)
    try:
        # A 4x4 grab at the origin: enough to prove Screen Recording is granted.
        # Always through screencapture: CoreGraphics would silently succeed without it.
        try:
            capture_region(0, 0, 4, 4, tmp)
            emit({"check": "screen-recording", "ok": True})
        except CaptureError as e:
            ok = False
            emit({"check": "screen-recording", "ok": False, "detail": e.detail,
                  "hint": e.hint or "screencapture could not read the screen."})
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    # Informational: the slow path still works, it just costs a process per frame.
    name, why = backend_name()
    emit({"check": "backend", "ok": True, "backend": name, "detail": why})

    who = args.window_name or args.process_name
    bounds, werr = find_window_bounds_safe()
    if werr:
        ok = False
        emit({"check": "window", "ok": False, "detail": werr.detail,
              "hint": werr.hint or "Could not ask System Events for the window list."})
    elif bounds:
        emit({"check": "window", "ok": True, "found": True,
              "detail": "%s window at %d,%d, %dx%d points" % ((who,) + bounds)})
    else:
        emit({"check": "window", "ok": True, "found": False,
              "detail": "%s is not running (fine - start it before the bridge)" % who})

    # Scale can only be measured against a real window, and only matters if one is up.
    if bounds:
        try:
            x, y, ww, wh = bounds
            rw, rh = min(args.region_w, ww), min(args.region_h, wh)
            _, gw, gh = capture_frame(x, y, rw, rh)
            scale = capture_scale(rw, rh, gw, gh)
            emit({"check": "scale", "ok": scale == 1.0, "scale": scale,
                  "detail": "asked %dx%d points, got %dx%d pixels" % (rw, rh, gw, gh),
                  "hint": "" if scale == 1.0 else
                          "This display reports %g device pixels per point, and the strip decoder "
                          "needs 1. Move the game to a non-Retina display, or the strip will never "
                          "decode." % scale})
        except Exception as e:
            emit({"check": "scale", "ok": True, "detail": "could not measure: %s" % e})
    sys.exit(0 if ok else 1)


def run():
    if args.check:
        check()
        return
    if args.probe:
        g = grab()
        if g is None:
            emit({"error": "no game window found"})
            sys.exit(1)
        if isinstance(g, dict):
            emit(g)
            sys.exit(1)
        px, width, height, rw, rh = g
        write_png(args.probe, px, width, height)
        msg, off = find_and_decode(px, width, height, None)
        out = {"info": "saved %dx%d to %s via %s" % (width, height, args.probe, backend_name()[0]),
               "strip": msg, "offset": off}
        scale = capture_scale(rw, rh, width, height)
        if scale != 1.0:
            out["warn"] = ("this display gives %g device pixels per point; the decoder needs 1, "
                           "so the strip cannot be read here" % scale)
        emit(out)
        return

    name, why = backend_name()
    emit({"info": "capture backend: %s (%s), region %dx%d points every %d ms"
                  % (name, why, args.region_w, args.region_h, args.interval_ms)})
    last_key = None
    last_warn = 0.0
    last_wait = 0.0
    bounds = None
    bounds_at = 0
    hint = None
    fails = 0
    scale_warned = False
    while True:
        start = time.time()
        # Refresh window bounds every 5 s so moving/resizing the window is picked up.
        if bounds is None or start - bounds_at > 5:
            bounds, werr = find_window_bounds_safe()
            bounds_at = start
            if werr and (last_warn == 0.0 or start - last_warn >= 30):
                last_warn = start
                emit(werr.payload("cannot locate the game window"))
        if not bounds:
            # Once, then every 60 s: this used to be a line every 3 s in bridge.log.
            if last_wait == 0.0 or start - last_wait >= 60:
                last_wait = start
                emit({"info": "waiting for %s window" % (args.window_name or args.process_name)})
            time.sleep(3)
            continue
        x, y, ww, wh = bounds
        rw = min(args.region_w, ww)
        rh = min(args.region_h, wh)
        try:
            px, width, height = capture_frame(x, y, rw, rh)
        except CaptureError as e:
            fails += 1
            # Say it once immediately, then at most every 30 s: a denied
            # permission never fixes itself, and the old code said it every second.
            if fails == 1 or time.time() - last_warn >= 30:
                last_warn = time.time()
                payload = e.payload()
                if fails > 1:
                    payload["warn"] += " (%d in a row)" % fails
                emit(payload)
            time.sleep(1)
            continue
        except Exception as e:
            fails += 1
            if fails == 1 or time.time() - last_warn >= 30:
                last_warn = time.time()
                emit({"warn": "screencapture failed: %s" % e})
            time.sleep(1)
            continue
        if fails:
            emit({"info": "screen capture recovered after %d failure(s)" % fails})
            fails = 0
        if not scale_warned:
            scale = capture_scale(rw, rh, width, height)
            if scale != 1.0:
                scale_warned = True
                emit({"warn": "this display gives %g device pixels per point; the strip decoder "
                              "needs 1 and will not decode here" % scale,
                      "hint": "Move the game window to a non-Retina display."})
        msg, hint = find_and_decode(px, width, height, hint)
        if msg and msg.get("error"):
            if time.time() - last_warn >= 5:
                last_warn = time.time()
                emit({"warn": "strip seen but rejected: " + msg["error"]})
        elif msg:
            key = "%d:%s" % (msg["id"], msg["text"])
            if key != last_key:
                last_key = key
                emit(msg)
        elapsed = time.time() - start
        sleep = max(0, args.interval_ms / 1000.0 - elapsed)
        if sleep:
            time.sleep(sleep)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        pass
