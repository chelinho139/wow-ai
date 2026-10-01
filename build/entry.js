// The compiled binary's entry point (build.js: bun build --compile). Bun
// embeds a file imported with { type: 'file' } and resolves the import to the
// file's path inside the binary; bridge/assets.js reads them from there and
// writes them out where python and the game can see them. The list is
// assets.FILES, one import per file (tests/assets_test.js keeps the two in
// step). Then the supervisor, which is the claude-wow command. Bun only:
// from a checkout, node runs bridge/supervisor.js directly.
import addonLua from '../addon/ClaudeWoW/ClaudeWoW.lua' with { type: 'file' };
import addonToc from '../addon/ClaudeWoW/ClaudeWoW.toc' with { type: 'file' };
import addonCodec from '../addon/ClaudeWoW/Codec.lua' with { type: 'file' };
import addonInbox from '../addon/ClaudeWoW/Inbox.lua' with { type: 'file' };
import addonMap from '../addon/ClaudeWoW/Map.lua' with { type: 'file' };
import addonRoast from '../addon/ClaudeWoW/Roast.lua' with { type: 'file' };
import addonStream from '../addon/ClaudeWoW/Stream.lua' with { type: 'file' };
import addonVoice from '../addon/ClaudeWoW/Voice.lua' with { type: 'file' };
import addonLootRoll from '../addon/ClaudeWoW/LootRoll.lua' with { type: 'file' };
import addonAchievements from '../addon/ClaudeWoW/Achievements.lua' with { type: 'file' };
import addonOrders from '../addon/ClaudeWoW/Orders.lua' with { type: 'file' };
import addonWidgets from '../addon/ClaudeWoW/Widgets.lua' with { type: 'file' };
import addonWindow from '../addon/ClaudeWoW/Window.lua' with { type: 'file' };
import addonTelemetry from '../addon/ClaudeWoW/Telemetry.lua' with { type: 'file' };
import addonObserved from '../addon/ClaudeWoW/Observed.lua' with { type: 'file' };
import addonBindings from '../addon/ClaudeWoW/Bindings.xml' with { type: 'file' };
import addonPortrait from '../addon/ClaudeWoW/Portrait.tga' with { type: 'file' };
import capturePs1 from '../bridge/capture.ps1' with { type: 'file' };
import captureMac from '../bridge/capture_mac.py' with { type: 'file' };
import captureX11 from '../bridge/capture_x11.py' with { type: 'file' };
import configExample from '../bridge/config.example.json' with { type: 'file' };
import primer from '../docs/WOW-ADDON-PRIMER.md' with { type: 'file' };

require('../bridge/assets').embed({
  'addon/ClaudeWoW/ClaudeWoW.lua': addonLua,
  'addon/ClaudeWoW/ClaudeWoW.toc': addonToc,
  'addon/ClaudeWoW/Codec.lua': addonCodec,
  'addon/ClaudeWoW/Inbox.lua': addonInbox,
  'addon/ClaudeWoW/Map.lua': addonMap,
  'addon/ClaudeWoW/Roast.lua': addonRoast,
  'addon/ClaudeWoW/Stream.lua': addonStream,
  'addon/ClaudeWoW/Voice.lua': addonVoice,
  'addon/ClaudeWoW/LootRoll.lua': addonLootRoll,
  'addon/ClaudeWoW/Achievements.lua': addonAchievements,
  'addon/ClaudeWoW/Orders.lua': addonOrders,
  'addon/ClaudeWoW/Widgets.lua': addonWidgets,
  'addon/ClaudeWoW/Window.lua': addonWindow,
  'addon/ClaudeWoW/Telemetry.lua': addonTelemetry,
  'addon/ClaudeWoW/Observed.lua': addonObserved,
  'addon/ClaudeWoW/Bindings.xml': addonBindings,
  'addon/ClaudeWoW/Portrait.tga': addonPortrait,
  'bridge/capture.ps1': capturePs1,
  'bridge/capture_mac.py': captureMac,
  'bridge/capture_x11.py': captureX11,
  'bridge/config.example.json': configExample,
  'docs/WOW-ADDON-PRIMER.md': primer,
});
require('../bridge/supervisor');
