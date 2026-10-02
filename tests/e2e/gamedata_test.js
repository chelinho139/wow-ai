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
  return Promise.resolve(new Response(fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
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
    const config = askRun.mcpConfig;
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

test('a wowdata server that fails to start is logged and named in the reply', async () => {
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    const failed = await h.client.say('[[mcp-fail wowdata]] where is the vale roost');
    await h.bridge.waitForLine(/MCP server\(s\) not connected: wowdata \(failed\)/);
    assert.match(failed.text, /game data server \(wowdata\) did not start \(failed\)/);
    const fine = await h.client.say('where is the vale roost');
    assert.doesNotMatch(fine.text, /did not start/);
  });
});

const ERA_FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago-era');
const ERA_CLIENT = { version: '1.15.9', build: '70003', interface: 11509 };

function eraFetch(url) {
  const u = new URL(url);
  if (u.pathname === '/api/builds') return Promise.resolve(new Response(fs.readFileSync(path.join(ERA_FIXTURES, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } }));
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(ERA_FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

test('a Classic Era client gets the Classic Era data server, never the Forever one', async () => {
  const beforeLaunch = async sb => {
    const dataDir = path.join(sb.home, 'data');
    await D.sync({ dataDir, build: BUILD, fetch: fixtureFetch });
    await D.sync({ dataDir, flavor: 'classic_era', fetch: eraFetch });
  };
  await withGame({ plugin: 'ask', client: ERA_CLIENT, tocInterface: ERA_CLIENT.interface, beforeLaunch }, async h => {
    await h.client.say('where is the vale roost');
    const [askRun] = h.agentCalls();
    const server = askRun.mcpConfig.mcpServers.wowdata;
    assert.deepEqual(server.args.slice(-2), ['--client-build', '1.15.9.70003']);
    await h.bridge.waitForLine(/wowdata 1\.15\.9\.300 classic_era/);
  });
});

test('a Classic Era client with only Forever data synced runs without a data server and says which sync it needs', async () => {
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', client: ERA_CLIENT, tocInterface: ERA_CLIENT.interface, beforeLaunch }, async h => {
    await h.client.say('hello');
    await h.client.say('hello again');
    for (const run of h.agentCalls()) {
      assert.deepEqual(Object.keys(run.mcpConfig.mcpServers), ['wowgoals'], 'no Forever answers for an Era client');
      assert.ok(!listAfter(run.argv, '--allowedTools').includes('mcp__wowdata'));
    }
    assert.equal(h.bridge.output.match(/wowdata: no synced game data for Classic Era under .*\(claude-wow data sync --flavor classic_era\)/g).length, 1);
  });
});

test('with no synced data, ask runs go without the server and the bridge says why once', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('hello');
    await h.client.say('hello again');
    for (const run of h.agentCalls()) {
      assert.deepEqual(Object.keys(run.mcpConfig.mcpServers), ['wowgoals']);
      assert.ok(!listAfter(run.argv, '--allowedTools').includes('mcp__wowdata'));
    }
    assert.equal(h.bridge.output.match(/wowdata: no synced game data/g).length, 1);
  });
});

test('a reply keeps a spell token the player linked earlier in the chat, shows an unlinked one as plain text, and logs item IDs the data lacks', async () => {
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    await h.client.say('is this good [Frostbolt]\n\n--- Linked from the game ---\n[Frostbolt] spell 116 [[reply ok]]');
    const r = await h.client.say('and now [[reply cast {spell:116} not {spell:12294}, buy {item:501} not {item:999999}]]');
    assert.equal(r.text, 'cast {spell:116} not spell 12294 (unverified), buy {item:501} not {item:999999}');
    await h.bridge.waitForLine(/reply tokens: 1 spell token\(s\) not linked in this chat, shown as plain text: spell:12294$/m, { from: 0 });
    await h.bridge.waitForLine(/reply tokens: 1 ID\(s\) the client will show gray: item:999999 \(not in the forever 1\.60\.1\.200 data\)/, { from: 0 });
  });
});
