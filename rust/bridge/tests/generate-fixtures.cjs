// Run from any directory: node rust/bridge/tests/generate-fixtures.cjs
// Regenerate only after reviewing upstream protocol changes.
const fs = require('node:fs');
const path = require('node:path');
const p = require('../../../bridge/protocol.js');
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const record = (...fields) => fields.join('\x1f');
const payloads = [
  record('session', 'chat', '12', 'C:\\My Project', 'agent=Codex;n', 'Chat', 'Hello 世界'),
  record('s', 'c', '1', '', 'c;h', 'name', 'zone', 'text', 'with separator'),
  record('s', 'c', '2', '', 'c', '', '', 'clear context'),
  record('s', 'c', '3', '', 'c', 'name', 'no context field'),
  record('s', 'c', '4', '', 'allow= WebSearch, ,Bash(git:*);allow=WebFetch;agent=GROK;agent=claude;unknown', 'name', 'text'),
  record('s', 'c', '5', '', 'd', 'old unnamed format'),
  record('s', '/project', 'n;agent=hermes', 'pre-chat format'),
  ['garbage', record('s', 'c', '6', '', '', 'name', 'ok'), record('s', 'c', '-1', '', '', 'name', 'bad')].join('\x1e'),
  record('', '', '0007', '', '', '', ''),
  record('s', 'c', '9007199254740991', '', '', 'max safe', 'text'),
  '',
];
const rows = payloads.map(payload => {
  const jobs = p.jobsFromStrip(42, payload);
  const canonical = jobs.map(j => [j.session, j.chat, j.id, j.cwd, j.newSession, j.hello, j.forget, j.context, j.allow.join('\x1f'), j.agent, j.name ?? '~', j.text, j.ctx ?? '~'].join('\t')).join('\n');
  return ['jobs', hex(payload), hex(canonical)].join('\t');
});
for (const value of ['', 'quote" slash\\\r\n\t', 'é 世界 🐉', '\0' + '123', ...Array.from({length: 128}, (_, i) => String.fromCharCode(i))]) {
  rows.push(['lua', hex(value), hex(p.luaStr(value))].join('\t'));
}
fs.writeFileSync(path.join(__dirname, 'fixtures/protocol.tsv'), rows.join('\n') + '\n');
