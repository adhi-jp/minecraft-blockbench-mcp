// Withdrawing a request that is still waiting behind a busy plugin.
//
// The broker relays one command to Blockbench at a time, so a second command
// from the same client waits in the broker's lane. These tests drive a real
// BrokerServer against a fake plugin that can hold a command open, and check
// what a `cancel_request` naming the internal request UUID does at each point
// on that path: before the request is written, while it waits in the lane, and
// after it has already been handed to the plugin.
//
// Every "the plugin never saw it" assertion is paired with a control run that
// performs the identical sequence without the cancellation, so an empty
// observation cannot be mistaken for a working one.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import WebSocket from 'ws';

import { BrokerClient, BrokerHandshakeError, BrokerRequestCancelledError } from '../src/adapter/broker/broker-client.js';
import { BrokerServer, type BrokerServerOptions } from '../src/adapter/broker/broker-server.js';
import { computeConfigIdentity, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import {
  IPC_PROTOCOL_VERSION,
  IpcLineDecoder,
  brokerToClientMessageSchema,
  clientToBrokerMessageSchema,
  encodeIpcMessage,
  ipcCancelRequestMessageSchema,
  type BrokerToClientMessage,
  type ClientHelloMessage,
  type IpcResponseMessage,
} from '../src/adapter/broker/ipc-protocol.js';
import { writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'cancellation-secret-1234567890';
const CONFIG_IDENTITY = 'fedcba9876543210';
const PACKAGE_VERSION = '0.1.0';
let nextPort = 41_500;

interface PluginRequestFrame {
  type: 'request';
  id: string;
  command: string;
  params: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(5);
  }
}

/**
 * A Blockbench plugin stand-in that answers `revoke_scope` like the shipped
 * plugin does and can hold one named command open until the test releases it.
 */
class HoldingPlugin {
  readonly frames: PluginRequestFrame[] = [];
  readonly held = new Map<string, { socket: WebSocket; frame: PluginRequestFrame }>();
  holdCommands = new Set<string>();
  #socket: WebSocket | null = null;

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.#socket = socket;
    const acknowledged = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type?: string } & Partial<PluginRequestFrame>;
        if (message.type === 'hello_ack') {
          resolve();
          return;
        }
        if (message.type !== 'request') return;
        const frame = message as PluginRequestFrame;
        this.frames.push(frame);
        if (frame.command === 'revoke_scope') {
          this.#respond(socket, frame, { state: 'revoked' });
          return;
        }
        if (this.holdCommands.has(frame.command)) {
          this.held.set(frame.command, { socket, frame });
          return;
        }
        this.#respond(socket, frame, { relayed: true, command: frame.command });
      });
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
    await waitFor(() => this.requests('revoke_scope').length >= 1, 'the session-start scope revocation');
  }

  requests(command: string): PluginRequestFrame[] {
    return this.frames.filter((frame) => frame.command === command);
  }

  release(command: string): void {
    const pending = this.held.get(command);
    assert.ok(pending, `expected a held ${command} request`);
    this.held.delete(command);
    this.#respond(pending.socket, pending.frame, { relayed: true, command });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, 'close');
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    await closed;
  }

  #respond(socket: WebSocket, frame: PluginRequestFrame, result: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result }));
  }
}

/**
 * A stdio shim stand-in speaking broker IPC directly, so a test can choose the
 * exact request UUIDs it uses and can see every frame the broker sends back.
 */
class RawShim {
  readonly received: BrokerToClientMessage[] = [];
  readonly #decoder = new IpcLineDecoder<BrokerToClientMessage>(brokerToClientMessageSchema);

  private constructor(readonly socket: Socket) {}

