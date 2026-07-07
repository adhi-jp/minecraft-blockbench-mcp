// Blockbench plugin entry point: registers the plugin, the port/secret
// settings, the connection status / scope revocation actions, and wires the
// WebSocket session core to Blockbench. Command handlers attach to the
// session via registerHandler.
import { DEFAULT_WS_PORT, PROTOCOL_VERSION } from '../shared/protocol.js';
import { PluginSession } from './session.js';
import { ScopeManager, type ScopedFsLike } from './scope-manager.js';
import { registerModelCommands } from './commands/model-commands.js';

const PLUGIN_ID = 'minecraft_blockbench_mcp';
const PLUGIN_VERSION = '0.1.0';
const SETTING_PORT = `${PLUGIN_ID}_port`;
const SETTING_SECRET = `${PLUGIN_ID}_secret`;
const MEMO_KEY = `${PLUGIN_ID}.last_confirmed_scope`;

interface PluginRuntime {
  session: PluginSession;
  scope: ScopeManager;
  settings: Setting[];
  actions: Action[];
}

let runtime: PluginRuntime | null = null;

function currentPort(): number {
  const raw = Number(Settings.get(SETTING_PORT));
  return Number.isInteger(raw) && raw >= 1 && raw <= 65_535 ? raw : DEFAULT_WS_PORT;
}

function currentSecret(): string {
  const raw = Settings.get(SETTING_SECRET);
  return typeof raw === 'string' ? raw : '';
}

function confirmScopeDialog(normalizedPath: string, reason: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    Blockbench.showMessageBox(
      {
        title: 'Minecraft Blockbench MCP: scoped directory',
        message:
          `The connected AI client asks for file access limited to this directory:\n\n` +
          `**${normalizedPath}**\n\n` +
          (reason !== undefined ? `Reason: ${reason}\n\n` : '') +
          `AI file reads and writes will be restricted to this directory until you revoke it, ` +
          `reload the plugin, or restart Blockbench.`,
        buttons: ['Allow this session', 'Deny'],
        confirm: 0,
        cancel: 1,
      },
      (button) => {
        resolve(button === 0 || button === 'confirm');
      },
    );
  });
}

function acquireScopedFs(normalizedPath: string): ScopedFsLike | null {
  const fs = requireNativeModule('fs', {
    scope: normalizedPath,
    message: 'Used to read and write Minecraft model files in the directory you approved for the MCP session.',
  });
  return fs === undefined ? null : (fs as unknown as ScopedFsLike);
}

function setupRuntime(): PluginRuntime {
  // Changing the port or secret reconnects immediately instead of waiting out
  // the current backoff window.
  const reconnectOnChange = () => runtime?.session.reconnectNow();
  const settings: Setting[] = [
    new Setting(SETTING_PORT, {
      name: 'MCP Adapter Port',
      description: 'Local port of the MCP adapter WebSocket endpoint (default 39731).',
      category: 'general',
      type: 'number',
      value: DEFAULT_WS_PORT,
      onChange: reconnectOnChange,
    }),
    new Setting(SETTING_SECRET, {
      name: 'MCP Shared Secret',
      description: 'Shared secret that authenticates this plugin to the local MCP adapter.',
      category: 'general',
      type: 'password',
      value: '',
      onChange: reconnectOnChange,
    }),
  ];

  const session = new PluginSession({
    createWebSocket: (url) => new WebSocket(url),
    url: () => `ws://127.0.0.1:${currentPort()}`,
    secret: currentSecret,
    pluginVersion: PLUGIN_VERSION,
    blockbenchVersion: () => Blockbench.version,
    capabilities: ['java_block'],
    onStatusChange: (status) => {
      if (status === 'connected') {
        Blockbench.showQuickMessage('MCP adapter connected', 1500);
        session.sendEvent('scope_changed', scope.status);
      }
      if (status === 'auth_failed') {
        Blockbench.showQuickMessage('MCP adapter rejected the connection - check port/secret settings', 3000);
      }
    },
    onLog: (line) => console.log(`[${PLUGIN_ID}]`, line),
  });

  const scope = new ScopeManager({
    confirmDialog: confirmScopeDialog,
    acquireScopedFs,
    memo: {
      get: () => localStorage.getItem(MEMO_KEY),
      set: (path) => {
        if (path === null) {
          localStorage.removeItem(MEMO_KEY);
        } else {
          localStorage.setItem(MEMO_KEY, path);
        }
      },
    },
    onScopeChanged: (status) => session.sendEvent('scope_changed', status),
  });

  session.registerHandler('get_plugin_status', () => ({
    plugin_version: PLUGIN_VERSION,
    blockbench_version: Blockbench.version,
    protocol_version: PROTOCOL_VERSION,
    capabilities: ['java_block'],
    scope: scope.status,
  }));

  session.registerHandler('propose_scoped_directory', async (params) => {
    const { path, reason } = params as { path: string; reason?: string };
    return scope.propose(path, reason);
  });

  registerModelCommands(session, scope);

  const actions: Action[] = [
    new Action(`${PLUGIN_ID}_status`, {
      name: 'MCP Connection Status',
      description: 'Show the Minecraft Blockbench MCP connection and scoped-directory status.',
      icon: 'hub',
      click() {
        const scopeStatus = scope.status;
        Blockbench.showMessageBox({
          title: 'Minecraft Blockbench MCP',
          message:
            `Session: ${runtime?.session.status ?? 'unknown'}\n\n` +
            `Scoped directory: ${scopeStatus.state}` +
            (scopeStatus.normalized_path !== undefined ? ` (${scopeStatus.normalized_path})` : ''),
        });
      },
    }),
    new Action(`${PLUGIN_ID}_revoke_scope`, {
      name: 'Revoke MCP Scoped Directory',
      description: 'Immediately revoke the directory the AI client may read and write in this session.',
      icon: 'block',
      click() {
        scope.revoke();
        Blockbench.showQuickMessage('MCP scoped directory revoked', 2000);
      },
    }),
  ];
  for (const action of actions) {
    MenuBar.menus.tools.addAction(action);
  }

  return { session, scope, settings, actions };
}

BBPlugin.register(PLUGIN_ID, {
  title: 'Minecraft Blockbench MCP',
  author: 'adhi-jp',
  description:
    'Connects Blockbench to a local MCP adapter so AI clients can create and edit Minecraft Java block/item models.',
  icon: 'hub',
  version: PLUGIN_VERSION,
  variant: 'desktop',
  onload() {
    runtime = setupRuntime();
    runtime.session.start();
    console.log(`[${PLUGIN_ID}] loaded`);
  },
  onunload() {
    if (runtime !== null) {
      runtime.session.stop();
      runtime.scope.dispose();
      for (const action of runtime.actions) action.delete();
      for (const setting of runtime.settings) setting.delete();
      runtime = null;
    }
    console.log(`[${PLUGIN_ID}] unloaded`);
  },
});
