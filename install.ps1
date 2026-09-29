# Claude WoW installer for Windows. One line, in PowerShell:
#
#   irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
#
# Options come from the environment, since `iex` takes no parameters:
#
#   $env:CLAUDE_WOW_WOW = "D:\Games\World of Warcraft\_classic_beta_"   # the client folder (found automatically in the usual places)
#   $env:CLAUDE_WOW_PROJECT = "C:\code\my-game"                          # the default folder the agents work in
#   $env:CLAUDE_WOW_SERVICE = "yes"  (or "no")                           # start at login without asking (or never ask)
#   $env:CLAUDE_WOW_SOURCE = "1"     no prebuilt binary: clone the repo and run it with Node.js 22.2+
#   $env:CLAUDE_WOW_RELEASE = "..."  which release's binary (default latest)
#   $env:CLAUDE_WOW_DIR = "..."      where it goes, default $env:LOCALAPPDATA\Programs\claude-wow
#   $env:CLAUDE_WOW_REF = "..."      which version of the source, from source (default main)
#
# Or download it and run:  .\install.ps1 -Wow "..." -Project "..." -Service [-FromSource]
#
# What it does, in order, and it is safe to run again (an existing install is
# updated, config.json and your chats are kept):
#   1. downloads the claude-wow binary for Windows x64 from the project's GitHub
#      releases into %LocalAppData%\Programs\claude-wow\bin, checks it against
#      the release's SHA256SUMS and runs it once. It is the bridge, setup and
#      the service commands in one file with its runtime inside: nothing else
#      to install, no Node.js. Where there is no binary (no release yet, another
#      architecture, CLAUDE_WOW_SOURCE=1) it installs from source instead:
#      checks for Node.js 22.2+, clones the repo with git (or downloads the zip;
#      nothing to npm-install) and writes a claude-wow.cmd that runs it with node
#   2. puts that folder on your user PATH (no admin rights)
#   3. runs the game-side setup (addon, config.json, slot pool); config, state
#      and logs live in ~\.claude-wow (CLAUDE_WOW_HOME), outside the code
#   4. offers to start the bridge at login (a launcher in your Startup folder)
# An install by the project's old name (Programs\wow-ai, the wow-ai command,
# the "WoW AI bridge" launcher) is carried over: its config and sessions are
# copied to ~\.claude-wow, its launcher is removed, and setup migrates the
# addon and your chats in the game folder.
# Never asks for administrator rights. Any failure stops with a message saying what to do.

[CmdletBinding()]
param(
  [string]$Wow = $env:CLAUDE_WOW_WOW,
  [string]$Project = $env:CLAUDE_WOW_PROJECT,
  [switch]$Service,
  [switch]$NoService,
  [switch]$FromSource,
  [string]$Release = $(if ($env:CLAUDE_WOW_RELEASE) { $env:CLAUDE_WOW_RELEASE } else { 'latest' }),
  [string]$Dir = $(if ($env:CLAUDE_WOW_DIR) { $env:CLAUDE_WOW_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\claude-wow' }),
  [string]$Ref = $(if ($env:CLAUDE_WOW_REF) { $env:CLAUDE_WOW_REF } else { 'main' }),
  [string]$Repo = $(if ($env:CLAUDE_WOW_REPO) { $env:CLAUDE_WOW_REPO } else { 'https://github.com/rdimascio/claude-wow' })
)
$HomeDir = $(if ($env:CLAUDE_WOW_HOME) { $env:CLAUDE_WOW_HOME } else { Join-Path $HOME '.claude-wow' })
$OldDir = Join-Path $env:LOCALAPPDATA 'Programs\wow-ai'
if ($env:CLAUDE_WOW_SOURCE -eq '1') { $FromSource = $true }

$ErrorActionPreference = 'Stop'
$MinNode = [version]'22.2'

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Fail($what, $fix) {
  Write-Host "`ninstall failed: $what" -ForegroundColor Red
  if ($fix) { Write-Host "  -> $fix" -ForegroundColor Yellow }
  exit 1
}
function Ask($q) {
  if ($env:CLAUDE_WOW_SERVICE -eq 'yes') { return $true }
  if ($env:CLAUDE_WOW_SERVICE -eq 'no' -or -not [Environment]::UserInteractive) { return $false }
  $a = Read-Host $q
  return $a -match '^(y|yes)$'
}
# "v22.2.0" -> is it at least $MinNode?
function Test-NodeVersion([string]$v) {
  try { return ([version]($v -replace '^v', '')) -ge $MinNode } catch { return $false }
}

$binDir = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
$exe = Join-Path $binDir 'claude-wow.exe'
$cmdShim = Join-Path $binDir 'claude-wow.cmd'
$script:Cmd = $null

# ---- 1. The bridge ----------------------------------------------------------
# The binary route. $false, with a line saying why, whenever the source route
# should be taken instead; a download that arrived but is wrong (checksum
# mismatch, a binary that does not run) fails outright.
function Get-Binary {
  if ($FromSource) { return $false }
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Write-Host "no prebuilt binary for $env:PROCESSOR_ARCHITECTURE Windows"; return $false }
  $asset = 'claude-wow-windows-x64.exe'
  $base = if ($Release -eq 'latest') { "$Repo/releases/latest/download" } else { "$Repo/releases/download/$Release" }
  $tmp = Join-Path $env:TEMP "claude-wow-$PID.exe"
  Write-Host "downloading $base/$asset"
  try { Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $tmp }
  catch { Write-Host "no binary at $base/$asset (no release for it yet, or no network)"; return $false }
  $sums = $null
  try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS").Content } catch {}
  if ($sums) {
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
    $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
    $have = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $want -ne $have) { Remove-Item -Force $tmp; Fail "the downloaded $asset does not match the release's SHA256SUMS" 'Run this again; if it keeps failing, install from source with -FromSource (or $env:CLAUDE_WOW_SOURCE = "1").' }
    Write-Host 'checksum OK'
  } else { Write-Host 'warning: the release has no SHA256SUMS, so the download was not verified' }
  & $tmp service help *> $null
  if ($LASTEXITCODE -ne 0) { Remove-Item -Force $tmp; Fail 'the downloaded binary does not run on this machine' 'Run this again with -FromSource to use Node.js instead.' }
  # Windows will not replace a running executable: stop a bridge that runs the old one first.
  if (Test-Path $exe) { & $exe service stop *> $null }
  Move-Item -Force $tmp $exe
  if (Test-Path $cmdShim) { Remove-Item -Force $cmdShim } # the source route's shim from an earlier install
  $script:Cmd = $exe
  Write-Host "claude-wow: $exe ($(& $exe --version 2>$null))"
  return $true
}

