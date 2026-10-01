'use strict';

function inSlots({ now, shareUntil, held, urgent, size, progressMax }) {
  return (now < shareUntil || held === true) && (urgent || size <= progressMax);
}

function createMapShare({ state, shareMs, now = Date.now, save = () => {} }) {
  let shareUntil = state.map && Object.keys(state.map.layers || {}).length ? now() + shareMs : 0;

  function touch() {
    shareUntil = now() + shareMs;
  }

  function hold() {
    state.mapHeldForGame = true;
    save();
  }

  function release() {
    if (state.mapHeldForGame !== true) return false;
    state.mapHeldForGame = false;
    touch();
    save();
    return true;
  }

  function onRecord(job) {
    if (!job || job.kind === 'gs' || !job.hello) return false;
    return release();
  }

  return {
    touch,
    onRecord,
    hold,
    onReplyPublished: release,
    held: () => state.mapHeldForGame === true,
    shareUntil: () => shareUntil,
    inSlots: ({ urgent, size, progressMax }) => inSlots({ now: now(), shareUntil, held: state.mapHeldForGame, urgent, size, progressMax }),
  };
}

module.exports = { inSlots, createMapShare };
