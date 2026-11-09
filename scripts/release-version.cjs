'use strict';

const fs = require('node:fs');
const path = require('node:path');

// npm's prepare step updates package.json and package-lock.json first.
exports.prepare = async (_config, { cwd, nextRelease: { version } }) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable release version, got ${version}`);
  }
  const files = [
    ['rust/bridge/Cargo.toml', /^(\[package\][\s\S]*?\nversion = ")[^"]+(".*)$/m],
    ['Cargo.lock', /^(name = "wow-ai-reforged"\r?\nversion = ")[^"]+(")$/m],
    ['addon/WoWAI/WoWAI.toc', /^(## Version: )[^\r\n]+()$/m],
  ];
  const updates = files.map(([file, pattern]) => {
    const filename = path.join(cwd, file);
    const source = fs.readFileSync(filename, 'utf8');
    if (!pattern.test(source)) throw new Error(`Release version field missing in ${file}`);
    return [filename, source.replace(pattern, (_match, before, after) => before + version + after)];
  });
  for (const [filename, contents] of updates) fs.writeFileSync(filename, contents);
};