  static async attach(
    endpoint: string,
    port: number,
    sessionId: string,
    label: string,
    ipcVersion: number = IPC_PROTOCOL_VERSION,
  ): Promise<RawShim> {
    const socket = createConnection(endpoint);
    const shim = new RawShim(socket);
    socket.on('data', (chunk) => {
      for (const decoded of shim.#decoder.push(chunk)) {
        if (decoded.kind === 'message') shim.received.push(decoded.message);
      }
    });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const hello: ClientHelloMessage = {
      type: 'client_hello',
      ipc_protocol_version: ipcVersion,
      package_version: PACKAGE_VERSION,
      config_identity: CONFIG_IDENTITY,
      session_id: sessionId,
      client_label: label,
      effective_port: port,
    };
    socket.write(encodeIpcMessage(hello));
    return shim;
  }

  async awaitHelloAck(): Promise<void> {
    await waitFor(() => this.received.some((message) => message.type === 'hello_ack'), 'the broker hello acknowledgement');
  }

  sendRequest(command: string, params: unknown = {}): string {
    const id = randomUUID();
    this.socket.write(encodeIpcMessage({ type: 'request', id, command, params }));
    return id;
  }

  cancel(id: string): void {
    this.socket.write(encodeIpcMessage({ type: 'cancel_request', id }));
  }

  latestClientCount(): number | null {
    for (let index = this.received.length - 1; index >= 0; index -= 1) {
      const message = this.received[index];
      if (message.type === 'status_event') return message.client_count;
    }
    return null;
  }

  responsesFor(id: string): IpcResponseMessage[] {
    return this.received.filter(
      (message): message is IpcResponseMessage => message.type === 'response' && message.id === id,
    );
  }

  async awaitResponse(id: string): Promise<IpcResponseMessage> {
    await waitFor(() => this.responsesFor(id).length > 0, `a broker response for request ${id}`);
    return this.responsesFor(id)[0];
  }

  close(): void {
    this.socket.destroy();
  }
}

interface Harness {
  port: number;
  endpoint: string;
  server: BrokerServer;
  addPlugin(): Promise<HoldingPlugin>;
  addShim(label: string, sessionId?: string): Promise<RawShim>;
  addBrokerClient(label: string): Promise<BrokerClient>;
}

async function createHarness(t: TestContext, overrides: Partial<BrokerServerOptions> = {}): Promise<Harness> {
  const port = nextPort++;
  assert.ok(port <= 41_599, 'cancellation tests must stay inside the reserved 41500-41599 port range');
  const directory = await mkdtemp(join(tmpdir(), 'bbcan-'));
  // A Windows named pipe name is machine-wide, so the identity is derived from
  // this harness's own mkdtemp directory: no two live harnesses can collide.
  const endpoint = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: directory,
    identity: computeConfigIdentity(directory),
  });
  const recordPath = join(directory, 'broker.json');
  const instanceId = `cancel-test-${port}`;
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
    requestTimeoutMs: 30_000,
    heartbeatIntervalMs: 30_000,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 64 * 1024,
    leaseIdleTimeoutMs: 30_000,
    brokerIdleTimeoutMs: 30_000,
    clientHeartbeatIntervalMs: 30_000,
    log: () => undefined,
    ...overrides,
  });

  const plugins: HoldingPlugin[] = [];
  const shims: RawShim[] = [];
  const brokerClients: BrokerClient[] = [];
  t.after(async () => {
    for (const shim of shims) shim.close();
    for (const client of brokerClients) await client.close().catch(() => undefined);
    for (const plugin of plugins) await plugin.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await server.start(), { ok: true });

  return {
    port,
    endpoint,
    server,
    async addPlugin() {
      const plugin = new HoldingPlugin(port);
      plugins.push(plugin);
      await plugin.connect();
      return plugin;
    },
    async addShim(label, sessionId = randomUUID()) {
      const shim = await RawShim.attach(endpoint, port, sessionId, label);
      shims.push(shim);
      await shim.awaitHelloAck();
      return shim;
    },
    async addBrokerClient(label) {
      const client = new BrokerClient();
      brokerClients.push(client);
      await client.connect(endpoint, {
        ipc_protocol_version: IPC_PROTOCOL_VERSION,
        package_version: PACKAGE_VERSION,
        config_identity: CONFIG_IDENTITY,
        session_id: randomUUID(),
        client_label: label,
        effective_port: port,
      });
      return client;
    },
  };
}

