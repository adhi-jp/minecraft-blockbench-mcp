// Tests for the shared config-path resolver and the plugin's rendezvous
// config-file source: source precedence, schema validation, the permission
// state machine (one prompt per session, handle retention, silent probes
// after deny), rotation pickup, and the session-level wiring against a real
// adapter-side WsBridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import WsClient from 'ws';

import {
  defaultConfigPathFromUserData,
  parentDirectory,
  resolveDefaultConfigPath,
} from '../src/shared/config-path.js';
import { RendezvousSource, type RendezvousFsLike } from '../src/plugin/rendezvous.js';
import { WsBridge } from '../src/adapter/ws-bridge.js';
import { PluginSession, type WebSocketLike } from '../src/plugin/session.js';

const CONFIG_PATH = '/cfg/minecraft-blockbench-mcp/config.json';
const FILE_SECRET = 'file-secret-9a8b7c6d5e4f3a2b';

test('resolveDefaultConfigPath follows the per-platform table with host-independent separators', () => {
  assert.equal(
    resolveDefaultConfigPath({ platform: 'linux', xdgConfigHome: '/xdg' }),
    '/xdg/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    resolveDefaultConfigPath({ platform: 'linux', home: '/home/u' }),
    '/home/u/.config/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(resolveDefaultConfigPath({ platform: 'linux' }), null);
  assert.equal(
    resolveDefaultConfigPath({ platform: 'darwin', home: '/Users/u' }),
    '/Users/u/Library/Application Support/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    resolveDefaultConfigPath({ platform: 'win32', appData: 'C:\\Users\\u\\AppData\\Roaming' }),
    'C:\\Users\\u\\AppData\\Roaming\\minecraft-blockbench-mcp\\config.json',
  );
  assert.equal(
    resolveDefaultConfigPath({ platform: 'win32', userProfile: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\minecraft-blockbench-mcp\\config.json',
  );
  assert.equal(resolveDefaultConfigPath({ platform: 'win32' }), null);
});

test('parentDirectory and the userData derivation preserve separator style', () => {
  assert.equal(parentDirectory('/home/u/.config/Blockbench'), '/home/u/.config');
  assert.equal(parentDirectory('C:\\Users\\u\\AppData\\Roaming\\Blockbench'), 'C:\\Users\\u\\AppData\\Roaming');
  assert.equal(parentDirectory('/config.json'), '/', 'a root-adjacent path keeps the root as its parent');
  assert.equal(
    parentDirectory('\\\\wsl.localhost\\Ubuntu\\home\\u\\.config\\minecraft-blockbench-mcp\\config.json'),
    '\\\\wsl.localhost\\Ubuntu\\home\\u\\.config\\minecraft-blockbench-mcp',
    'UNC prefixes are preserved',
  );
  assert.equal(
    defaultConfigPathFromUserData('/home/u/.config/Blockbench'),
    '/home/u/.config/minecraft-blockbench-mcp/config.json',
  );
  assert.equal(
    defaultConfigPathFromUserData('C:\\Users\\u\\AppData\\Roaming\\Blockbench'),
    'C:\\Users\\u\\AppData\\Roaming\\minecraft-blockbench-mcp\\config.json',
  );
});

interface FakeAcquireWorld {
  files: Map<string, string>;
  promptCalls: number;
  silentCalls: number;
  grant: 'always' | 'deny';
}

function makeSource(world: FakeAcquireWorld, overrides?: {
  explicitPath?: () => string;
  settingsSecret?: () => string;
  defaultPath?: () => string | null;
}) {
  const fs: RendezvousFsLike = {
    readFileSync: (path) => {
      const content = world.files.get(path as string);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    existsSync: (path) => world.files.has(path as string),
  };
  return new RendezvousSource({
    acquireFs: (_scope, allowPrompt) => {
      if (allowPrompt) {
        world.promptCalls += 1;
        return world.grant === 'always' ? fs : null;
      }
      world.silentCalls += 1;
      return null; // no persisted grant in these tests
    },
    defaultPath: overrides?.defaultPath ?? (() => CONFIG_PATH),
    explicitPath: overrides?.explicitPath ?? (() => ''),
    settingsSecret: overrides?.settingsSecret ?? (() => ''),
    settingsPort: () => 39731,
  });
}

function validFile(secret = FILE_SECRET, port = 40021): string {
  return JSON.stringify({ version: 1, mode: 'shared-secret', port, secret });
}

test('non-empty settings secret wins and never touches the file', () => {
  const world: FakeAcquireWorld = { files: new Map(), promptCalls: 0, silentCalls: 0, grant: 'always' };
  const source = makeSource(world, { settingsSecret: () => 'typed-secret' });
  const snap = source.snapshot();
  assert.equal(snap.source, 'settings');
  assert.equal(snap.secret, 'typed-secret');
  assert.equal(world.promptCalls + world.silentCalls, 0, 'no permission activity for settings users');
});

test('the file is the source when settings are empty; its valid port is used', () => {
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile()]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const source = makeSource(world);
  const snap = source.snapshot();
  assert.equal(snap.source, 'file');
  assert.equal(snap.secret, FILE_SECRET);
  assert.equal(snap.port, 40021);
  assert.equal(snap.path, CONFIG_PATH);
});

test('an invalid port in the file falls back to the settings port', () => {
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, JSON.stringify({ version: 1, secret: FILE_SECRET, port: 999999 })]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const snap = makeSource(world).snapshot();
  assert.equal(snap.source, 'file');
  assert.equal(snap.port, 39731);
});

test('unrecognized version or mode degrades like an unreadable file', () => {
  for (const content of [
    JSON.stringify({ version: 2, secret: FILE_SECRET }),
    JSON.stringify({ version: 1, mode: 'pairing', secret: FILE_SECRET }),
    JSON.stringify({ version: 1, mode: 'shared-secret', secret: '' }),
    '{not json',
  ]) {
    const world: FakeAcquireWorld = {
      files: new Map([[CONFIG_PATH, content]]),
      promptCalls: 0,
      silentCalls: 0,
      grant: 'always',
    };
    const snap = makeSource(world).snapshot();
    assert.equal(snap.source, 'none');
    assert.equal(snap.detail, 'invalid-format');
    assert.equal(snap.secret, '');
  }
});

test('missing file and underivable path degrade without prompting twice', () => {
  const world: FakeAcquireWorld = { files: new Map(), promptCalls: 0, silentCalls: 0, grant: 'always' };
  const source = makeSource(world);
  assert.equal(source.snapshot().detail, 'missing');
  const noPath = makeSource(world, { defaultPath: () => null }).snapshot();
  assert.equal(noPath.detail, 'no-path');
});

test('one prompt per session: a grant is retained and re-used across snapshots and rotation is picked up', () => {
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile('secret-a-1234567890abcdef')]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const source = makeSource(world);
  assert.equal(source.snapshot().secret, 'secret-a-1234567890abcdef');
  world.files.set(CONFIG_PATH, validFile('secret-b-1234567890abcdef'));
  for (let i = 0; i < 5; i++) {
    assert.equal(source.snapshot().secret, 'secret-b-1234567890abcdef', 'rotation must be picked up');
  }
  assert.equal(world.promptCalls, 1, 'exactly one dialog-mode acquisition for the whole session');
  assert.equal(world.silentCalls, 0, 'the retained handle serves every later read');
});

test('after a deny the reconnect loop only probes silently; a config-path change re-arms one prompt', () => {
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile()]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'deny',
  };
  const source = makeSource(world);
  assert.equal(source.snapshot().detail, 'declined');
  for (let i = 0; i < 10; i++) {
    assert.equal(source.snapshot().detail, 'not-granted');
  }
  assert.equal(world.promptCalls, 1, 'the backoff loop must never show another dialog');
  assert.equal(world.silentCalls, 10);

  source.noteConfigPathChanged();
  source.snapshot();
  assert.equal(world.promptCalls, 2, 'an explicit user gesture re-arms exactly one prompt');
});

