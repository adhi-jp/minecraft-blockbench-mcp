import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import WebSocket from 'ws';

import { BrokerClient } from '../src/adapter/broker/broker-client.js';
import { BrokerServer, type BrokerServerOptions } from '../src/adapter/broker/broker-server.js';
import { computeConfigIdentity, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import {
  IPC_PROTOCOL_VERSION,
  encodeIpcMessage,
  type BrokerToClientMessage,
  type ClientHelloMessage,
} from '../src/adapter/broker/ipc-protocol.js';
import { writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import { buildBrokerSpawnArgs, spawnDetachedBroker } from '../src/adapter/broker/spawn.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'broker-test-secret-1234567890';
const CONFIG_IDENTITY = '0123456789abcdef';
const PACKAGE_VERSION = '0.1.0';
let nextPort = 41_200;

interface PluginRequestFrame {
  type: 'request';
  id: string;
  command: string;
  params: unknown;
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function clientHello(port: number, sessionId: string, clientLabel: string): Omit<ClientHelloMessage, 'type'> {
  return {
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: PACKAGE_VERSION,
    config_identity: CONFIG_IDENTITY,
    session_id: sessionId,
    client_label: clientLabel,
    effective_port: port,
  };
}

class FakePlugin {
  readonly frames: PluginRequestFrame[] = [];
  readonly events: string[] = [];
  readonly sockets = new Set<WebSocket>();
  readonly unansweredCommands = new Set<string>();
  delayRevocations = false;
  revocationResult: unknown = { state: 'revoked' };
  current: WebSocket | null = null;
  private readonly delayedRevocations: Array<{ socket: WebSocket; frame: PluginRequestFrame }> = [];

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.current = socket;
    this.sockets.add(socket);
    const acknowledged = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type?: string } | PluginRequestFrame;
        if (message.type === 'hello_ack') {
          resolve();
          return;
        }
        if (message.type !== 'request') return;
        const frame = message as PluginRequestFrame;
        this.frames.push(frame);
        this.events.push(`request:${frame.command}`);
        if (frame.command === 'revoke_scope') {
          if (this.delayRevocations) this.delayedRevocations.push({ socket, frame });
          else this.#respond(socket, frame, this.revocationResult);
          return;
        }
        if (!this.unansweredCommands.has(frame.command)) {
          this.#respond(socket, frame, { relayed: true, command: frame.command });
        }
      });
    });
    socket.on('close', () => {
      this.events.push('close');
      this.sockets.delete(socket);
      if (this.current === socket) this.current = null;
    });
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        secret: SECRET,
        plugin_version: PACKAGE_VERSION,
        blockbench_version: '5.1.4',
        capabilities: ['java_block'],
      }),
    );
    await acknowledged;
  }

  acknowledgeLatestRevocation(): void {
    const pending = this.delayedRevocations.at(-1);
    assert.ok(pending, 'expected a delayed revoke_scope request');
    assert.equal(pending.socket.readyState, WebSocket.OPEN, 'the revocation acknowledgement socket must be open');
    this.#respond(pending.socket, pending.frame, { state: 'revoked' });
  }

  requests(command: string): PluginRequestFrame[] {
    return this.frames.filter((frame) => frame.command === command);
  }

  async disconnectCurrent(): Promise<void> {
    const socket = this.current;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, 'close');
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    await closed;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sockets].map(async (socket) => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, 'close');
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
        await closed;
      }),
    );
  }

  #respond(socket: WebSocket, frame: PluginRequestFrame, result: unknown): void {
    socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result }));
  }
}

interface Harness {
  port: number;
  endpoint: string;
  recordPath: string;
  instanceId: string;
  server: BrokerServer;
  clients: BrokerClient[];
  plugins: FakePlugin[];
  addClient(sessionId: string, label: string): Promise<{ client: BrokerClient; ack: BrokerToClientMessage }>;
  addPlugin(): Promise<FakePlugin>;
}