test('the cancel message carries only a request id and rejects anything else', () => {
  const accepted = clientToBrokerMessageSchema.safeParse({ type: 'cancel_request', id: 'abc' });
  assert.equal(accepted.success, true);
  assert.equal(ipcCancelRequestMessageSchema.safeParse({ type: 'cancel_request', id: 'abc' }).success, true);
  // No client-supplied JSON-RPC id, method name or metadata may ride along:
  // the broker must not be able to act on anything the MCP client controls.
  assert.equal(
    ipcCancelRequestMessageSchema.safeParse({ type: 'cancel_request', id: 'abc', jsonrpc_id: 1 }).success,
    false,
  );
  assert.equal(ipcCancelRequestMessageSchema.safeParse({ type: 'cancel_request', id: 7 }).success, false);
  assert.equal(ipcCancelRequestMessageSchema.safeParse({ type: 'cancel_request' }).success, false);
});

test('a request queued behind a busy plugin and then cancelled never reaches the plugin, and the blocking request still completes', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('get_project_state');
  const shim = await harness.addShim('Client A');

  const blockingId = shim.sendRequest('get_project_state');
  await waitFor(() => plugin.held.has('get_project_state'), 'the plugin to hold the blocking command');

  const queuedId = shim.sendRequest('get_elements');
  await delay(50);
  assert.equal(plugin.requests('get_elements').length, 0, 'the queued command must still be waiting in the lane');

  shim.cancel(queuedId);
  plugin.release('get_project_state');

  const blocking = await shim.awaitResponse(blockingId);
  assert.equal(blocking.ok, true, 'cancelling one request must not disturb the one that was blocking the lane');
  assert.deepEqual(blocking.result, { relayed: true, command: 'get_project_state' });

  // Give the lane every chance to relay the cancelled request before judging it absent.
  await delay(100);
  assert.equal(plugin.requests('get_elements').length, 0, 'the cancelled request must never reach the plugin');
  assert.deepEqual(shim.responsesFor(queuedId), [], 'a cancelled request must receive no response at all');
});

test('an uncancelled request queued behind the same busy plugin does reach the plugin and is answered', async (t) => {
  // Control for the preceding test: same sequence, no cancellation. It proves the
  // plugin-side observation channel reports a relayed queued command when there is one.
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('get_project_state');
  const shim = await harness.addShim('Client A');

  const blockingId = shim.sendRequest('get_project_state');
  await waitFor(() => plugin.held.has('get_project_state'), 'the plugin to hold the blocking command');

  const queuedId = shim.sendRequest('get_elements');
  await delay(50);
  assert.equal(plugin.requests('get_elements').length, 0, 'the queued command must wait for the lane');

  plugin.release('get_project_state');
  assert.equal((await shim.awaitResponse(blockingId)).ok, true);
  const queued = await shim.awaitResponse(queuedId);
  assert.equal(queued.ok, true);
  assert.equal(plugin.requests('get_elements').length, 1);
});

test('a cancellation naming an unknown, foreign or already answered request changes nothing', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const shim = await harness.addShim('Client A');

  const finishedId = shim.sendRequest('get_project_state');
  assert.equal((await shim.awaitResponse(finishedId)).ok, true);

  shim.cancel(finishedId);
  shim.cancel(randomUUID());
  await delay(50);

  // Positive control on the same channel: the connection is still usable, so the
  // ignored cancellations were genuinely no-ops rather than a broken socket.
  const laterId = shim.sendRequest('get_elements');
  assert.equal((await shim.awaitResponse(laterId)).ok, true);
  assert.equal(shim.responsesFor(finishedId).length, 1, 'a late cancellation must not produce a second response');
  assert.equal(plugin.requests('get_project_state').length, 1);
});

