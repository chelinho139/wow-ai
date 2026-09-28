# WoW AI installer for Windows. One line, in PowerShell:
#
#   irm https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.ps1 | iex
#
# Options come from the environment, since `iex` takes no parameters:
#
#   $env:WOW_AI_WOW = "D:\Games\World of Warcraft\_classic_beta_"   # the client folder (found automatically in the usual places)
#   $env:WOW_AI_PROJECT = "C:\code\my-game"                          # the default folder the agents work in
#   $env:WOW_AI_SERVICE = "yes"  (or "no")                           # start at login without asking (or never ask)
#   $env:WOW_AI_DIR = "..."      default $env:LOCALAPPDATA\Programs\wow-ai
#   $env:WOW_AI_REF = "..."      default main
#
# Or download it and run:  .\install.ps1 -Wow "..." -Project "..." -Service
#
# What it does, in order, and it is safe to run again (an existing install is
# updated, config.json and your chats are kept):
#   1. checks for Node.js 22.2+ (and says how to get it if not)
#   2. clones the repo with git, or downloads the zip
#      (there is nothing to npm-install: the bridge has no runtime dependencies)
#   3. puts a `wow-ai` command on your user PATH (no admin rights)
#   4. runs the game-side setup (addon, config.json, slot pool)
#   5. offers to start the bridge at login (a launcher in your Startup folder)
# Never asks for administrator rights. Any failure stops with a message saying what to do.

[CmdletBinding()]
param(
  [string]$Wow = $env:WOW_AI_WOW,
  [string]$Project = $env:WOW_AI_PROJECT,
  [switch]$Service,
  [switch]$NoService,
  [string]$Dir = $(if ($env:WOW_AI_DIR) { $env:WOW_AI_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\wow-ai' }),
  [string]$Ref = $(if ($env:WOW_AI_REF) { $env:WOW_AI_REF } else { 'main' }),
  [string]$Repo = $(if ($env:WOW_AI_REPO) { $env:WOW_AI_REPO } else { 'https://github.com/rdimascio/wow-ai' })
)

$ErrorActionPreference = 'Stop'
$MinNode = [version]'22.2'

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Fail($what, $fix) {
  Write-Host "`ninstall failed: $what" -ForegroundColor Red
  if ($fix) { Write-Host "  -> $fix" -ForegroundColor Yellow }
  exit 1
}
function Ask($q) {
  if ($env:WOW_AI_SERVICE -eq 'yes') { return $true }
  if ($env:WOW_AI_SERVICE -eq 'no' -or -not [Environment]::UserInteractive) { return $false }
  $a = Read-Host $q
  return $a -match '^(y|yes)$'
}
# "v22.2.0" -> is it at least $MinNode?
function Test-NodeVersion([string]$v) {
  try { return ([version]($v -replace '^v', '')) -ge $MinNode } catch { return $false }
}

# ---- 1. Node ----------------------------------------------------------------
Step '1/5 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed (or not on the PATH)' 'Install it from https://nodejs.org (the LTS installer, keep "Add to PATH" ticked) or with: winget install OpenJS.NodeJS.LTS  - then open a new PowerShell and run this again.' }
$nodeVer = & node -v
if (-not (Test-NodeVersion $nodeVer)) { Fail "Node.js $nodeVer is too old; $MinNode or newer is required" 'Install the current LTS from https://nodejs.org, open a new PowerShell, and run this again.' }
Write-Host "node $nodeVer ($($node.Source))"

# ---- 2. The code ------------------------------------------------------------
Step '2/5 The code'
$git = Get-Command git -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "updating the existing install in $Dir"
  & git -C $Dir pull --ff-only --quiet 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "warning: could not fast-forward $Dir (local changes or no network); keeping what is there" -ForegroundColor Yellow } else { Write-Host "up to date with $Ref" }
} elseif ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir 'setup.js')) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
  Fail "$Dir exists and is not a wow-ai install" 'Pick another folder with $env:WOW_AI_DIR, or move that one aside.'
} elseif ($git -and -not (Test-Path (Join-Path $Dir 'setup.js'))) {
  Write-Host "cloning $Repo ($Ref) into $Dir"
  New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
  & git clone --quiet --depth 1 --branch $Ref $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' "Check the network and that $Repo is reachable, then run this again." }
} else {
  $zip = Join-Path $env:TEMP 'wow-ai.zip'
  $tmp = Join-Path $env:TEMP "wow-ai-unzip-$PID"
  Write-Host "downloading $Repo/archive/refs/heads/$Ref.zip"
  try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip }
  catch { try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/tags/$Ref.zip" -OutFile $zip } catch { Fail 'download failed' 'Check the network, or install git (https://git-scm.com) and run this again.' } }
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive $zip $tmp
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $src.FullName 'setup.js'))) { Fail 'the archive did not contain wow-ai' 'Try again with git installed.' }
  New-Item -ItemType Directory -Force $Dir | Out-Null
  # Copy over the old files; config.json, state.json and transcripts.json are not in the archive, so they survive.
  Copy-Item -Recurse -Force (Join-Path $src.FullName '*') $Dir
  Remove-Item -Recurse -Force $tmp, $zip
  Write-Host "installed into $Dir (no git: run this script again to update)"
}
if (-not (Test-Path (Join-Path $Dir 'setup.js'))) { Fail "$Dir does not contain setup.js after the download" "Remove $Dir and run this again." }

