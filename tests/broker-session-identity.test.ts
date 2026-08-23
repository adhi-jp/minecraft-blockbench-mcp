// Who is allowed to speak for a `session_id` on the broker IPC endpoint.
//
// The controller lease is keyed by `session_id`, and the plugin's confirmed
// scoped directory is keyed by the same value through the lease's scope era. A
// second IPC peer that simply declares the current holder's `session_id` used
// to inherit both: `#registerClient` validated only `ipc_protocol_version` and
// `config_identity`, so the duplicate hello was acknowledged, and
// `ControllerLease.acquire` then short-circuited on `owner === sessionId` and
// granted control with no fresh `revoke_scope`.
//
// These tests drive a real `BrokerServer` against a fake plugin. The impostor
// is a raw IPC shim so it can declare any `session_id` it likes, the way a
// second process on the same machine could.
//
// The refusal has to separate an impostor from the documented reattach path by
// state rather than by timing: `BrokerClient` reconnects with the *same*
// `session_id` after its socket drops, and that must keep working. So every
// refusal test here is paired with a reattach test that performs the same
// duplicate `session_id` hello *after* the previous connection deregistered,
// and requires it to be acknowledged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
  IpcLineDecoder,
  brokerToClientMessageSchema,
  encodeIpcMessage,
  type BrokerToClientMessage,
  type ClientHelloMessage,
  type HelloAckMessage,
  type HelloRejectMessage,
  type IpcResponseMessage,
  type StatusEventMessage,
} from '../src/adapter/broker/ipc-protocol.js';
import { writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

const SECRET = 'session-identity-secret-1234567890';
const CONFIG_IDENTITY = '0f1e2d3c4b5a6978';
const PACKAGE_VERSION = '0.1.0';
let nextPort = 42_700;

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
 * A Blockbench plugin stand-in that answers `revoke_scope` the way the shipped
 * plugin does and records every frame it was handed, so a test can count what
 * the broker actually relayed.
 */
class RecordingPlugin {
  readonly frames: PluginRequestFrame[] = [];
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
 * exact `session_id` it declares — including one that belongs to somebody else.
 */
class RawShim {
  readonly received: BrokerToClientMessage[] = [];
  readonly #decoder = new IpcLineDecoder<BrokerToClientMessage>(brokerToClientMessageSchema);
  closed = false;

  private constructor(readonly socket: Socket) {}

  static async attach(endpoint: string, port: number, sessionId: string, label: string): Promise<RawShim> {
    const socket = createConnection(endpoint);
    const shim = new RawShim(socket);
    socket.on('data', (chunk) => {
      for (const decoded of shim.#decoder.push(chunk)) {
        if (decoded.kind === 'message') shim.received.push(decoded.message);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      shim.closed = true;
    });
    await once(socket, 'connect');
    const hello: ClientHelloMessage = {
      type: 'client_hello',
      ipc_protocol_version: IPC_PROTOCOL_VERSION,
      package_version: PACKAGE_VERSION,
      config_identity: CONFIG_IDENTITY,
      session_id: sessionId,
      client_label: label,
      effective_port: port,
    };
    socket.write(encodeIpcMessage(hello));
    return shim;
  }

  messagesOfType<T extends BrokerToClientMessage['type']>(type: T): Extract<BrokerToClientMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<BrokerToClientMessage, { type: T }> => message.type === type,
    );
  }

  async awaitHelloAck(): Promise<void> {
    await waitFor(() => this.messagesOfType('hello_ack').length > 0, 'the broker hello acknowledgement');
  }

  /**
   * Waits for whichever answer the broker gives this hello. Waiting for both
   * outcomes rather than only for the refusal is deliberate: a broker that
   * acknowledges a duplicate `session_id` then fails the assertion by naming
   * what it sent instead, rather than by timing out with nothing to show.
   */
  async awaitHelloOutcome(): Promise<HelloAckMessage | HelloRejectMessage> {
    await waitFor(
      () => this.messagesOfType('hello_ack').length > 0 || this.messagesOfType('hello_reject').length > 0,
      'the broker answer to the client_hello',
    );
    const refusals = this.messagesOfType('hello_reject');
    return refusals.length > 0 ? refusals[0] : this.messagesOfType('hello_ack')[0];
  }

  sendRequest(command: string, params: unknown = {}): string {
    const id = randomUUID();
    this.socket.write(encodeIpcMessage({ type: 'request', id, command, params }));
    return id;
  }

  responsesFor(id: string): IpcResponseMessage[] {
    return this.messagesOfType('response').filter((message) => message.id === id);
  }

  async awaitResponse(id: string): Promise<IpcResponseMessage> {
    await waitFor(() => this.responsesFor(id).length > 0, `a broker response for request ${id}`);
    return this.responsesFor(id)[0];
  }

  latestStatus(): StatusEventMessage | null {
    const events = this.messagesOfType('status_event');
    return events.length === 0 ? null : events[events.length - 1];
  }

  /** Ends the connection the way a shim does when it is shutting down cleanly. */
  sendBye(): void {
    this.socket.write(encodeIpcMessage({ type: 'bye' }));
  }

  close(): void {
    this.socket.destroy();
  }
}

interface Harness {
  port: number;
  endpoint: string;
  server: BrokerServer;
  addPlugin(): Promise<RecordingPlugin>;
  /** Attaches a shim and waits for the acknowledgement. */
  addShim(label: string, sessionId?: string): Promise<RawShim>;
  /** Attaches a shim and returns without requiring any particular answer. */
  attachShim(label: string, sessionId: string): Promise<RawShim>;
  addBrokerClient(label: string, sessionId: string): Promise<BrokerClient>;
}

async function createHarness(t: TestContext, overrides: Partial<BrokerServerOptions> = {}): Promise<Harness> {
  const port = nextPort++;
  assert.ok(port <= 42_749, 'session identity tests must stay inside the reserved 42700-42749 port range');
  const directory = await mkdtemp(join(tmpdir(), 'bbsid-'));
  // A Windows named pipe name is machine-wide, so the identity is derived from
  // this harness's own mkdtemp directory: no two live harnesses can collide.
  const endpoint = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: directory,
    identity: computeConfigIdentity(directory),
  });
  const recordPath = join(directory, 'broker.json');
  const instanceId = `session-identity-test-${String(port)}`;
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

  const plugins: RecordingPlugin[] = [];
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

  const attachShim = async (label: string, sessionId: string): Promise<RawShim> => {
    const shim = await RawShim.attach(endpoint, port, sessionId, label);
    shims.push(shim);
    return shim;
  };

  return {
    port,
    endpoint,
    server,
    async addPlugin() {
      const plugin = new RecordingPlugin(port);
      plugins.push(plugin);
      await plugin.connect();
      return plugin;
    },
    async addShim(label, sessionId = randomUUID()) {
      const shim = await attachShim(label, sessionId);
      await shim.awaitHelloAck();
      return shim;
    },
    attachShim,
    async addBrokerClient(label, sessionId) {
      const client = new BrokerClient();
      brokerClients.push(client);
      await client.connect(endpoint, {
        ipc_protocol_version: IPC_PROTOCOL_VERSION,
        package_version: PACKAGE_VERSION,
        config_identity: CONFIG_IDENTITY,
        session_id: sessionId,
        client_label: label,
        effective_port: port,
      });
      return client;
    },
  };
}

