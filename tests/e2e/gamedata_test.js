'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('gamedata');
const withGame = gameRunner(ROOT);
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago');
const BUILD = '1.60.1.200';

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve({ status: 200, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8') });
}

const listAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  return out;
};

test('ask runs get the wowdata server and its run-only rule; coding runs do not; config.json is untouched', async () => {
  let dataDir = '';
  const beforeLaunch = async sb => {
    dataDir = path.join(sb.home, 'data');
    await D.sync({ dataDir, build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    await h.client.say('where is the vale roost');
    const [askRun] = h.agentCalls();
    const config = JSON.parse(listAfter(askRun.argv, '--mcp-config')[0]);
    const server = config.mcpServers.wowdata;
    assert.equal(server.alwaysLoad, true);
    assert.ok(path.isAbsolute(server.command), server.command);
    const [dataFlag, dataArg, buildFlag, clientBuild] = server.args.slice(-4);
    assert.deepEqual([dataFlag, dataArg, buildFlag], ['--data', dataDir, '--client-build']);
    assert.ok(D.isBuild(clientBuild) && clientBuild.startsWith('1.60.1.'), `the client build from the game context: ${clientBuild}`);
    assert.ok(listAfter(askRun.argv, '--allowedTools').includes('mcp__wowdata'));
    assert.ok(!askRun.argv.includes('--strict-mcp-config'));
    await h.bridge.waitForLine(/wowdata 1\.60\.1\.200/);

    await h.client.say('@claude-code list the files');
    const codingRun = h.agentCalls()[1];
    assert.ok(!codingRun.argv.includes('--mcp-config'), 'the coding plugin runs without it');
    assert.ok(!listAfter(codingRun.argv, '--allowedTools').includes('mcp__wowdata'));
    assert.ok(!fs.readFileSync(h.sb.config, 'utf8').includes('mcp__wowdata'), 'the rule is never saved');
  });
});

test('with no synced data, ask runs go without the server and the bridge says why once', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('hello');
    await h.client.say('hello again');
    for (const run of h.agentCalls()) {
      assert.ok(!run.argv.includes('--mcp-config'));
      assert.ok(!listAfter(run.argv, '--allowedTools').includes('mcp__wowdata'));
    }
    assert.equal(h.bridge.output.match(/wowdata: no synced game data/g).length, 1);
  });
});