async function createHarness(t: TestContext, overrides: Partial<BrokerServerOptions> = {}): Promise<Harness> {
  const port = nextPort++;
  assert.ok(port <= 41_399, 'broker tests must stay inside the reserved 41200-41399 port range');
  const directory = await mkdtemp(join(tmpdir(), 'bbsrv-'));
  // A Windows named pipe name is machine-wide, so the identity is derived from
  // this harness's own mkdtemp directory: no two live harnesses can collide.
  const endpoint = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: directory,
    identity: computeConfigIdentity(directory),
  });
  const recordPath = join(directory, 'broker.json');
  const instanceId = `broker-test-${port}`;
  await writeBrokerRecordAtomic(recordPath, {
    endpoint,
    broker_instance_id: instanceId,
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: PACKAGE_VERSION,
    ws_port: port,
  });

  const server = new BrokerServer({
    endpoint,
    configIdentity: CONFIG_IDENTITY,
    recordPath,
    instanceId,
    packageVersion: PACKAGE_VERSION,
    port,
    secret: SECRET,
    requestTimeoutMs: 250,
    heartbeatIntervalMs: 1_000,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 500,
    maxMessageBytes: 64 * 1024,
    leaseIdleTimeoutMs: 5_000,
    brokerIdleTimeoutMs: 5_000,
    clientHeartbeatIntervalMs: 1_000,
    log: () => undefined,
    ...overrides,
  });
  const clients: BrokerClient[] = [];
  const plugins: FakePlugin[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const plugin of plugins) await plugin.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await server.start(), { ok: true });

  return {
    port,
    endpoint,
    recordPath,
    instanceId,
    server,
    clients,
    plugins,
    async addClient(sessionId, label) {
      const client = new BrokerClient();
      clients.push(client);
      const ack = await client.connect(endpoint, clientHello(port, sessionId, label));
      return { client, ack };
    },
    async addPlugin() {
      const plugin = new FakePlugin(port);
      plugins.push(plugin);
      await plugin.connect();
      // The bridge revokes any scoped directory the plugin still holds as soon
      // as a session authenticates. Settle that before handing the plugin back,
      // so a test that changes revocation behaviour afterwards cannot race it.
      await waitFor(
        () => plugin.requests('revoke_scope').length >= 1,
        'the scope revocation that starts every authenticated plugin session',
      );
      return plugin;
    },
  };
}

async function rawIpcSocket(
  endpoint: string,
  options: { answerPings?: boolean } = {},
): Promise<{ socket: Socket; messages: BrokerToClientMessage[]; pingIds: string[] }> {
  const socket = createConnection(endpoint);
  const messages: BrokerToClientMessage[] = [];
  const pingIds: string[] = [];
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line !== '') {
        const message = JSON.parse(line) as BrokerToClientMessage;
        messages.push(message);
        if (message.type === 'ping') {
          pingIds.push(message.id);
          if (options.answerPings && !socket.destroyed) {
            socket.write(encodeIpcMessage({ type: 'pong', id: message.id }));
          }
        }
      }
    }
  });
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  return { socket, messages, pingIds };
}

test('registered clients receive hello acknowledgements and shared connected status', async (t) => {
  const harness = await createHarness(t);
  const a = await harness.addClient('session-a', 'Client A');
  const b = await harness.addClient('session-b', 'Client B');

  assert.equal(a.ack.type, 'hello_ack');
  assert.equal(b.ack.type, 'hello_ack');
  await waitFor(
    () =>
      a.client.brokerStatus()?.client_count === 2 &&
      b.client.brokerStatus()?.client_count === 2 &&
      a.client.brokerStatus()?.plugin_connected === false &&
      b.client.brokerStatus()?.plugin_connected === false,
    'both clients to cache the disconnected two-client status',
  );

  const plugin = await harness.addPlugin();
  await waitFor(
    () =>
      a.client.brokerStatus()?.client_count === 2 &&
      b.client.brokerStatus()?.client_count === 2 &&
      a.client.connected &&
      b.client.connected,
    'both clients to cache the connected two-client status',
  );
  assert.equal(a.client.pluginInfo?.blockbench_version, '5.1.4');
  assert.equal(b.client.brokerStatus()?.plugin_connected, true);

  assert.equal((await a.client.request('get_project_state', {})).ok, true);
  await waitFor(
    () =>
      a.client.brokerStatus()?.controller_state === 'owned' &&
      a.client.brokerStatus()?.controller_owner === 'Client A' &&
      b.client.brokerStatus()?.controller_state === 'owned' &&
      b.client.brokerStatus()?.controller_owner === 'Client A',
    'owned controller status with the owner label',
  );

  await plugin.disconnectCurrent();
  await waitFor(
    () =>
      a.client.brokerStatus()?.plugin_connected === false &&
      b.client.brokerStatus()?.plugin_connected === false,
    'plugin disconnection status broadcast',
  );
});

