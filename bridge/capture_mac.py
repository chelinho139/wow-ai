#!/usr/bin/env python3
"""macOS counterpart of capture.ps1 / capture_x11.py: screen-captures the
top-left corner of the native WoW: Forever client and decodes the WoWAI pixel
strip (see Codec.lua in the addon). Prints one JSON line per new message to
stdout, with the same {info|warn|error|id,text} contract as the other capture
scripts. Started by bridge.js.

Uses only the Python stdlib plus the built-in macOS screencapture binary and
osascript. It needs two System Settings permissions for whatever starts it:
Automation/Accessibility (System Events, for window discovery) and Screen
Recording (screencapture). macOS does not reliably prompt for them, so a missing
one shows up as a failure here rather than a dialog; --check names which.

  capture_mac.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_mac.py --probe out.png          save what the capture sees once and exit
  capture_mac.py --check                  report the permissions and display scale
  capture_mac.py --window-name NAME       match a window by title instead of process name
"""

import argparse
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
# region to capture, in screen points (independent of Retina scale)
p.add_argument("--region-w", type=int, default=1000)
p.add_argument("--region-h", type=int, default=400)
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * CELL, MAXROWS * CELL
XSLACK = 8
YSLACK = args.y_slack


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
# PNG in/out (tests, --probe, and screencapture output)
# ---------------------------------------------------------------------------

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
    px, w, h = read_png(args.test_image)
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
    """Use screencapture to grab a region of the screen into a PNG.
    Coordinates are in screen points (macOS logical coordinates); the resulting
    PNG is in device pixels, so on a Retina display it comes back larger than the
    region asked for (see capture_scale)."""
    cmd = [
        "screencapture",
        "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)),
        "-x",  # no sound
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


def capture_scale(asked_w, asked_h, got_w, got_h):
    """Device pixels per screen point in the captured PNG. The decoder samples cell
    centres assuming 1 addon pixel == 1 image pixel, so anything but 1 means the
    strip cannot be read (a Retina display gives 2). Reported rather than fixed."""
    if asked_w <= 0 or asked_h <= 0:
        return 1.0
    return round(max(got_w / float(asked_w), got_h / float(asked_h)), 3)


def grab(out_path):
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
        capture_region(x, y, rw, rh, out_path)
    except CaptureError as e:
        out = {"error": "screencapture failed: %s" % e.detail}
        if e.hint:
            out["hint"] = e.hint
        return out
    except Exception as e:
        return {"error": "screencapture failed: %s" % e}
    return read_png(out_path) + (rw, rh)


def check():
    """One-shot environment report for setup.js: can we capture the screen, can we
    find windows, is the display scale one the decoder can read. Exits 0 when the
    two permissions are in place, whether or not the game happens to be running."""
    ok = True
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        # A 4x4 grab at the origin: enough to prove Screen Recording is granted.
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
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            x, y, ww, wh = bounds
            rw, rh = min(args.region_w, ww), min(args.region_h, wh)
            capture_region(x, y, rw, rh, tmp)
            _, gw, gh = read_png(tmp)
            scale = capture_scale(rw, rh, gw, gh)
            emit({"check": "scale", "ok": scale == 1.0, "scale": scale,
                  "detail": "asked %dx%d points, got %dx%d pixels" % (rw, rh, gw, gh),
                  "hint": "" if scale == 1.0 else
                          "This display reports %g device pixels per point, and the strip decoder "
                          "needs 1. Move the game to a non-Retina display, or the strip will never "
                          "decode." % scale})
        except Exception as e:
            emit({"check": "scale", "ok": True, "detail": "could not measure: %s" % e})
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    sys.exit(0 if ok else 1)


def run():
    if args.check:
        check()
        return
    if args.probe:
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            g = grab(tmp)
            if g is None:
                emit({"error": "no game window found"})
                sys.exit(1)
            if isinstance(g, dict):
                emit(g)
                sys.exit(1)
            px, width, height, rw, rh = g
            write_png(args.probe, px, width, height)
            msg, off = find_and_decode(px, width, height, None)
            out = {"info": "saved %dx%d to %s" % (width, height, args.probe), "strip": msg, "offset": off}
            scale = capture_scale(rw, rh, width, height)
            if scale != 1.0:
                out["warn"] = ("this display gives %g device pixels per point; the decoder needs 1, "
                               "so the strip cannot be read here" % scale)
            emit(out)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return

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
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            try:
                capture_region(x, y, rw, rh, tmp)
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
            px, width, height = read_png(tmp)
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
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        elapsed = time.time() - start
        sleep = max(0, args.interval_ms / 1000.0 - elapsed)
        if sleep:
            time.sleep(sleep)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        pass
