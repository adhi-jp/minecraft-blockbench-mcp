// Blockbench plugin entry point: registers the plugin, the port/secret
// settings, the connection status / scope revocation actions, and wires the
// WebSocket session core to Blockbench. Command handlers attach to the
// session via registerHandler.
import { DEFAULT_WS_PORT, PROTOCOL_VERSION } from '../shared/protocol.js';
import { defaultConfigPathFromUserData } from '../shared/config-path.js';
import { PluginSession } from './session.js';
import { RendezvousSource, type RendezvousFsLike, type RendezvousSnapshot } from './rendezvous.js';
import { ScopeManager, type ScopedFsLike } from './scope-manager.js';
import { registerModelCommands } from './commands/model-commands.js';
import { registerGeckolibCommands } from './commands/geckolib-commands.js';
import { geckolibFormatRegistered, detectGeckolibPluginVersion } from './commands/helpers.js';

const PLUGIN_ID = 'minecraft_blockbench_mcp';
const PLUGIN_VERSION = '0.1.0';
const SETTING_PORT = `${PLUGIN_ID}_port`;
const SETTING_SECRET = `${PLUGIN_ID}_secret`;
const SETTING_CONFIG_PATH = `${PLUGIN_ID}_config_path`;
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

/** Evaluated per connect/status call: the GeckoLib plugin may be installed,
 * loaded, or disabled at any time independently of this plugin. */
function currentCapabilities(): string[] {
  const capabilities = ['java_block'];
  if (geckolibFormatRegistered()) capabilities.push('geckolib_model');
  return capabilities;
}

function acquireScopedFs(normalizedPath: string): ScopedFsLike | null {
  const fs = requireNativeModule('fs', {
    scope: normalizedPath,
    message: 'Used to read and write Minecraft model files in the directory you approved for the MCP session.',
  });
  return fs === undefined ? null : (fs as unknown as ScopedFsLike);
}

function acquireRendezvousFs(scopeDirectory: string, allowPrompt: boolean): RendezvousFsLike | null {
  const options: { scope: string; message: string; show_permission_dialog?: boolean } = {
    scope: scopeDirectory,
    message: 'Used to read the MCP connection settings (port and shared secret) that "minecraft-blockbench-mcp setup" wrote.',
  };
  if (!allowPrompt) options.show_permission_dialog = false;
  const fs = requireNativeModule('fs', options as Parameters<typeof requireNativeModule>[1] & { scope: string });
  return fs === undefined || fs === null ? null : (fs as unknown as RendezvousFsLike);
}

function setupRuntime(): PluginRuntime {
  // Changing the port or secret reconnects immediately instead of waiting out
  // the current backoff window. Dropping the snapshot first guarantees the
  // immediate reconnect sees the changed values even mid-handshake.
  let connectSnapshot: RendezvousSnapshot | null = null;
  const reconnectOnChange = () => {
    connectSnapshot = null;
    runtime?.session.reconnectNow();
  };

  const rendezvous = new RendezvousSource({
    acquireFs: acquireRendezvousFs,
    defaultPath: () => {
      const userData = typeof SystemInfo !== 'undefined' ? SystemInfo.user_data_directory : undefined;
      return typeof userData === 'string' && userData !== '' ? defaultConfigPathFromUserData(userData) : null;
    },
    explicitPath: () => {
      const raw = Settings.get(SETTING_CONFIG_PATH);
      return typeof raw === 'string' ? raw.trim() : '';
    },
    settingsSecret: currentSecret,
    settingsPort: currentPort,
  });

  const configPathSetting = new Setting(SETTING_CONFIG_PATH, {
    name: 'MCP Config File Path',
    description:
      'Path of the config file written by "minecraft-blockbench-mcp setup". Leave empty to auto-detect the per-user default location; set it explicitly when Blockbench and the adapter run on different systems (e.g. Windows Blockbench with a WSL adapter).',
    category: 'general',
    type: 'text',
    value: '',
    onChange: () => {
      rendezvous.noteConfigPathChanged();
      reconnectOnChange();
    },
  });
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
    configPathSetting,
  ];

  // One rendezvous snapshot per connect attempt: the session calls secret()
  // as its gate (status is not yet 'authenticating'), then url(), then
  // secret() again inside the hello (status 'authenticating'). Refreshing only
  // outside the authenticating phase gives url and both secret reads one
  // coherent port/secret pair even while the file is being rotated.
  const session = new PluginSession({
    createWebSocket: (url) => new WebSocket(url),
    url: () => `ws://127.0.0.1:${(connectSnapshot ??= rendezvous.snapshot()).port}`,
    secret: () => {
      if (session.status !== 'authenticating' || connectSnapshot === null) {
        connectSnapshot = rendezvous.snapshot();
      }
      return connectSnapshot.secret;
    },
    pluginVersion: PLUGIN_VERSION,
    blockbenchVersion: () => Blockbench.version,
    capabilities: currentCapabilities,
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

  session.registerHandler('get_plugin_status', () => {
    const geckolibVersion = detectGeckolibPluginVersion();
    return {
      plugin_version: PLUGIN_VERSION,
      blockbench_version: Blockbench.version,
      protocol_version: PROTOCOL_VERSION,
      capabilities: currentCapabilities(),
      scope: scope.status,
      ...(geckolibVersion !== undefined ? { geckolib_plugin_version: geckolibVersion } : {}),
    };
  });

  session.registerHandler('propose_scoped_directory', async (params) => {
    const { path, reason } = params as { path: string; reason?: string };
    return scope.propose(path, reason);
  });

  registerModelCommands(session, scope);
  registerGeckolibCommands(session, scope);

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
            `Config source: ${rendezvous.describe()}\n\n` +
            `Scoped directory: ${scopeStatus.state}` +
            (scopeStatus.normalized_path !== undefined ? ` (${scopeStatus.normalized_path})` : ''),
        });
      },
    }),
    new Action(`${PLUGIN_ID}_locate_config`, {
      name: 'Locate MCP Config File',
      description: 'Pick the config file written by "minecraft-blockbench-mcp setup" so the plugin reads the connection settings from it.',
      icon: 'folder_open',
      click() {
        Filesystem.importFile(
          {
            title: 'Locate MCP Config File',
            type: 'MCP Config',
            extensions: ['json'],
            readtype: 'none',
          },
          (files) => {
            const path = files?.[0]?.path;
            if (typeof path === 'string' && path !== '') configPathSetting.set(path);
          },
        );
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
  // The UV commands rely on the UVSizeUtil window global, which older
  // Blockbench versions do not expose; the README requires 5.1.x anyway.
  min_version: '5.1.0',
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
