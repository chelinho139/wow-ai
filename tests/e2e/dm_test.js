'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../../bridge/campaign');
const TL = require('../../bridge/telemetry');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('dm');
const withGame = gameRunner(ROOT);
const CHARACTER = 'Testchar-TestRealm';

function seedCampaign(home) {
  const file = path.join(home, 'goals', CHARACTER, C.CAMPAIGN_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const beat = (id, title, narration, trigger) => ({ id, title, narration, trigger, refs: [], addedAt: 1 });
  fs.writeFileSync(file, JSON.stringify({
    v: C.STORE_VERSION, rev: 1, character: CHARACTER,
    campaign: {
      id: 'c_1', title: 'A letter with no name', startedAt: 1, next: 0, current: null, live: [], fired: [], refs: [],
      beats: [beat('b1', 'A story begins', ['Someone left a letter in your pack.', 'Nobody saw who.'], { type: 'manual' }), beat('b2', 'The quiet road', ['The road is quiet.'], { type: 'zone', mapID: 9101 })],
    },
  }));
  return file;
}

test('/dm next from the real addon fires the waiting beat in the bridge, runs no agent, and the DM frame shows it', async () => {
  await withGame({}, async h => {
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    const file = seedCampaign(h.sb.home);
    await h.client.say('read the slots');
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoWDM.view and ClaudeWoWDM.view.manual') === 'true', { timeoutMs: 45000, label: 'the dm field with manual = true' });
    const calls = h.agentCalls().length;
    const mark = h.bridge.output.length;
    h.client.runLua('SlashCmdList.CLAUDEWOWDM("next")');
    await h.bridge.waitForLine(/\/dm next for Testchar-TestRealm: beat b1 fired/, { from: mark });
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoWDMFrame and ClaudeWoWDMFrame:IsShown() and ClaudeWoWDMFrame.beatTitle:GetText()') === 'A story begins', { timeoutMs: 45000, label: 'the DM frame with the first beat' });
    assert.equal(h.agentCalls().length, calls, 'the record never reached an agent');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.campaign.current, 'b1');
    assert.deepEqual(doc.campaign.fired.map(f => f.by), ['manual']);
    const events = fs.readFileSync(path.join(h.sb.home, 'goals', CHARACTER, TL.EVENTS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(events.some(e => e.type === C.BEAT_EVENT && e.importance === 3));
    assert.doesNotMatch(h.bridge.output.slice(mark), /\[ask\]|runs claude/, 'no agent run started for the record');
    h.client.runLua('SlashCmdList.CLAUDEWOWDM("next")');
    assert.match(h.client.prints().join('\n'), /starts on its own/, 'the zone beat does not wait for /dm next');

    const zoneMark = h.bridge.output.length;
    h.client.runLua('C_Map.GetBestMapForUnit = function() return 9101 end; STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
    await h.client.say('where am I');
    await h.bridge.waitForLine(/campaign: beat b2 fired by zone for Testchar-TestRealm/, { from: zoneMark, timeoutMs: 45000 });
    await h.client.say('and now');
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoWDMFrame.beatTitle:GetText()') === 'The quiet road', { timeoutMs: 45000, label: 'the zone beat on the next slot read' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).campaign.current, 'b2');
  });
});