/**
 * Waits until a witness shim's `status_event` reports `expected` registered
 * clients, which is how a test observes that the broker finished deregistering
 * a connection that went away.
 */
async function waitForClientCount(witness: RawShim, expected: number): Promise<void> {
  await waitFor(
    () => witness.latestStatus()?.client_count === expected,
    `the broker to report ${String(expected)} registered client(s)`,
  );
}

test('a second IPC peer declaring the connected holder session_id is refused with hello_reject session_in_use', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const holderSession = randomUUID();
  const holder = await harness.addShim('holder-label', holderSession);
  const first = await holder.awaitResponse(holder.sendRequest('get_project_state'));
  assert.equal(first.ok, true, 'the holder must own the lease before the impostor arrives');

  const impostor = await harness.attachShim('impostor-label', holderSession);
  const outcome = await impostor.awaitHelloOutcome();

  assert.equal(outcome.type, 'hello_reject', 'a hello declaring a live session_id must be refused, not acknowledged');
  assert.equal(outcome.type === 'hello_reject' && outcome.reason, 'session_in_use');
  assert.equal(outcome.ipc_protocol_version, IPC_PROTOCOL_VERSION);
  assert.equal(impostor.messagesOfType('hello_ack').length, 0, 'a refused hello must never also be acknowledged');
  assert.equal(impostor.messagesOfType('status_event').length, 0, 'a refused peer must not be told the broker status');
  await waitFor(() => impostor.closed, 'the refused connection to be closed by the broker');
  // The holder is untouched: it keeps its lease and the plugin saw no new
  // revocation, so its confirmed scoped directory was never re-opened.
  assert.equal(plugin.requests('revoke_scope').length, 1);
  const second = await holder.awaitResponse(holder.sendRequest('get_project_state'));
  assert.equal(second.ok, true, 'the holder must keep working after the impostor is refused');
});