test('describe() names the active source without touching the filesystem', () => {
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile()]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const source = makeSource(world);
  source.snapshot();
  assert.ok(source.describe().includes(CONFIG_PATH));
  const before = world.promptCalls + world.silentCalls;
  source.describe();
  assert.equal(world.promptCalls + world.silentCalls, before);
});

test('describe() covers every source state with actionable text and no secrets', () => {
  const settingsWorld: FakeAcquireWorld = { files: new Map(), promptCalls: 0, silentCalls: 0, grant: 'always' };
  const settingsSource = makeSource(settingsWorld, { settingsSecret: () => 'typed-secret-xyz' });
  settingsSource.snapshot();
  assert.match(settingsSource.describe(), /plugin settings/);
  assert.ok(!settingsSource.describe().includes('typed-secret-xyz'));

  const deniedWorld: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile()]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'deny',
  };
  const deniedSource = makeSource(deniedWorld);
  deniedSource.snapshot();
  assert.match(deniedSource.describe(), /not granted/);
  assert.match(deniedSource.describe(), /MCP Config File Path/);

  const noPathSource = makeSource(settingsWorld, { defaultPath: () => null });
  noPathSource.snapshot();
  assert.match(noPathSource.describe(), /not configured/);

  const missingWorld: FakeAcquireWorld = { files: new Map(), promptCalls: 0, silentCalls: 0, grant: 'always' };
  const missingSource = makeSource(missingWorld);
  missingSource.snapshot();
  assert.match(missingSource.describe(), /not found/);

  const invalidWorld: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, '{not json']]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const invalidSource = makeSource(invalidWorld);
  invalidSource.snapshot();
  assert.match(invalidSource.describe(), /unrecognized format/);
});