# ---- 3. The command ---------------------------------------------------------
Step '3/5 The wow-ai command'
$binDir = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
# A .cmd launcher: works from cmd and PowerShell whatever the execution policy.
Set-Content -Path (Join-Path $binDir 'wow-ai.cmd') -Value "@echo off`r`nnode `"%~dp0..\bridge\supervisor.js`" %*`r`n" -Encoding ASCII
Write-Host "wow-ai command: $binDir\wow-ai.cmd"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) -ne '' -join ';'), 'User')
  Write-Host "added $binDir to your user PATH; open a new terminal for the wow-ai command"
}
if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$env:Path;$binDir" }

# ---- 4. Game-side setup -----------------------------------------------------
Step '4/5 Game-side setup (addon, config, slot pool)'
$setupArgs = @()
if ($Wow) { $setupArgs += @('--wow', $Wow) }
if ($Project) { $setupArgs += @('--project', $Project) }
Push-Location $Dir
try { & node setup.js @setupArgs; $setupOk = ($LASTEXITCODE -eq 0) } finally { Pop-Location }
if (-not $setupOk) {
  Fail 'the game-side setup did not finish (see above)' 'The code and the wow-ai command are installed. Fix what setup reported (usually: the client folder), then run:  wow-ai setup --wow "D:\path\to\World of Warcraft\_classic_beta_"'
}

# ---- 5. Start at login ------------------------------------------------------
Step '5/5 Background service'
$installService = $false
if ($NoService -or $env:WOW_AI_SERVICE -eq 'no') { Write-Host 'skipped (install later with: wow-ai service install)' }
elseif ($Service -or (Ask 'Run the bridge in the background and start it at login? [y/N]')) {
  & node (Join-Path $Dir 'bridge\supervisor.js') service install
  if ($LASTEXITCODE -ne 0) { Fail 'the service did not install (see above)' 'Everything else is in place; start the bridge by hand with: wow-ai' }
  $installService = $true
} else { Write-Host 'skipped (install later with: wow-ai service install; or start the bridge by hand with: wow-ai)' }

Write-Host "`nInstalled. From here on, the wow-ai command does what `"npm start`" does above, from any folder. Next:" -ForegroundColor Green
Write-Host '  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).'
Write-Host '  2. Enable "WoW AI" at the character-select AddOns screen.'
if ($installService) { Write-Host '  3. Check the bridge:  wow-ai service status     (logs: wow-ai service logs)' }
else { Write-Host '  3. Start the bridge:  wow-ai        (or: wow-ai service install, to keep it running in the background)' }
Write-Host '  4. In game:  /wow-ai'
Write-Host "`nUpdate later by running this installer again. Code: $Dir"
