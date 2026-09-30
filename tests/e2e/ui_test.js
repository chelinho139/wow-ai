'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('ui');
const withGame = gameRunner(ROOT);

test('whisper-first: a message typed in the chat tab shows one progress line, then the start of a long reply with a full-reply link that opens the workspace', async () => {
  await withGame({ client: { chatDock: true } }, async h => {
    const c = h.client;
    await c.connect();
    const chat = c.activeChat().id;
    await c.waitFor(() => c.tabFor(chat), { label: 'the chat\'s whisper tab at login' });
    assert.equal(c.windowRect().shown, false, 'the workspace stays closed');

    const id = c.lastSeq() + 1;
    c.typeInTab('[[tools 4]] [[sleep 3]] [[long 60]] what is new?');
    await c.waitFor(() => c.tabLines(chat).some(l => / is working\.\.\. /.test(l)), { label: 'the progress line' });
    await c.waitFor(() => c.tabLines(chat).some(l => /\d+ actions?/.test(l)), { timeoutMs: 30000, label: 'the action count on the progress line' });
    assert.equal(c.tabLines(chat).filter(l => / is working\.\.\. /.test(l)).length, 1, 'progress is one line, edited in place');

    await c.waitFor(() => {
      const ch = c.activeChat();
      return !ch.pendingId && (ch.history || []).find(m => m.id === id && m.role === 'assistant');
    }, { timeoutMs: 60000, label: 'the reply' });
    await c.waitFor(() => c.tabLines(chat).some(l => /\[full reply\]/.test(l)), { label: 'the reply in the tab' });
    const lines = c.tabLines(chat);
    assert.ok(lines.some(l => /\[Claude\]\|h whispers: echo \(turn 1\)/.test(l)), lines.join('\n'));
    assert.ok(!lines.some(l => / is working\.\.\. /.test(l)), 'the progress line is gone');
    assert.ok(lines.every(l => l.length < 600), 'no giant line: the long text stays in the workspace');
    assert.equal(c.windowRect().shown, false);

    c.clickLink(`addon:claudewow:open:${chat}`);
    assert.equal(c.windowRect().shown, true, 'the link opens the workspace');
  });
});

test('the workspace steps aside for the character sheet, dims while moving and in combat, and steps away from the game menu', async () => {
  await withGame({ client: { chatDock: true } }, async h => {
    const c = h.client;
    await c.connect();
    c.slash('/claude-wow');
    await c.waitFor(() => c.windowRect().shown, { label: 'the workspace' });
    const home = c.windowRect();

    c.showPanel('CharacterFrame', 16, 1000, 700, 600);
    await c.waitFor(() => c.windowRect().left === 724, { label: 'the window beside the character sheet' });
    c.hidePanel('CharacterFrame');
    await c.waitFor(() => c.windowRect().left === home.left, { label: 'the window back home' });

    c.move(true);
    await c.waitFor(() => Math.abs(c.windowRect().alpha - 0.35) < 1e-6, { label: 'dimmed while moving' });
    c.hover('ClaudeWoWFrame');
    await c.waitFor(() => c.windowRect().alpha === 1, { label: 'opaque under the mouse' });
    c.hover(null);
    c.move(false);
    await c.waitFor(() => c.windowRect().alpha === 1, { label: 'back when stopped' });

    c.combat(true);
    c.showPanel('CharacterFrame');
    await c.waitFor(() => c.windowRect().left === 724 && Math.abs(c.windowRect().alpha - 0.35) < 1e-6, { label: 'dodged and dimmed in combat' });
    c.hidePanel('CharacterFrame');
    c.combat(false);
    await c.waitFor(() => c.windowRect().alpha === 1 && c.windowRect().left === home.left, { label: 'combat over' });
    assert.deepEqual(c.json('STUB.blocked'), [], 'no protected frame touched');

    c.showPanel('GameMenuFrame', 760, 700, 400, 400);
    await c.waitFor(() => !c.windowRect().shown, { label: 'hidden under the game menu' });
    c.hidePanel('GameMenuFrame');
    await c.waitFor(() => c.windowRect().shown, { label: 'back after the menu' });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