test('the first controller excludes a busy client without relaying its command', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');

  assert.equal((await a.request('get_project_state', {})).ok, true);
  const busy = await b.request('get_elements', {});
  assert.equal(busy.ok, false);
  assert.equal(busy.error?.code, 'E_CLIENT_BUSY');
  assert.deepEqual(busy.error?.details, { owner: 'Client A' });
  assert.equal(plugin.requests('get_elements').length, 0, 'the excluded client command must not reach the plugin');

  const unsupported = await b.request('not_a_command', {});
  assert.equal(unsupported.error?.code, 'E_UNSUPPORTED_COMMAND');
  assert.equal(plugin.requests('not_a_command').length, 0);
});

test('controller handoff waits for exactly one revoke_scope acknowledgement before relay', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.delayRevocations = true;
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');
  assert.equal((await a.request('get_project_state', {})).ok, true);
  await a.close();
  await waitFor(() => b.brokerStatus()?.client_count === 1, 'Client A to deregister');

  let settled = false;
  const requested = b.request('get_elements', {}).then((outcome) => {
    settled = true;
    return outcome;
  });
  // Two in total: one when the plugin session authenticated, one for this handoff.
  await waitFor(() => plugin.requests('revoke_scope').length === 2, 'the handoff revocation request');
  assert.equal(plugin.requests('get_elements').length, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'the triggering request must remain pending before revocation acknowledgement');

  plugin.acknowledgeLatestRevocation();
  const outcome = await requested;
  assert.equal(outcome.ok, true);
  const revokeIndex = plugin.frames.findLastIndex((frame) => frame.command === 'revoke_scope');
  const commandIndex = plugin.frames.findIndex((frame) => frame.command === 'get_elements');
  assert.ok(revokeIndex >= 0 && commandIndex > revokeIndex);
  assert.equal(plugin.requests('revoke_scope').length, 2);
});

test('a disconnected pending acquirer is not granted or relayed after revocation acknowledgement', async (t) => {
  const harness = await createHarness(t, { leaseIdleTimeoutMs: 40 });
  const plugin = await harness.addPlugin();
  plugin.delayRevocations = true;
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');

  assert.equal((await a.request('get_project_state', {})).ok, true);
  await waitFor(() => a.brokerStatus()?.controller_state === 'idle', 'Client A lease idle expiry');

  const requested = b.request('get_elements', {});
  await waitFor(() => plugin.requests('revoke_scope').length === 2, 'Client B handoff revocation request');
  assert.equal(plugin.requests('get_elements').length, 0);

  await b.close();
  assert.equal((await requested).error?.code, 'E_BROKER_UNAVAILABLE');
  await waitFor(
    () => a.brokerStatus()?.client_count === 1 && a.brokerStatus()?.controller_state === 'recovering',
    'Client B deregistration during recovery',
  );

  plugin.acknowledgeLatestRevocation();
  await waitFor(() => a.brokerStatus()?.controller_state === 'idle', 'revocation completion without an acquirer');
  assert.equal(plugin.requests('get_elements').length, 0, 'Client B command must never reach the plugin');

  assert.equal((await a.request('get_project_state', {})).ok, true);
  assert.equal(plugin.requests('get_elements').length, 0);
  assert.equal(plugin.requests('get_project_state').length, 2);
});

test('an invalid revocation acknowledgement keeps recovery tainted and does not relay the waiting command', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');
  assert.equal((await a.request('get_project_state', {})).ok, true);
  await a.close();
  await waitFor(() => b.brokerStatus()?.client_count === 1, 'Client A to deregister');

  plugin.revocationResult = { state: 'bogus' };
  const rejected = await b.request('get_elements', {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'E_PROTOCOL_MISMATCH');
  assert.equal(b.brokerStatus()?.controller_state, 'recovering');
  assert.equal(plugin.requests('get_elements').length, 0, 'invalid revocation must not release the waiting command');

  plugin.revocationResult = { state: 'revoked' };
  await plugin.disconnectCurrent();
  await plugin.connect();
  await waitFor(() => plugin.requests('revoke_scope').length === 3, 'valid revocation after tainted reconnect');
  const recovered = await b.request('get_elements', {});
  assert.equal(recovered.ok, true);
  // Session start, the rejected handoff attempt, then the reconnected session.
  assert.equal(plugin.requests('revoke_scope').length, 3);
  assert.equal(plugin.requests('get_elements').length, 1);
});

