'use strict';
// The coding plugin: what the bridge did before there were plugins. A chat is
// an agent session in a folder, resolved against the bridge's folder (/claude-wow
// cd, --project, defaultCwd); the folder must exist, and a session belongs to
// the folder that made it, so a chat that changes folder starts a new one.
// Everything else (which agent, the game context, map and macros, transcripts)
// is the core's, shared with every other plugin.

const fs = require('fs');
const P = require('../protocol');

// Subfolders of the bridge's folder, for the "folder not found" hint.
function siblingFolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name).sort().slice(0, 30);
  } catch { return []; }
}

const plugin = {
  id: 'claude-code',
  label: 'Code',
  aliases: ['claude', 'code'],
  tools: '',
  surfaces: ['map', 'macro', 'ui'],
  searchesFiles: true,
  handle(job, core) {
    const cwd = P.resolveCwd(job.cwd, core.defaultCwd);
    job.cwd = cwd;
    if (!fs.existsSync(cwd)) {
      core.log(`${core.tag(job)} cwd does not exist: ${cwd}`);
      const sibs = siblingFolders(core.defaultCwd);
      core.fail(job, `Folder does not exist: ${cwd}\n` +
        `Paths are relative to ${core.defaultCwd}.` +
        (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
        `\nUse /claude cd <folder> to pick one, or /claude cd alone for the default.`);
      return;
    }
    core.runAgent(job, {
      cwd,
      // Agents keep sessions per project folder, so a chat that changed folder starts fresh.
      freshSession: () => {
        const prev = core.sessionFolder(job);
        return prev && !P.sameFolder(prev, cwd) ? `folder changed (${prev} -> ${cwd})` : '';
      },
    });
  },
};

module.exports = plugin;