test('a refused duplicate session_id peer relays nothing and leaves controller_owner with the holder', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const holderSession = randomUUID();
  const holder = await harness.addShim('holder-label', holderSession);
  assert.equal((await holder.awaitResponse(holder.sendRequest('get_project_state'))).ok, true);
  assert.equal(holder.latestStatus()?.controller_owner, 'holder-label');
  const relayedBefore = plugin.requests('get_project_state').length;
  const revocationsBefore = plugin.requests('revoke_scope').length;

  // Deliberately not asserted on here: this test measures what the impostor
  // could reach, whatever the broker answered its hello. Under the defect the
  // hello was acknowledged, the request was relayed, and controller_owner moved
  // to the impostor's label with no second revoke_scope, so these are the
  // assertions that name the damage rather than the handshake.
  const impostor = await harness.attachShim('impostor-label', holderSession);
  await impostor.awaitHelloOutcome();
  const impostorRequest = impostor.sendRequest('get_project_state');
  await delay(150);

  assert.equal(
    plugin.requests('get_project_state').length,
    relayedBefore,
    'a refused peer must not have anything relayed to the plugin',
  );
  assert.equal(
    plugin.requests('revoke_scope').length,
    revocationsBefore,
    'the scope era must not be disturbed by a refused peer',
  );
  // Read the owner from a status the broker sent to a client it trusts.
  const witness = await harness.addShim('witness-label');
  assert.equal(witness.latestStatus()?.controller_owner, 'holder-label');
  assert.equal(witness.latestStatus()?.client_count, 2, 'the refused peer must not be counted as a client');
  assert.equal(impostor.responsesFor(impostorRequest).length, 0, 'a refused peer must receive no response');
});

test('a second peer with its own session_id is granted control only after a fresh acknowledged revoke_scope', async (t) => {
  // The positive control for the two tests above: when the second peer is a
  // genuinely different session, the revocation count does move, so an
  // unchanged count really is evidence of a refusal and not of a counter that
  // never increments.
  const harness = await createHarness(t, { leaseIdleTimeoutMs: 200 });
  const plugin = await harness.addPlugin();
  const first = await harness.addShim('first-label', randomUUID());
  assert.equal((await first.awaitResponse(first.sendRequest('get_project_state'))).ok, true);
  assert.equal(plugin.requests('revoke_scope').length, 1);

  const second = await harness.addShim('second-label', randomUUID());
  // Control is not simply taken: while the first client still holds the lease
  // the second is told the plugin is busy, naming the holder by label only.
  const busy = await second.awaitResponse(second.sendRequest('get_project_state'));
  assert.equal(busy.ok, false);
  assert.equal(busy.error?.code, 'E_CLIENT_BUSY');
  assert.equal((busy.error?.details as { owner?: string } | undefined)?.owner, 'first-label');

  await waitFor(() => first.latestStatus()?.controller_state === 'idle', 'the first client lease to expire');
  const granted = await second.awaitResponse(second.sendRequest('get_project_state'));
  assert.equal(granted.ok, true);
  assert.equal(plugin.requests('revoke_scope').length, 2, 'a different session must pay for a fresh revocation');
  const revocation = plugin.requests('revoke_scope')[1];
  const relayed = plugin.requests('get_project_state')[1];
  assert.ok(
    plugin.frames.indexOf(revocation) < plugin.frames.indexOf(relayed),
    'the revocation must reach the plugin before the new owner relays anything',
  );
});

