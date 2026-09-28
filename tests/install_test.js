// install.sh and install.ps1, the one-line installers: they parse, the Node
// version gate accepts 22.2+ and nothing older or malformed, and the shell
// script runs nothing until it has been read in full (curl | sh safety).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SH = path.join(__dirname, '..', 'install.sh');
const PS1 = path.join(__dirname, '..', 'install.ps1');
const hasSh = process.platform !== 'win32' && !spawnSync('sh', ['-c', 'true']).error;
const pwsh = ['pwsh', 'powershell'].find(p => !spawnSync(p, ['-NoProfile', '-Command', '$true'], { windowsHide: true }).error);

test('install.sh: everything lives in functions and main runs last, so a cut-off download does nothing', () => {
  const src = fs.readFileSync(SH, 'utf8');
  assert.match(src, /\nmain "\$@"\n$/, 'main "$@" is the last line');
  assert.ok(!/\nsudo\b/.test(src) && !/ sudo /.test(src), 'never sudo');
  assert.match(src, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/rdimascio\/wow-ai\/main\/install\.sh \| sh/, 'documents its own URL');
  assert.match(src, /id -u.*-ne 0/, 'refuses root');
});

test('install.sh parses, and its Node gate accepts 22.2+ only', { skip: !hasSh && 'no sh here' }, () => {
  const lint = spawnSync('sh', ['-n', SH], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr);
  const ok = v => spawnSync('sh', [SH, '--node-ok', v], { encoding: 'utf8' });
  for (const v of ['v22.2.0', '22.2.0', 'v22.10.1', 'v24.21.0', 'v100.0.0']) assert.equal(ok(v).status, 0, `${v} should pass: ${ok(v).stdout}`);
  for (const v of ['v22.1.9', 'v21.9.0', 'v18.0.0', 'garbage', '', 'v22']) assert.equal(ok(v).status, 1, `${v} should fail`);
  assert.match(ok('v20.0.0').stdout, /need 22\.2/);
});

test('install.sh: unknown options and a missing Node fail loudly with a hint', { skip: !hasSh && 'no sh here' }, () => {
  const bad = spawnSync('sh', [SH, '--frobnicate'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /install failed: unknown option --frobnicate/);
  assert.match(bad.stderr, /-> Options:/);
  const noNode = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME } });
  assert.equal(noNode.status, 1);
  assert.match(noNode.stderr, /Node\.js is not installed/);
  assert.match(noNode.stderr, /nodejs\.org/);
});

test('install.ps1 parses, and its Node gate matches the shell one', { skip: !pwsh && 'no PowerShell here' }, () => {
  const script = `
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile('${PS1.replace(/'/g, "''")}', [ref]$null, [ref]$errs) | Out-Null
    if ($errs.Count) { $errs | ForEach-Object { Write-Output $_.Message }; exit 1 }
    $MinNode = [version]'22.2'
    function Test-NodeVersion([string]$v) { try { return ([version]($v -replace '^v', '')) -ge $MinNode } catch { return $false } }
    foreach ($v in 'v22.2.0','v24.21.0','v100.0.0') { if (-not (Test-NodeVersion $v)) { Write-Output "FAIL $v"; exit 1 } }
    foreach ($v in 'v22.1.9','v18.0.0','garbage','') { if (Test-NodeVersion $v) { Write-Output "FAIL $v"; exit 1 } }
    Write-Output OK`;
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK/);
  const src = fs.readFileSync(PS1, 'utf8');
  assert.match(src, /irm https:\/\/raw\.githubusercontent\.com\/rdimascio\/wow-ai\/main\/install\.ps1 \| iex/, 'documents its own URL');
  assert.ok(!/RunAs|Start-Process .*-Verb/i.test(src), 'never elevates');
});