test('a read failure after a positive existence check degrades as unreadable', () => {
  const fs: RendezvousFsLike = {
    readFileSync: () => {
      throw new Error('EACCES');
    },
    existsSync: () => true,
  };
  const source = new RendezvousSource({
    acquireFs: () => fs,
    defaultPath: () => CONFIG_PATH,
    explicitPath: () => '',
    settingsSecret: () => '',
    settingsPort: () => 39731,
  });
  const snap = source.snapshot();
  assert.equal(snap.detail, 'unreadable');
  assert.match(source.describe(), /could not be read/);
});

// --- Session-level wiring: real bridge on one end, rendezvous-fed session on the other ---

let nextPort = 40750;

test('the session connects with the file secret and picks up rotations before and after a successful connect', async (t) => {
  const port = nextPort++;
  const STALE_SECRET = 'rotated-away-secret-0001111';
  const SECOND_SECRET = 'second-file-secret-2b3c4d5e';
  const world: FakeAcquireWorld = {
    files: new Map([[CONFIG_PATH, validFile(STALE_SECRET, port)]]),
    promptCalls: 0,
    silentCalls: 0,
    grant: 'always',
  };
  const source = makeSource(world);

  const bridgeOptions = {
    port,
    requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 100,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 500,
    maxMessageBytes: 1024 * 1024,
    log: () => {},
  };
  // The bridge only accepts FILE_SECRET, so a successful connect proves the
  // session re-read the file on a later attempt.
  let bridge = new WsBridge({ ...bridgeOptions, secret: FILE_SECRET });
  assert.deepEqual(await bridge.start(), { ok: true });
  t.after(() => bridge.stop());

  const logLines: string[] = [];
  const statuses: string[] = [];
  let snapshot: ReturnType<RendezvousSource['snapshot']> | null = null;
  const session: PluginSession = new PluginSession({
    createWebSocket: (url) => new WsClient(url) as unknown as WebSocketLike,
    url: () => `ws://127.0.0.1:${(snapshot ?? source.snapshot()).port}`,
    secret: () => {
      if (session.status !== 'authenticating' || snapshot === null) snapshot = source.snapshot();
      return snapshot.secret;
    },
    pluginVersion: '0.1.0',
    blockbenchVersion: () => '5.1.4',
    capabilities: () => ['java_block'],
    backoffInitialMs: 50,
    backoffMaxMs: 100,
    onStatusChange: (status) => statuses.push(status),
    onLog: (line) => logLines.push(line),
  });
  t.after(() => session.stop());
  session.start();

  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 3_000) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // Observe a failed attempt with the stale secret, then rotate and connect.
  await waitFor(() => statuses.includes('auth_failed'), 'stale secret must be rejected first');
  world.files.set(CONFIG_PATH, validFile(FILE_SECRET, port));
  await waitFor(() => session.status === 'connected', 'connect after pre-connect rotation');

  // Rotate again while connected: restart the bridge with the new secret,
  // rewrite the file, and the session must reconnect using the new value.
  await bridge.stop();
  bridge = new WsBridge({ ...bridgeOptions, secret: SECOND_SECRET });
  assert.deepEqual(await bridge.start(), { ok: true });
  world.files.set(CONFIG_PATH, validFile(SECOND_SECRET, port));
  await waitFor(() => session.status === 'connected' && bridge.connected, 'reconnect after post-connect rotation');

  assert.equal(world.promptCalls, 1, 'every reconnect attempt reuses the retained handle');
  const allLogs = logLines.join('\n');
  for (const secret of [FILE_SECRET, STALE_SECRET, SECOND_SECRET]) {
    assert.ok(!allLogs.includes(secret), 'file secrets must never appear in plugin logs');
    assert.ok(!allLogs.includes(secret.slice(0, 12)));
  }
});
