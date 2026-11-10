// Regenerate only after reviewing changes to the upstream outbox contract.
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../../../bridge/protocol.js');
const hex = value => Buffer.from(value, 'utf8').toString('hex');
const rows = [
  {id: 7, session: 'abc123', chat: 'c1', text: hex('héllo 世界'), cwd: hex('C:\\My Project'), newSession: true},
  {id: 8, session: 'abc123', chat: 'c2', text: hex('question'), cwd: '', ctx: '', agent: 'Codex', allow: hex('WebSearch\x1fBash(git:*)')},
];
const cases = rows.map(row => {
  const source = 'WoWAIDB = {\n["outbox"] = {\n'
    + Object.entries(row).map(([key, value]) => `["${key}"] = ${JSON.stringify(value)},`).join('\n')
    + '\n},\n["settings"] = {},\n}\n';
  return {source, expected: protocol.parseOutbox(source)};
});
fs.writeFileSync(path.join(__dirname, 'fixtures/reload.json'), JSON.stringify(cases, null, 2) + '\n');
