# Design

## Source of truth
Status: Active. Refreshed 2026-11-09. Surfaces: native WoW addon and bridge configuration. Evidence: user redesign brief and screenshot; addon/WoWAI/WoWAI.lua; rust/bridge/src/agents.rs; rust/bridge/src/protocol.rs; tests/addon_test.js.

## Brand
Compact Warcraft quest journal, restrained gold, quiet near-opaque reading surface. Preserve native frame controls.

## Product goals
Ask game questions without leaving play; recover without losing drafts; know which backend handles the next message. Preserve existing transcripts and transport.

## Personas and jobs
Players seeking quest, item and mechanic help; developers using separate chats and configurations.

## Information architecture
Header: title, chat picker, next-request selector, labeled connection state. History: New chat and contextual actions. Transcript above persistent composer. Settings contains defaults and copyable diagnostics.

## Design principles
Show confirmed configuration only. Keep technical details available outside routine play. Preserve original replies for copying; never invent structured summaries from arbitrary text.

## Visual language
Window #141311, rail #1B1916, transcript #211E1A, border #4A4033. Body #F2EBDD, secondary #B9AEA0, gold #E5BE72, player #A8CBE8. Native fonts, body 14, title 18. Spacing 4/8/12/16; controls 28–32; rail 210; reading column max 800 effective units.

## Components
Extend existing native buttons, bubbles, menu, copy dialog and connection state. AgentSelector uses advertised bridge capabilities. RecoveryRow shares existing connection state. No dependency additions.

## Accessibility
Text accompanies status colors. Keyboard: Enter sends, Shift+Enter inserts newline, Escape releases focus. Copy dialog supports external URLs. Native links and insertion hooks remain functional.

## Responsive behavior
At frame width below 780 effective units hide history by default; chat picker can open it. Remember explicit rail preference. Selector stays reachable. Actual client font metrics and UI scale need verification.

## Interaction states
Offline drafts remain editable, recovery action beside explanation. Sending and waiting follow existing acknowledgment state. Backend changes affect next request and start a new session while retaining visible history. Reading history must not jump on reply updates.

## Content voice
Plain, short labels: Send, Reconnect, Bridge default, Working folder, Clear transcript. Errors explain recovery.

## Implementation constraints
Native Lua frames only, existing pixel/reload transports and reply slots. Capability gate overrides for older bridges. No polling loops or protected actions added. Node tests execute addon Lua through Fengari; visual, combat and real keyboard behavior require WoW.

## Open questions
- In-game validation: bright scenes, UI scales, font metrics, resize anchor, combat and keyboard focus.
- Screenshot “Screen Captured” ownership is unconfirmed; do not alter external feedback.
- Legacy bridges without versioned capabilities use agent-only fallback.
