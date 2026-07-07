// Blockbench plugin entry point. The WebSocket session, settings UI,
// scoped-directory manager, and command handlers are not wired up yet.
import { PROTOCOL_VERSION } from '../shared/protocol.js';

const PLUGIN_ID = 'minecraft_blockbench_mcp';

// BBPlugin is Blockbench's runtime alias for its Plugin class; the bare name
// `Plugin` collides with the DOM's Plugin interface in TypeScript.
BBPlugin.register(PLUGIN_ID, {
  title: 'Minecraft Blockbench MCP',
  author: 'adhi-jp',
  description:
    'Connects Blockbench to a local MCP adapter so AI clients can create and edit Minecraft Java block/item models.',
  icon: 'hub',
  version: '0.1.0',
  variant: 'desktop',
  onload() {
    console.log(`[${PLUGIN_ID}] loaded (protocol v${PROTOCOL_VERSION})`);
  },
  onunload() {
    console.log(`[${PLUGIN_ID}] unloaded`);
  },
});