test('a shim whose connection dropped reattaches with the same session_id and is acknowledged', async (t) => {
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const session = randomUUID();
  const witness = await harness.addShim('witness-label');
  const original = await harness.addShim('shim-label', session);
  assert.equal((await original.awaitResponse(original.sendRequest('get_project_state'))).ok, true);
  await waitForClientCount(witness, 2);

  // The socket dies without a `bye`, the way a shim that lost its connection
  // does, and the broker deregisters it.
  original.close();
  await waitForClientCount(witness, 1);

  const reattached = await harness.attachShim('shim-label', session);
  await reattached.awaitHelloAck();
  assert.equal(reattached.messagesOfType('hello_reject').length, 0, 'a reattach must never be refused');
  const afterReattach = await reattached.awaitResponse(reattached.sendRequest('get_project_state'));
  assert.equal(afterReattach.ok, true, 'the reattached shim must be able to relay again');
  // The same session_id owns the same scope era, so reclaiming control costs no
  // second revocation.
  assert.equal(plugin.requests('revoke_scope').length, 1);
  assert.equal(witness.latestStatus()?.controller_owner, 'shim-label');
});

test('a hello declaring a session_id held by a client that already sent bye is acknowledged', async (t) => {
  const harness = await createHarness(t);
  await harness.addPlugin();
  const session = randomUUID();
  const witness = await harness.addShim('witness-label');
  const departing = await harness.addShim('departing-label', session);
  await waitForClientCount(witness, 2);

  departing.sendBye();
  await waitForClientCount(witness, 1);

  const successor = await harness.attachShim('successor-label', session);
  await successor.awaitHelloAck();
  assert.equal(successor.messagesOfType('hello_reject').length, 0);
  assert.equal((await successor.awaitResponse(successor.sendRequest('get_project_state'))).ok, true);
});

test('a BrokerClient that closed reconnects with the same session_id and keeps control without a new revoke_scope', async (t) => {
  // The shipped reattach path, not a raw shim: `BrokerClient.connect` reuses the
  // session_id its stdio shim was started with, which is what makes the refusal
  // above dangerous if it were keyed on anything but a live connection.
  const harness = await createHarness(t);
  const plugin = await harness.addPlugin();
  const session = randomUUID();
  const witness = await harness.addShim('witness-label');
  const client = await harness.addBrokerClient('broker-client-label', session);
  assert.equal((await client.request('get_project_state', {})).ok, true);
  await waitForClientCount(witness, 2);

  await client.close();
  await waitForClientCount(witness, 1);

  const acknowledgement = await client.connect(harness.endpoint, {
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: PACKAGE_VERSION,
    config_identity: CONFIG_IDENTITY,
    session_id: session,
    client_label: 'broker-client-label',
    effective_port: harness.port,
  });
  assert.equal(acknowledgement.type, 'hello_ack');
  assert.equal(acknowledgement.ipc_protocol_version, IPC_PROTOCOL_VERSION);
  assert.equal((await client.request('get_project_state', {})).ok, true);
  assert.equal(plugin.requests('revoke_scope').length, 1, 'reattaching with the same session_id revokes nothing');
  assert.equal(plugin.requests('get_project_state').length, 2);
});