# The source route: Node.js, the code, and a .cmd shim that runs it.
function Get-Source {
  Write-Host 'installing from source'
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js is not installed (or not on the PATH), and there is no prebuilt binary to use instead' 'Install it from https://nodejs.org (the LTS installer, keep "Add to PATH" ticked) or with: winget install OpenJS.NodeJS.LTS  - then open a new PowerShell and run this again.' }
  $nodeVer = & node -v
  if (-not (Test-NodeVersion $nodeVer)) { Fail "Node.js $nodeVer is too old; $MinNode or newer is required" 'Install the current LTS from https://nodejs.org, open a new PowerShell, and run this again.' }
  Write-Host "node $nodeVer ($($node.Source))"
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "updating the existing install in $Dir"
    & git -C $Dir pull --ff-only --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "warning: could not fast-forward $Dir (local changes or no network); keeping what is there" -ForegroundColor Yellow } else { Write-Host "up to date with $Ref" }
  } elseif ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir 'setup.js')) -and (Get-ChildItem $Dir -Force -Exclude bin | Select-Object -First 1)) {
    Fail "$Dir exists and is not a claude-wow install" 'Pick another folder with $env:CLAUDE_WOW_DIR, or move that one aside.'
  } elseif ($git -and -not (Test-Path (Join-Path $Dir 'setup.js'))) {
    Write-Host "cloning $Repo ($Ref) into $Dir"
    $tmpClone = Join-Path $env:TEMP "claude-wow-clone-$PID"
    & git clone --quiet --depth 1 --branch $Ref $Repo $tmpClone
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' "Check the network and that $Repo is reachable, then run this again." }
    Copy-Item -Recurse -Force (Join-Path $tmpClone '*') $Dir
    Copy-Item -Recurse -Force (Join-Path $tmpClone '.git') $Dir
    Remove-Item -Recurse -Force $tmpClone
  } else {
    $zip = Join-Path $env:TEMP 'claude-wow.zip'
    $tmp = Join-Path $env:TEMP "claude-wow-unzip-$PID"
    Write-Host "downloading $Repo/archive/refs/heads/$Ref.zip"
    try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip }
    catch { try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/tags/$Ref.zip" -OutFile $zip } catch { Fail 'download failed' 'Check the network, or install git (https://git-scm.com) and run this again.' } }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip $tmp
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not (Test-Path (Join-Path $src.FullName 'setup.js'))) { Fail 'the archive did not contain claude-wow' 'Try again with git installed.' }
    # Copy over the old files; config.json, state.json and transcripts.json are not in the archive, so they survive.
    Copy-Item -Recurse -Force (Join-Path $src.FullName '*') $Dir
    Remove-Item -Recurse -Force $tmp, $zip
    Write-Host "installed into $Dir (no git: run this script again to update)"
  }
  if (-not (Test-Path (Join-Path $Dir 'setup.js'))) { Fail "$Dir does not contain setup.js after the download" "Remove $Dir and run this again." }
  # A .cmd launcher: works from cmd and PowerShell whatever the execution policy.
  Set-Content -Path $cmdShim -Value "@echo off`r`nnode `"%~dp0..\bridge\supervisor.js`" %*`r`n" -Encoding ASCII
  if (Test-Path $exe) { & $exe service stop *> $null; Remove-Item -Force $exe } # the binary from an earlier install; .cmd is the command now
  $script:Cmd = $cmdShim
  Write-Host "claude-wow command: $cmdShim (runs $Dir with node)"
}

Step '1/4 The bridge'
if (-not (Get-Binary)) { Get-Source }

# ---- 2. The command on the PATH ---------------------------------------------
Step '2/4 The claude-wow command'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) -ne '' -join ';'), 'User')
  Write-Host "added $binDir to your user PATH; open a new terminal for the claude-wow command"
} else { Write-Host "$binDir is on your user PATH" }
if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$env:Path;$binDir" }

# An install under the old name: its config and the agents' sessions move to the
# home folder (once; setup then rewrites the addon paths inside), its Startup
# launcher goes so it stops starting the old bridge at login, and its bin folder
# leaves the user PATH. The old code folder is left for you to delete.
if ((Test-Path (Join-Path $OldDir 'bridge\config.json')) -and -not (Test-Path (Join-Path $HomeDir 'config.json'))) {
  New-Item -ItemType Directory -Force $HomeDir | Out-Null
  foreach ($f in 'config.json', 'state.json', 'transcripts.json') {
    if (Test-Path (Join-Path $OldDir "bridge\$f")) { Copy-Item (Join-Path $OldDir "bridge\$f") (Join-Path $HomeDir $f) }
  }
  Write-Host "carried config.json, state.json and transcripts.json over from $OldDir\bridge to $HomeDir"
  & $Cmd service uninstall | Out-Null
}
if (Test-Path $OldDir) {
  $oldBin = Join-Path $OldDir 'bin'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -contains $oldBin) {
    [Environment]::SetEnvironmentVariable('Path', ((($userPath -split ';') | Where-Object { $_ -ne $oldBin }) -join ';'), 'User')
    Write-Host "removed $oldBin from your user PATH; the command is claude-wow from now on"
  }
  Write-Host "the old code in $OldDir is no longer used; delete it when you like"
}

# ---- 3. Game-side setup -----------------------------------------------------
Step '3/4 Game-side setup (addon, config, slot pool)'
$setupArgs = @()
if ($Wow) { $setupArgs += @('--wow', $Wow) }
if ($Project) { $setupArgs += @('--project', $Project) }
& $Cmd setup @setupArgs
if ($LASTEXITCODE -ne 0) {
  Fail 'the game-side setup did not finish (see above)' 'The claude-wow command is installed. Fix what setup reported (usually: the client folder), then run:  claude-wow setup --wow "D:\path\to\World of Warcraft\_classic_beta_"'
}

# ---- 4. Start at login ------------------------------------------------------
Step '4/4 Background service'
$installService = $false
if ($NoService -or $env:CLAUDE_WOW_SERVICE -eq 'no') { Write-Host 'skipped (install later with: claude-wow service install)' }
elseif ($Service -or (Ask 'Run the bridge in the background and start it at login? [y/N]')) {
  & $Cmd service install
  if ($LASTEXITCODE -ne 0) { Fail 'the service did not install (see above)' 'Everything else is in place; start the bridge by hand with: claude-wow' }
  $installService = $true
} else { Write-Host 'skipped (install later with: claude-wow service install; or start the bridge by hand with: claude-wow)' }

Write-Host "`nInstalled. The claude-wow command works from any folder. Next:" -ForegroundColor Green
Write-Host '  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).'
Write-Host '  2. Enable "Claude WoW" at the character-select AddOns screen.'
if ($installService) { Write-Host '  3. Check the bridge:  claude-wow service status     (logs: claude-wow service logs)' }
else { Write-Host '  3. Start the bridge:  claude-wow        (or: claude-wow service install, to keep it running in the background)' }
Write-Host '  4. In game:  /claude'
Write-Host "`nUpdate later by running this installer again. Folder: $Dir"
