'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const P = require('../bridge/protocol');
const PL = require('../bridge/plugins');
const stream = require('../bridge/plugins/stream');

function fakeCore(options) {
  const calls = [];
  const core = {
    log: () => {},
    tag: j => '#' + j.id,
    options: id => (id === 'stream' ? options : {}),
    reply: (job, text) => calls.push({ reply: text }),
    fail: (job, text) => calls.push({ fail: text }),
    runAgent: () => calls.push({ run: true }),
  };
  return { core, calls };
}

function controlServer(answer) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(JSON.parse(raw))));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` })));
}

function closedPort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

test('stream plugin: routes stream-kind records and registers next to the others', () => {
  assert.equal(stream.match({ kind: 'stream' }), true);
  assert.equal(stream.match({ kind: 'roast' }), false);
  assert.equal(stream.match({}), false);
  const registry = PL.createRegistry();
  registry.register(require('../bridge/plugins/ask'));
  registry.register(require('../bridge/plugins/roast'));
  registry.register(stream);
  assert.equal(registry.route({ text: '{"action":"scene","scene":"Raid"}', kind: 'stream' }).plugin.id, 'stream');
  assert.equal(registry.route({ text: 'hi', plugin: 'stream' }).plugin.id, 'stream');
  const record = ['sess1', 'chat9', '42', '', 'plugin=stream;kind=stream', 'Stream control', '{"action":"pane","pane":"right"}'].join('\x1F');
  const [job] = P.jobsFromStrip(42, record);
  assert.equal(job.kind, 'stream');
  assert.equal(job.text, '{"action":"pane","pane":"right"}');
});

test('stream plugin: a command is POSTed as JSON to <url>/control and the service message is the reply, with no agent run', async () => {
  const svc = await controlServer(cmd => ({ ok: true, message: `Scene: ${cmd.scene}` }));
  try {
    const { core, calls } = fakeCore({ url: svc.url + '/' });
    await stream.handle({ id: 7, kind: 'stream', text: '{"action":"scene","scene":"Raid"}' }, core);
    assert.equal(svc.bodies.length, 1);
    assert.deepEqual(svc.bodies[0], { method: 'POST', url: '/control', type: 'application/json', body: { action: 'scene', scene: 'Raid' } });
    assert.deepEqual(calls, [{ reply: 'Scene: Raid' }]);
  } finally {
    svc.server.close();
  }
});

test('stream plugin: a track update is forwarded whole and answered with an empty ack', async () => {
  const svc = await controlServer(() => ({ ok: true, message: 'Tracking' }));
  try {
    const { core, calls } = fakeCore({ url: svc.url });
    const track = { action: 'track', quest: { id: 33, title: 'Wolves Across the Border', objectives: ['Diseased Timber Wolf slain: 3/8'], complete: false }, chat: { title: 'Raid prep' } };
    await stream.handle({ id: 8, kind: 'stream', text: JSON.stringify(track) }, core);
    assert.deepEqual(svc.bodies[0].body, track);
    assert.deepEqual(calls, [{ reply: '' }]);
  } finally {
    svc.server.close();
  }
});

test('stream plugin: a service that is down gives the not-running reply for commands and a silent ack for tracks', async () => {
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}`;
  const { core, calls } = fakeCore({ url });
  await stream.handle({ id: 9, kind: 'stream', text: '{"action":"pane","pane":"left"}' }, core);
  assert.deepEqual(calls, [{ reply: `Stream service is not running (${url})` }]);
  await stream.handle({ id: 10, kind: 'stream', text: '{"action":"track","quest":null,"chat":null}' }, core);
  assert.deepEqual(calls[1], { reply: '' });
  assert.ok(!calls.some(c => c.run || c.fail));
});

test('stream plugin: the default url, and text that is not a command is answered without a request', async () => {
  assert.equal(stream.serviceUrl({}), 'http://127.0.0.1:4466');
  assert.equal(stream.notRunningText(stream.serviceUrl(undefined)), 'Stream service is not running (http://127.0.0.1:4466)');
  const { core, calls } = fakeCore({});
  await stream.handle({ id: 11, kind: 'stream', text: 'not json' }, core);
  assert.deepEqual(calls, [{ reply: 'Stream: that was not a stream command.' }]);
});

test('stream plugin: enabled false sends nothing, answers commands with one line and tracks with an empty ack', async () => {
  const svc = await controlServer(() => ({ ok: true, message: 'should not be reached' }));
  try {
    const { core, calls } = fakeCore({ enabled: false, url: svc.url });
    await stream.handle({ id: 12, kind: 'stream', text: '{"action":"scene","scene":"Raid"}' }, core);
    await stream.handle({ id: 13, kind: 'stream', text: '{"action":"track","quest":null,"chat":{"title":"Chat 1"}}' }, core);
    assert.equal(svc.bodies.length, 0, 'no request reaches the service');
    assert.deepEqual(calls, [{ reply: 'Stream control is off on this bridge (plugins.stream.enabled is false).' }, { reply: '' }]);
    assert.equal(stream.isEnabled(stream.INERT_OPTIONS), false);
    assert.doesNotMatch(stream.INERT_OPTIONS.url, /:4466\b/);
  } finally {
    svc.server.close();
  }
});
