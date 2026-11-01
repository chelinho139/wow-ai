# Saves the WoW window's client area as a PNG, scaled down to -MaxWidth, for
# "/ai screenshot" (the agent gets the file). Started by bridge.js; prints one
# line: "saved WxH" or why it could not.
#
#   screenshot.ps1 -ProcessName WowB -Out C:\path\shot.png [-MaxWidth 1600]

param(
  [string]$ProcessName = "WowB",
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 1600
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ShotWin {
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][ShotWin]::SetProcessDPIAware()

$proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "no $ProcessName window"; exit 1 }
$hwnd = $proc.MainWindowHandle
if ([ShotWin]::IsIconic($hwnd)) { Write-Output "the game window is minimized"; exit 1 }

$rect = New-Object ShotWin+RECT
[void][ShotWin]::GetClientRect($hwnd, [ref]$rect)
$pt = New-Object ShotWin+POINT
[void][ShotWin]::ClientToScreen($hwnd, [ref]$pt)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output "the game window has no size"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($pt.X, $pt.Y, 0, 0, $bmp.Size)
$g.Dispose()

if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $nw = $MaxWidth
  $nh = [int][Math]::Round($h * $MaxWidth / $w)
  $small = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bmp, 0, 0, $nw, $nh)
  $g.Dispose()
  $bmp.Dispose()
  $bmp = $small
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("saved {0}x{1}" -f $bmp.Width, $bmp.Height)
$bmp.Dispose()