test('a revocation acknowledged with a scope state that still grants access is refused and hands over nothing', async (t) => {
  // The reply parses against the scope status schema, so only its VALUE says
  // whether the scoped directory was actually given up. `confirmed` is the
  // state that hands out the directory handle: accepting it as proof of
  // revocation would clear the lease taint and grant control to the waiting
  // client while the plugin still held the previous client's directory.
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');
  assert.equal((await a.request('get_project_state', {})).ok, true);
  await a.close();
  await waitFor(() => b.brokerStatus()?.client_count === 1, 'Client A to deregister');

  plugin.revocationResult = { state: 'confirmed', normalized_path: '/' };
  const rejected = await b.request('get_elements', {});
  assert.equal(
    rejected.ok,
    false,
    'the waiting client was served on the strength of a revocation acknowledged as still granting access',
  );
  assert.equal(rejected.error?.code, 'E_PROTOCOL_MISMATCH');
  assert.equal(
    plugin.requests('get_elements').length,
    0,
    'the waiting command was relayed on the strength of a scope state that still grants access',
  );
  assert.equal(b.brokerStatus()?.controller_state, 'recovering', 'the lease left recovery without a real revocation');

  // A genuine revocation still completes the handoff, so the refusal above is
  // the value check and not a wedged lease.
  plugin.revocationResult = { state: 'revoked' };
  await plugin.disconnectCurrent();
  await plugin.connect();
  await waitFor(() => plugin.requests('revoke_scope').length === 3, 'valid revocation after the refused acknowledgement');
  assert.equal((await b.request('get_elements', {})).ok, true);
  assert.equal(plugin.requests('get_elements').length, 1);
});

test('a lost revocation acknowledgement is retried after plugin authentication before handoff', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.delayRevocations = true;
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');
  assert.equal((await a.request('get_project_state', {})).ok, true);
  await a.close();
  await waitFor(() => b.brokerStatus()?.client_count === 1, 'Client A to deregister');

  const firstAttempt = b.request('get_elements', {});
  await waitFor(() => plugin.requests('revoke_scope').length === 2, 'the first revocation request');
  await plugin.disconnectCurrent();
  const disconnected = await firstAttempt;
  assert.equal(disconnected.error?.code, 'E_PLUGIN_NOT_CONNECTED');
  assert.equal(plugin.requests('get_elements').length, 0);

  await plugin.connect();
  await waitFor(() => plugin.requests('revoke_scope').length === 3, 'revocation retry after authentication');
  const retry = b.request('get_elements', {});
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(plugin.requests('get_elements').length, 0, 'the command must still wait for the retry acknowledgement');
  plugin.acknowledgeLatestRevocation();
  assert.equal((await retry).ok, true);
  const secondRevokeIndex = plugin.frames.findLastIndex((frame) => frame.command === 'revoke_scope');
  const commandIndex = plugin.frames.findIndex((frame) => frame.command === 'get_elements');
  assert.ok(commandIndex > secondRevokeIndex);
  // Session start, the unacknowledged handoff attempt, then the reconnected session.
  assert.equal(plugin.requests('revoke_scope').length, 3);
});

test('mutating command timeouts pass through the direct bridge reconciliation payload', async (t) => {
  const harness = await createHarness(t, { requestTimeoutMs: 35 });
  const plugin = await harness.addPlugin();
  plugin.unansweredCommands.add('create_cubes');
  const { client } = await harness.addClient('session-a', 'Client A');

  const outcome = await client.request('create_cubes', { cubes: [] });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.error, {
    code: 'E_TIMEOUT',
    message: 'The plugin did not answer within 35 ms (command create_cubes).',
    details: {
      execution_state: 'unknown',
      retry: 'Do not retry automatically; the plugin may have completed the command.',
      reconciliation: {
        command: 'get_project_state',
        manual_check: 'Read back the affected objects before retrying the mutation.',
      },
    },
  });
});

test('plugin-not-connected errors pass through the complete direct bridge payload', async (t) => {
  const harness = await createHarness(t);
  const { client } = await harness.addClient('session-a', 'Client A');

  const outcome = await client.request('get_project_state', {});
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.error, {
    code: 'E_PLUGIN_NOT_CONNECTED',
    message: 'Blockbench plugin is not connected.',
  });
});