test('one client cannot cancel another client request that reuses its id', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('get_project_state');
  const owner = await harness.addShim('Client A');
  const stranger = await harness.addShim('Client B');

  const ownedId = owner.sendRequest('get_project_state');
  await waitFor(() => plugin.held.has('get_project_state'), 'the plugin to hold the owner command');

  // Client B names Client A's id. Request ids are tracked per connection, so this
  // finds nothing to cancel.
  stranger.cancel(ownedId);
  await delay(50);

  plugin.release('get_project_state');
  const response = await owner.awaitResponse(ownedId);
  assert.equal(response.ok, true, 'a foreign cancellation must not withdraw this request');
});

test('a client that disconnects while a request waits in the lane leaves it unrelayed', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('get_project_state');
  // A second attached shim only watches broadcast status, so the test can wait
  // for the broker to notice the departure instead of guessing at the timing.
  const observer = await harness.addShim('Observer');
  const shim = await harness.addShim('Client A');
  await waitFor(() => observer.latestClientCount() === 2, 'both shims to be registered');

  shim.sendRequest('get_project_state');
  await waitFor(() => plugin.held.has('get_project_state'), 'the plugin to hold the blocking command');
  shim.sendRequest('get_elements');
  await delay(50);
  assert.equal(plugin.requests('get_elements').length, 0);

  shim.close();
  await waitFor(() => observer.latestClientCount() === 1, 'the broker to observe the disconnect');
  plugin.release('get_project_state');
  await delay(100);
  assert.equal(plugin.requests('get_elements').length, 0, 'a departed client leaves nothing to relay');

  // Control on the same channel: a shim that is still attached does get its
  // queued command relayed once the lane frees up.
  plugin.holdCommands.add('get_project_state');
  observer.sendRequest('get_project_state');
  await waitFor(() => plugin.held.has('get_project_state'), 'the control command to reach the plugin');
  const queuedId = observer.sendRequest('get_elements');
  plugin.release('get_project_state');
  assert.equal((await observer.awaitResponse(queuedId)).ok, true);
  assert.equal(plugin.requests('get_elements').length, 1);
});

test('cancelling after the plugin already has the command stops the wait without a second relay or a response', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('create_cubes');
  const shim = await harness.addShim('Client A');

  const relayedId = shim.sendRequest('create_cubes', { cubes: [] });
  await waitFor(() => plugin.held.has('create_cubes'), 'the plugin to receive the mutation');
  assert.equal(plugin.requests('create_cubes').length, 1);

  shim.cancel(relayedId);
  await delay(50);
  // Nothing is undone and nothing is sent again: the plugin still holds exactly
  // the one command it was given.
  assert.equal(plugin.requests('create_cubes').length, 1, 'a cancelled mutation must never be replayed');

  // The plugin answers late. That answer must not become a client-facing outcome.
  plugin.release('create_cubes');
  await delay(100);
  assert.deepEqual(shim.responsesFor(relayedId), [], 'no response may follow a cancelled request');

  // The controller lease was still released cleanly, so ordinary work continues.
  const laterId = shim.sendRequest('get_project_state');
  assert.equal((await shim.awaitResponse(laterId)).ok, true);
});

test('a request cancelled while its plugin relay is timing out produces no response and no replay', async (t) => {
  const harness = await createHarness(t, { requestTimeoutMs: 120 });
  const harnessPlugin = await harness.addPlugin();
  harnessPlugin.holdCommands.add('get_project_state');
  const shim = await harness.addShim('Client A');

  const id = shim.sendRequest('get_project_state');
  await waitFor(() => harnessPlugin.held.has('get_project_state'), 'the plugin to receive the command');
  shim.cancel(id);

  // Let the bridge timeout fire well after the cancellation.
  await delay(300);
  assert.deepEqual(shim.responsesFor(id), [], 'a timeout must not resurrect a cancelled request');
  assert.equal(harnessPlugin.requests('get_project_state').length, 1, 'a timed-out cancelled request is not retried');

  const laterId = shim.sendRequest('get_elements');
  assert.equal((await shim.awaitResponse(laterId)).ok, true);
});

