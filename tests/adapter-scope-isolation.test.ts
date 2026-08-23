// A Blockbench plugin keeps a confirmed scoped directory in memory: it survives
// the WebSocket dropping and reconnecting, and only the user or an explicit
// `revoke_scope` takes it away. An adapter process, by contrast, remembers
// nothing across a restart. Without a rule, a second adapter that attaches to a
// still-running plugin would silently inherit the first one's filesystem
// authorization.
//
// The rule these tests check: every newly authenticated plugin session starts
// with its scoped-directory state unknown, and the adapter relays no public
// command until an internal `revoke_scope` has been acknowledged. A revocation
// that fails keeps commands refused rather than letting them through, and a
// broker that has just started treats its scope state as unknown too.
//
// The plugin side here is the real ScopeManager, so the grant these tests
// inherit and revoke is the same state machine the shipped plugin runs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import WsClient from 'ws';

import { BrokerServer } from '../src/adapter/broker/broker-server.js';
import { computeConfigIdentity, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import { ControllerLease } from '../src/adapter/broker/lease.js';
import { writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import { IPC_PROTOCOL_VERSION } from '../src/adapter/broker/ipc-protocol.js';
import { BrokerClient } from '../src/adapter/broker/broker-client.js';
import { ScopeManager, type ScopedFsLike } from '../src/plugin/scope-manager.js';
import { CommandError, PluginSession, type WebSocketLike } from '../src/plugin/session.js';
import { WsBridge, type BridgeRequestResult } from '../src/adapter/ws-bridge.js';

const SECRET = 'scope-isolation-secret-123456';
const CONFIG_IDENTITY = '89abcdef01234567';
const PACKAGE_VERSION = '0.1.0';
let nextPort = 41_600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(10);
  }
}

type RevocationBehaviour = 'acknowledge' | 'withhold' | 'reject' | 'malformed';

/**
 * Stands in for the scoped filesystem Blockbench hands back once the user
 * confirms a directory. These tests never read or write through it; they only
 * need the grant to reach the `confirmed` state.
 */
const grantedFs: ScopedFsLike = {
  readFileSync: () => '{}',
  writeFileSync: () => undefined,
  existsSync: () => true,
  mkdirSync: () => undefined,
  readdirSync: () => [],
  statSync: () => ({ size: 2 }),
};

/**
 * A plugin running the real scoped-directory state machine, with a revocation
 * handler the test can steer. `relayed` records which public commands actually
 * reached the plugin, which is the channel every "it never got through"
 * assertion below is read from.
 */
class ScopedPlugin {
  readonly relayed: string[] = [];
  readonly revocations: string[] = [];
  readonly scope: ScopeManager;
  readonly session: PluginSession;
  revocationBehaviour: RevocationBehaviour = 'acknowledge';
  #withheld: Array<() => void> = [];