test('while Blockbench is not connected every client is answered E_PLUGIN_NOT_CONNECTED rather than E_CLIENT_BUSY', async (t) => {
  // A broker that has just started holds its scoped-directory state as unknown,
  // so the first command from any client asks for a revocation before anything
  // checks whether there is a plugin to revoke against. With Blockbench not
  // running there is nothing to revoke, and the lease has no idle timer in
  // `recovering`: whoever asked first must not be left holding a reservation
  // that no timeout can reclaim.
  const harness = await createHarness(t);
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');

  const first = await a.request('get_project_state', {});
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, 'E_PLUGIN_NOT_CONNECTED');

  const second = await b.request('get_elements', {});
  assert.equal(second.ok, false);
  assert.deepEqual(
    second.error,
    { code: 'E_PLUGIN_NOT_CONNECTED', message: 'Blockbench plugin is not connected.' },
    'a client was told another client controls a session no plugin is connected to',
  );

  // The same answer keeps being given, to either client, for as long as
  // Blockbench is not running.
  assert.equal((await a.request('get_elements', {})).error?.code, 'E_PLUGIN_NOT_CONNECTED');
  assert.equal((await b.request('get_project_state', {})).error?.code, 'E_PLUGIN_NOT_CONNECTED');

  // Once Blockbench connects, control goes to whoever asks for it, not to the
  // client that happened to ask first while nothing could be served.
  const plugin = await harness.addPlugin();
  const granted = await b.request('get_elements', {});
  assert.equal(granted.ok, true, 'control was held for a client that was refused and never granted it');
  assert.equal(plugin.requests('get_elements').length, 1);
  await waitFor(() => b.brokerStatus()?.controller_owner === 'Client B', 'Client B to be reported as the owner');
});

test('identity and IPC version mismatches are rejected with their precise reasons and closed', async (t) => {
  const harness = await createHarness(t);
  const identity = await rawIpcSocket(harness.endpoint);
  const identityClosed = once(identity.socket, 'close');
  identity.socket.write(
    encodeIpcMessage({
      type: 'client_hello',
      ...clientHello(harness.port, 'bad-identity', 'Bad identity'),
      config_identity: 'ffffffffffffffff',
    }),
  );
  await waitFor(() => identity.messages.length === 1, 'identity rejection');
  assert.equal(identity.messages[0]?.type, 'hello_reject');
  assert.equal(identity.messages[0]?.type === 'hello_reject' && identity.messages[0].reason, 'identity_mismatch');
  await identityClosed;

  const version = await rawIpcSocket(harness.endpoint);
  const versionClosed = once(version.socket, 'close');
  version.socket.write(
    encodeIpcMessage({
      type: 'client_hello',
      ...clientHello(harness.port, 'bad-version', 'Bad version'),
      ipc_protocol_version: IPC_PROTOCOL_VERSION + 1,
    }),
  );
  await waitFor(() => version.messages.length === 1, 'version rejection');
  assert.equal(version.messages[0]?.type, 'hello_reject');
  assert.equal(version.messages[0]?.type === 'hello_reject' && version.messages[0].reason, 'version_mismatch');
  await versionClosed;
});

test('a client missing two ping replies is deregistered and its idle ownership is released', async (t) => {
  const harness = await createHarness(t, { clientHeartbeatIntervalMs: 50 });
  await harness.addPlugin();
  const observer = await rawIpcSocket(harness.endpoint, { answerPings: true });
  t.after(() => observer.socket.destroy());
  observer.socket.write(
    encodeIpcMessage({
      type: 'client_hello',
      ...clientHello(harness.port, 'observer', 'Observer'),
    }),
  );
  await waitFor(
    () => observer.messages.some((message) => message.type === 'hello_ack'),
    'responsive observer hello acknowledgement',
  );
  const owner = await rawIpcSocket(harness.endpoint);
  const ownerClosed = once(owner.socket, 'close');
  owner.socket.write(
    encodeIpcMessage({
      type: 'client_hello',
      ...clientHello(harness.port, 'silent-owner', 'Silent owner'),
    }),
  );
  await waitFor(() => owner.messages.some((message) => message.type === 'hello_ack'), 'raw owner hello acknowledgement');
  owner.socket.write(
    encodeIpcMessage({ type: 'request', id: 'owner-request', command: 'get_project_state', params: {} }),
  );
  await waitFor(
    () => owner.messages.some((message) => message.type === 'response' && message.id === 'owner-request'),
    'raw owner command response',
  );

  const statusCountBeforeExpiry = observer.messages.filter((message) => message.type === 'status_event').length;
  await ownerClosed;
  await waitFor(
    () => {
      const statuses = observer.messages.filter((message) => message.type === 'status_event');
      const latest = statuses.at(-1);
      return (
        statuses.length > statusCountBeforeExpiry &&
        latest?.client_count === 1 &&
        latest.controller_state === 'idle' &&
        latest.controller_owner === null &&
        observer.pingIds.length >= 3
      );
    },
    'heartbeat expiry status broadcast',
  );
  assert.ok(observer.pingIds.length >= 3, 'the responsive client must receive at least three broker pings');
  assert.equal(observer.socket.destroyed, false, 'the responsive client must remain registered');
});

