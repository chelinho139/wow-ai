#!/usr/bin/env node
'use strict';
// Builds the claude-wow binaries: one self-contained file per platform, the
// bridge, setup and the service commands with Bun's runtime inside, plus the
// capture scripts, the addon, the config template and the primer embedded
// (build/entry.js, bridge/assets.js). Nothing to install on the target
// machine: no Node, no npm. The binary finds its config through
// CLAUDE_WOW_HOME exactly as the checkout does.
//
//   node build.js                       every target below into dist/
//   node build.js --target bun-linux-x64 [--target ...]
//   node build.js --host                only this machine's target
//   node build.js --out <folder>
//
// Needs bun (https://bun.sh; `curl -fsSL https://bun.sh/install | bash`, no
// sudo). Cross-compiling downloads the target's runtime once (~30 MB each).
// dist/SHA256SUMS lists the checksums install.sh verifies. Names:
// claude-wow-<darwin|linux|windows>-<arm64|x64>[.exe], the release assets
// install.sh, install.ps1 and the Homebrew formula fetch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-windows-x64'];

function hostTarget() {
  const os_ = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `bun-${os_}-${arch}`;
}

function outName(target) {
  const [, os_, arch] = target.split('-');
  return `claude-wow-${os_}-${arch}${os_ === 'windows' ? '.exe' : ''}`;
}

function findBun() {
  if (process.env.BUN) return process.env.BUN;
  const home = path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const r = spawnSync(process.platform === 'win32' ? 'bun.exe' : 'bun', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (!r.error && r.status === 0) return process.platform === 'win32' ? 'bun.exe' : 'bun';
  if (fs.existsSync(home)) return home;
  console.error('bun was not found. Install it (no sudo): curl -fsSL https://bun.sh/install | bash   (Windows: irm bun.sh/install.ps1 | iex)');
  process.exit(1);
}

function main(argv) {
  let targets = [];
  let out = path.join(ROOT, 'dist');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') targets.push(argv[++i]);
    else if (argv[i] === '--host') targets.push(hostTarget());
    else if (argv[i] === '--out') out = path.resolve(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).slice(1).map(l => l.slice(3)).join('\n')); return 0; }
    else { console.error(`unknown option ${argv[i]}`); return 2; }
  }
  if (!targets.length) targets = TARGETS;
  for (const t of targets) if (!TARGETS.includes(t)) { console.error(`unknown target ${t}; one of ${TARGETS.join(', ')}`); return 2; }
  const bun = findBun();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const bunVersion = (spawnSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
  fs.mkdirSync(out, { recursive: true });
  console.log(`claude-wow ${version}, bun ${bunVersion} -> ${out}`);
  const sums = [];
  for (const target of targets) {
    const file = path.join(out, outName(target));
    const args = ['build', '--compile', `--target=${target}`, path.join(ROOT, 'build', 'entry.js'), '--outfile', file];
    const r = spawnSync(bun, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) { console.error(`bun build failed for ${target}`); return 1; }
    const buf = fs.readFileSync(file);
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    sums.push(`${sum}  ${path.basename(file)}`);
    console.log(`  ${path.basename(file).padEnd(28)} ${(buf.length / 1048576).toFixed(1)} MB  ${sum.slice(0, 12)}`);
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  // The binary for this machine, if one was built: prove it starts.
  const mine = path.join(out, outName(hostTarget()));
  if (targets.includes(hostTarget())) {
    const r = spawnSync(mine, ['service', 'help'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !/install/.test(r.stdout)) { console.error(`${mine} does not run: ${(r.stderr || r.stdout || String(r.error)).trim()}`); return 1; }
    console.log(`  ${path.basename(mine)} runs (service help)`);
  }
  console.log(`checksums: ${path.join(out, 'SHA256SUMS')}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { TARGETS, hostTarget, outName, main };