test('a broker client withdraws a queued request through its abort signal and reports how far it got', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  plugin.holdCommands.add('get_project_state');
  const client = await harness.addBrokerClient('Client A');

  const blocking = client.request('get_project_state', {});
  await waitFor(() => plugin.held.has('get_project_state'), 'the plugin to hold the blocking command');

  const controller = new AbortController();
  const queued = client.request('get_elements', {}, undefined, controller.signal);
  await delay(50);
  assert.equal(plugin.requests('get_elements').length, 0);

  controller.abort();
  await assert.rejects(queued, (error: unknown) => {
    assert.ok(error instanceof BrokerRequestCancelledError);
    assert.equal(error.stage, 'after_send');
    assert.match(error.requestId, /^[0-9a-f-]{36}$/);
    return true;
  });

  plugin.release('get_project_state');
  assert.equal((await blocking).ok, true);
  await delay(100);
  assert.equal(plugin.requests('get_elements').length, 0, 'the withdrawn request must never reach the plugin');
});

test('a broker client asked to cancel before it writes never enqueues the request at all', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const client = await harness.addBrokerClient('Client A');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('get_elements', {}, undefined, controller.signal), (error: unknown) => {
    assert.ok(error instanceof BrokerRequestCancelledError);
    assert.equal(error.stage, 'before_send');
    return true;
  });

  await delay(50);
  assert.equal(plugin.requests('get_elements').length, 0, 'nothing may be written for an already cancelled request');

  // Positive control: the same call without a cancellation does reach the plugin,
  // so the absence above is a real refusal and not a dead connection.
  assert.equal((await client.request('get_elements', {})).ok, true);
  assert.equal(plugin.requests('get_elements').length, 1);
});

test('a broker rejects a mismatched IPC version, keeps serving, and is neither shut down nor replaced', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const compatible = await harness.addBrokerClient('Compatible client');
  assert.equal((await compatible.request('get_project_state', {})).ok, true);

  const olderClient = new BrokerClient();
  t.after(() => olderClient.close().catch(() => undefined));
  await assert.rejects(
    olderClient.connect(harness.endpoint, {
      ipc_protocol_version: IPC_PROTOCOL_VERSION - 1,
      package_version: PACKAGE_VERSION,
      config_identity: CONFIG_IDENTITY,
      session_id: randomUUID(),
      client_label: 'Older client',
      effective_port: harness.port,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrokerHandshakeError);
      assert.equal(error.reason, 'version_mismatch');
      return true;
    },
  );

  const newerShim = await RawShim.attach(
    harness.endpoint,
    harness.port,
    randomUUID(),
    'Newer client',
    IPC_PROTOCOL_VERSION + 1,
  );
  t.after(() => newerShim.close());
  await waitFor(() => newerShim.received.some((message) => message.type === 'hello_reject'), 'the rejection frame');
  const rejection = newerShim.received.find((message) => message.type === 'hello_reject');
  assert.ok(rejection && rejection.type === 'hello_reject');
  assert.equal(rejection.reason, 'version_mismatch');
  // The rejection reports what this broker speaks, which is what turns a refused
  // handshake into a diagnosable E_BROKER_VERSION_MISMATCH rather than a hang.
  assert.equal(rejection.ipc_protocol_version, IPC_PROTOCOL_VERSION);

  // The mismatch changed nothing about the running broker: same instance, still
  // listening, plugin session untouched, existing client still served.
  assert.equal(harness.server.listening, true);
  assert.equal(harness.server.instanceId, `cancel-test-${harness.port}`);
  assert.equal((await compatible.request('get_elements', {})).ok, true);
  assert.equal(plugin.requests('get_elements').length, 1);
});