test('a broker with no clients exits after its initial idle timeout', async (t) => {
  const harness = await createHarness(t, { brokerIdleTimeoutMs: 30 });

  await waitForAsync(() => access(harness.recordPath).then(() => false, () => true), 'orphan record removal');
  await waitFor(() => !harness.server.listening, 'orphan IPC listener shutdown');
});

test('idle shutdown revokes a connected plugin exactly once before closing the bridge', async (t) => {
  const harness = await createHarness(t, { brokerIdleTimeoutMs: 200 });
  const { client } = await harness.addClient('session-a', 'Client A');
  const plugin = await harness.addPlugin();
  await client.close();

  await waitForAsync(() => access(harness.recordPath).then(() => false, () => true), 'idle shutdown record removal');
  await waitFor(() => plugin.events.includes('close'), 'plugin bridge closure');
  // One when the session authenticated, one on the way out.
  assert.equal(plugin.requests('revoke_scope').length, 2);
  assert.ok(
    plugin.events.lastIndexOf('request:revoke_scope') < plugin.events.indexOf('close'),
    'the shutdown revoke_scope must arrive before the plugin bridge closes',
  );
});

test('last-client idle shutdown removes rendezvous state and refuses later IPC attachment', async (t) => {
  const harness = await createHarness(t, { brokerIdleTimeoutMs: 200 });
  const { client: a } = await harness.addClient('session-a', 'Client A');
  const { client: b } = await harness.addClient('session-b', 'Client B');
  await a.close();
  await b.close();

  await waitForAsync(() => access(harness.recordPath).then(() => false, () => true), 'rendezvous record removal');
  await waitFor(() => !harness.server.listening, 'IPC listener shutdown');
  const later = new BrokerClient({ connectTimeoutMs: 100 });
  await assert.rejects(later.connect(harness.endpoint, clientHello(harness.port, 'late', 'Late client')));
  await later.close();
});

test('a broker client reconnects after connection loss and after an explicit close', async (t) => {
  const first = await createHarness(t);
  await first.addPlugin();
  const { client } = await first.addClient('session-a', 'Client A');
  await waitFor(() => client.connected, 'the initial broker connection');
  assert.equal((await client.request('get_project_state', {})).ok, true);

  await first.server.stop();
  await waitFor(() => !client.listening, 'the first broker connection to close');
  assert.equal(client.brokerStatus(), null);
  assert.equal((await client.request('get_project_state', {})).error?.code, 'E_BROKER_UNAVAILABLE');

  const second = await createHarness(t);
  assert.notEqual(second.endpoint, first.endpoint);
  await second.addPlugin();
  await client.connect(second.endpoint, clientHello(second.port, 'session-b', 'Client B'));
  await waitFor(() => client.connected, 'the replacement broker connection');
  assert.equal((await client.request('get_project_state', {})).ok, true);

  await client.close();
  assert.equal(client.listening, false);
  assert.equal(client.brokerStatus(), null);

  await client.connect(second.endpoint, clientHello(second.port, 'session-c', 'Client C'));
  await waitFor(() => client.connected, 'the connection after explicit close');
  assert.equal((await client.request('get_project_state', {})).ok, true);
});

test('detached broker spawning preserves argv boundaries and only unreferences the injected child', () => {
  const built = buildBrokerSpawnArgs({
    execPath: '/runtime/node',
    cliEntryPath: '/package path/cli.js',
    configPath: '/config path/config.json',
  });
  assert.deepEqual(built, {
    command: '/runtime/node',
    args: ['/package path/cli.js', '__broker', '--config', '/config path/config.json'],
    options: { detached: true, stdio: 'ignore' },
  });

  let unreferenced = false;
  const calls: unknown[] = [];
  const child = spawnDetachedBroker(
    (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => (unreferenced = true) };
    },
    built,
  );
  assert.deepEqual(calls, [built]);
  assert.equal(unreferenced, true);
  assert.equal(typeof child.unref, 'function');
});

test('a disconnected broker client makes one injected reattach attempt before reporting unavailable', async () => {
  let attempts = 0;
  const client = new BrokerClient({
    reattach: () => {
      attempts += 1;
    },
  });
  const outcome = await client.request('get_project_state', {});
  assert.equal(attempts, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.code, 'E_BROKER_UNAVAILABLE');
  await client.close();
});