  constructor(port: number) {
    this.scope = new ScopeManager({
      confirmDialog: () => Promise.resolve(true),
      acquireScopedFs: () => grantedFs,
      memo: { get: () => null, set: () => undefined },
    });
    this.session = new PluginSession({
      createWebSocket: (url) => new WsClient(url) as unknown as WebSocketLike,
      url: () => `ws://127.0.0.1:${port}`,
      secret: () => SECRET,
      pluginVersion: PACKAGE_VERSION,
      blockbenchVersion: () => '5.1.4',
      capabilities: () => ['java_block'],
      backoffInitialMs: 20,
      backoffMaxMs: 60,
    });

    this.session.registerHandler('propose_scoped_directory', async (params) => {
      this.relayed.push('propose_scoped_directory');
      const { path, reason } = params as { path: string; reason?: string };
      return this.scope.propose(path, reason);
    });
    this.session.registerHandler('read_file', () => {
      this.relayed.push('read_file');
      if (this.scope.status.state !== 'confirmed') {
        throw new CommandError('E_SCOPE_NOT_CONFIRMED', 'No scoped directory has been confirmed.');
      }
      return { path: 'model.json', content: '{}', encoding: 'utf8', bytes: 2 };
    });
    this.session.registerHandler('get_project_state', () => {
      this.relayed.push('get_project_state');
      return { open: true, format: 'java_block', counts: { cubes: 0, groups: 0, textures: 0 } };
    });
    this.session.registerHandler('revoke_scope', async () => {
      this.revocations.push(this.revocationBehaviour);
      if (this.revocationBehaviour === 'withhold') {
        await new Promise<void>((resolve) => this.#withheld.push(resolve));
      }
      if (this.revocationBehaviour === 'reject') {
        throw new CommandError('E_BLOCKBENCH_ERROR', 'Blockbench could not release the scoped directory.');
      }
      if (this.revocationBehaviour === 'malformed') return { state: 'not-a-real-state' };
      this.scope.revoke();
      return this.scope.status;
    });
  }

  releaseWithheldRevocations(): void {
    const waiting = this.#withheld;
    this.#withheld = [];
    for (const resolve of waiting) resolve();
  }

  countOf(command: string): number {
    return this.relayed.filter((name) => name === command).length;
  }
}

function makeBridge(port: number): WsBridge {
  return new WsBridge({
    port,
    secret: SECRET,
    requestTimeoutMs: 2_000,
    heartbeatIntervalMs: 5_000,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 1024 * 1024,
    scopeRevocationTimeoutMs: 500,
    log: () => undefined,
  });
}

/** Grant a scoped directory the way the Blockbench user does, with no adapter involved. */
async function grantDirectlyInsidePlugin(plugin: ScopedPlugin, directory: string): Promise<void> {
  await plugin.scope.propose(directory, 'inherited from an earlier adapter process');
  assert.equal(plugin.scope.status.state, 'confirmed');
}

interface DirectWorld {
  port: number;
  scopeDir: string;
  plugin: ScopedPlugin;
  startBridge(): Promise<WsBridge>;
  stopBridge(): Promise<void>;
  currentBridge(): WsBridge;
}

async function createDirectWorld(t: TestContext): Promise<DirectWorld> {
  const port = nextPort++;
  assert.ok(port <= 41_699, 'scope isolation tests must stay inside the reserved 41600-41699 port range');
  const scopeDir = await mkdtemp(join(tmpdir(), 'bbmcp-scope-isolation-'));
  const plugin = new ScopedPlugin(port);
  let bridge: WsBridge | null = null;

  t.after(async () => {
    plugin.releaseWithheldRevocations();
    plugin.session.stop();
    if (bridge !== null) await bridge.stop().catch(() => undefined);
    await rm(scopeDir, { recursive: true, force: true });
  });

  return {
    port,
    scopeDir,
    plugin,
    async startBridge() {
      const started = makeBridge(port);
      assert.deepEqual(await started.start(), { ok: true });
      bridge = started;
      return started;
    },
    async stopBridge() {
      if (bridge === null) return;
      const stopping = bridge;
      bridge = null;
      await stopping.stop();
    },
    currentBridge() {
      assert.ok(bridge !== null, 'no bridge is running');
      return bridge;
    },
  };
}

async function connectPlugin(world: DirectWorld): Promise<void> {
  world.plugin.session.start();
  await waitFor(
    () => world.plugin.session.status === 'connected' && world.currentBridge().connected,
    'the plugin session to authenticate',
  );
}

test('a scoped directory a plugin already holds is revoked before a newly started adapter relays anything', async (t) => {
  const world = await createDirectWorld(t);
  await grantDirectlyInsidePlugin(world.plugin, world.scopeDir);

  const bridge = await world.startBridge();
  await connectPlugin(world);
  await waitFor(() => bridge.scopeCleared, 'the adapter to clear the inherited scoped directory');

  assert.deepEqual(world.plugin.revocations, ['acknowledge']);
  assert.equal(world.plugin.scope.status.state, 'revoked');

  const refused = await bridge.request('read_file', { path: 'model.json' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'E_SCOPE_NOT_CONFIRMED');

  // Control on the same channel: once the user confirms a directory for this
  // adapter, the very same read succeeds. The refusal above was the revocation,
  // not a broken harness.
  const proposed = await bridge.request('propose_scoped_directory', { path: world.scopeDir });
  assert.equal(proposed.ok, true);
  const allowed = await bridge.request('read_file', { path: 'model.json' });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.result, { path: 'model.json', content: '{}', encoding: 'utf8', bytes: 2 });
  // Confirming a directory does not trigger another revocation: the grant this
  // adapter was given stays usable for the rest of the session.
  assert.deepEqual(world.plugin.revocations, ['acknowledge']);
});

test('a scoped directory survives the WebSocket dropping and is taken away only by the replacement adapter', async (t) => {
  const world = await createDirectWorld(t);
  const first = await world.startBridge();
  await connectPlugin(world);
  await waitFor(() => first.scopeCleared, 'the first adapter to clear scope');

  assert.equal((await first.request('propose_scoped_directory', { path: world.scopeDir })).ok, true);
  assert.equal(world.plugin.scope.status.state, 'confirmed');
  assert.equal((await first.request('read_file', { path: 'model.json' })).ok, true);

  // The adapter process goes away; the plugin stays open in Blockbench.
  await world.stopBridge();
  await waitFor(() => world.plugin.session.status !== 'connected', 'the plugin to lose its WebSocket');
  assert.equal(
    world.plugin.scope.status.state,
    'confirmed',
    'the plugin keeps its confirmed directory across the WebSocket loss, exactly as Blockbench does',
  );

  // A replacement adapter starts on the same port and the plugin reconnects to it.
  const second = await world.startBridge();
  await waitFor(() => second.connected, 'the plugin to reconnect to the replacement adapter');
  await waitFor(() => second.scopeCleared, 'the replacement adapter to clear the inherited directory');

  assert.equal(world.plugin.scope.status.state, 'revoked', 'the replacement adapter must not inherit the grant');
  const refused = await second.request('read_file', { path: 'model.json' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  assert.equal(world.plugin.revocations.length, 2, 'one revocation per authenticated session');
});

test('public commands stay unrelayed while a revocation goes unanswered, then flow once it is acknowledged', async (t) => {
  const world = await createDirectWorld(t);
  await grantDirectlyInsidePlugin(world.plugin, world.scopeDir);
  world.plugin.revocationBehaviour = 'withhold';

  const bridge = await world.startBridge();
  await connectPlugin(world);
  await waitFor(() => world.plugin.revocations.length === 1, 'the withheld revocation to reach the plugin');

  let settled = false;
  const pending = bridge.request('read_file', { path: 'model.json' }).then((outcome) => {
    settled = true;
    return outcome;
  });
  await delay(150);
  assert.equal(settled, false, 'a command must not be answered while the revocation is unresolved');
  assert.equal(world.plugin.countOf('read_file'), 0, 'a command must not reach the plugin before revocation');
  assert.equal(world.plugin.scope.status.state, 'confirmed', 'the grant is still standing while the answer is pending');

  world.plugin.revocationBehaviour = 'acknowledge';
  world.plugin.releaseWithheldRevocations();

  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  // Positive control on the same channel: the command did reach the plugin once
  // the revocation resolved, so the earlier count of zero was real.
  assert.equal(world.plugin.countOf('read_file'), 1);
  assert.equal(world.plugin.scope.status.state, 'revoked');
});

test('a revocation the plugin refuses keeps commands blocked instead of letting them through', async (t) => {
  const world = await createDirectWorld(t);
  await grantDirectlyInsidePlugin(world.plugin, world.scopeDir);
  world.plugin.revocationBehaviour = 'reject';

  const bridge = await world.startBridge();
  await connectPlugin(world);
  await waitFor(() => world.plugin.revocations.length >= 1, 'the refused revocation to reach the plugin');

  const blocked = await bridge.request('read_file', { path: 'model.json' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'E_BLOCKBENCH_ERROR');
  assert.equal(bridge.scopeCleared, false, 'a refused revocation must never count as cleared');
  assert.equal(world.plugin.countOf('read_file'), 0, 'a refused revocation must not release the command');
  assert.equal(world.plugin.scope.status.state, 'confirmed', 'the inherited grant is still there, and still unusable');

  // A revocation that answers with a shape the protocol does not define is
  // treated the same way: refused, not accepted.
  world.plugin.revocationBehaviour = 'malformed';
  const malformed = await bridge.request('read_file', { path: 'model.json' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error?.code, 'E_PROTOCOL_MISMATCH');
  assert.equal(world.plugin.countOf('read_file'), 0);

  // Control: the identical call succeeds as soon as a revocation is acknowledged,
  // so the two refusals above were the gate and not a dead connection.
  world.plugin.revocationBehaviour = 'acknowledge';
  const released = await bridge.request('read_file', { path: 'model.json' });
  assert.equal(released.ok, false);
  assert.equal(released.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  assert.equal(world.plugin.countOf('read_file'), 1, 'the command reached the plugin only after a real revocation');
});

test('a controller lease that starts with unknown scope state demands a revocation before its first grant', () => {
  const noopTimers = {
    idleTimeoutMs: 1_000,
    setTimer: () => undefined,
    clearTimer: () => undefined,
  };

  const unknown = new ControllerLease<undefined>({ ...noopTimers, initiallyTainted: true });
  assert.equal(unknown.tainted, true);
  assert.deepEqual(unknown.acquire('session-a'), { outcome: 'revocation_required' });
  assert.equal(unknown.state, 'recovering');
  unknown.revocationResolved(true);
  assert.equal(unknown.state, 'owned');
  assert.equal(unknown.ownerSessionId, 'session-a');
  assert.equal(unknown.tainted, false);

  // Sensitivity control: the same lease without the unknown starting state hands
  // out control immediately, which is what the flag exists to prevent.
  const trusting = new ControllerLease<undefined>(noopTimers);
  assert.equal(trusting.tainted, false);
  assert.deepEqual(trusting.acquire('session-a'), { outcome: 'granted' });
  assert.equal(trusting.state, 'owned');
});

test('a broker that has just started revokes an inherited scoped directory before serving its first command', async (t) => {
  const port = nextPort++;
  assert.ok(port <= 41_699, 'scope isolation tests must stay inside the reserved 41600-41699 port range');
  const directory = await mkdtemp(join(tmpdir(), 'bbscp-'));
  // A Windows named pipe name is machine-wide, so the identity is derived from
  // this harness's own mkdtemp directory: no two live harnesses can collide.
  const endpoint = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: directory,
    identity: computeConfigIdentity(directory),
  });
  const recordPath = join(directory, 'broker.json');
  await writeBrokerRecordAtomic(recordPath, {
    endpoint,
    broker_instance_id: `scope-isolation-${port}`,
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: PACKAGE_VERSION,
    ws_port: port,
  });

  const plugin = new ScopedPlugin(port);
  // The plugin is already holding a directory that an earlier broker was given.
  await plugin.scope.propose(directory, 'granted to a broker that has since died');
  assert.equal(plugin.scope.status.state, 'confirmed');

  const server = new BrokerServer({
    endpoint,
    configIdentity: CONFIG_IDENTITY,
    recordPath,
    instanceId: `scope-isolation-${port}`,
    packageVersion: PACKAGE_VERSION,
    port,
    secret: SECRET,
    requestTimeoutMs: 2_000,
    heartbeatIntervalMs: 5_000,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 1024 * 1024,
    leaseIdleTimeoutMs: 30_000,
    brokerIdleTimeoutMs: 30_000,
    clientHeartbeatIntervalMs: 30_000,
    log: () => undefined,
  });
  const client = new BrokerClient();
  t.after(async () => {
    plugin.releaseWithheldRevocations();
    plugin.session.stop();
    await client.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await server.start(), { ok: true });
  await client.connect(endpoint, {
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: PACKAGE_VERSION,
    config_identity: CONFIG_IDENTITY,
    session_id: 'replacement-shim',
    client_label: 'Replacement shim',
    effective_port: port,
  });

  plugin.session.start();
  await waitFor(() => plugin.session.status === 'connected', 'the plugin to authenticate with the new broker');
  await waitFor(() => plugin.revocations.length >= 1, 'the replacement broker to revoke the inherited directory');
  assert.equal(plugin.scope.status.state, 'revoked', 'a replacement broker must not inherit the earlier grant');

  const refused: BridgeRequestResult = await client.request('read_file', { path: 'model.json' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'E_SCOPE_NOT_CONFIRMED');

  // Control on the same channel: a directory confirmed for this shim works.
  assert.equal((await client.request('propose_scoped_directory', { path: directory })).ok, true);
  assert.equal((await client.request('read_file', { path: 'model.json' })).ok, true);
  assert.equal(plugin.revocations.length, 1, 'the shim keeps the grant it was given for the rest of the session');
});
