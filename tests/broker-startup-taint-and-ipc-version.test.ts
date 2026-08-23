// Two broker protections that nothing else in this suite would notice losing.
//
// The first is the unknown starting state. A broker process that has just
// started cannot know which scoped directory the Blockbench plugin still holds
// from an earlier broker, because the plugin keeps its confirmed directory
// across reconnects. `src/adapter/broker/broker-server.ts` therefore builds its
// controller lease with `initiallyTainted: true`, and the lease refuses to
// grant control until a revocation has been acknowledged. Flipping that flag to
// `false` hands the first client control over a directory nobody re-confirmed,
// and every other test in this suite stays green while it does, because the
// error codes and the relayed commands are the same either way. What changes is
// the controller state the broker passes through, which is what is asserted
// here.
//
// The second is the IPC protocol version. `IPC_PROTOCOL_VERSION` was bumped
// from 1 to 2 by the `cancel_request` message, and the broker compares a
// client's declared version to it exactly, so a broker and a stdio shim built
// from different versions refuse each other instead of speaking a mixed
// dialect. Every other test computes its version numbers as
// `IPC_PROTOCOL_VERSION ± 1`, so all of them hold just as well at 1 as at 2 and
// none of them notices a revert. The literals are pinned here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import WebSocket from 'ws';

import { BrokerServer } from '../src/adapter/broker/broker-server.js';
import { computeConfigIdentity, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import {
  IPC_PROTOCOL_VERSION,
  IpcLineDecoder,
  brokerToClientMessageSchema,
  clientToBrokerMessageSchema,
  encodeIpcMessage,
  type BrokerToClientMessage,
  type StatusEventMessage,
} from '../src/adapter/broker/ipc-protocol.js';
import { writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

/**
 * The IPC protocol version this build speaks, written out rather than derived.
 *
 * Deriving it from the symbol is what makes a revert invisible: an assertion
 * that reads `IPC_PROTOCOL_VERSION` agrees with whatever the symbol happens to
 * say. This literal is the statement that the `cancel_request` message exists
 * and that the handshake refuses the version that predates it.
 */
const EXPECTED_IPC_PROTOCOL_VERSION = 2;

/** The version that predates `cancel_request`, which a current broker refuses. */
const IPC_PROTOCOL_VERSION_BEFORE_CANCEL_REQUEST = 1;

const SECRET = 'startup-taint-secret-2468101214';
const CONFIG_IDENTITY = '0f1e2d3c4b5a6978';
const PACKAGE_VERSION = '0.1.0';
let nextPort = 42_650;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_699, 'these tests must stay inside the reserved 42650-42699 port range');
  return port;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(5);
  }
}

/** A Blockbench stand-in that answers `revoke_scope` the way the plugin does. */
class RevokingPlugin {
  readonly commands: string[] = [];
  #socket: WebSocket | null = null;

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.#socket = socket;
    const acknowledged = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type?: string; id?: string; command?: string };
        if (message.type === 'hello_ack') {
          resolve();
          return;
        }
        if (message.type !== 'request' || message.command === undefined) return;
        this.commands.push(message.command);
        const result = message.command === 'revoke_scope' ? { state: 'revoked' } : { relayed: true };
        socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }));
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
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, 'close');
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    await closed;
  }
}

/** A stdio shim stand-in speaking broker IPC directly. */
class RawShim {
  readonly received: BrokerToClientMessage[] = [];
  readonly #decoder = new IpcLineDecoder<BrokerToClientMessage>(brokerToClientMessageSchema);

  private constructor(readonly socket: Socket) {}

  static async attach(endpoint: string, port: number, label: string, ipcVersion: number): Promise<RawShim> {
    const socket = createConnection(endpoint);
    const shim = new RawShim(socket);
    socket.on('data', (chunk) => {
      for (const decoded of shim.#decoder.push(chunk)) {
        if (decoded.kind === 'message') shim.received.push(decoded.message);
      }
    });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(
      encodeIpcMessage({
        type: 'client_hello',
        ipc_protocol_version: ipcVersion,
        package_version: PACKAGE_VERSION,
        config_identity: CONFIG_IDENTITY,
        session_id: randomUUID(),
        client_label: label,
        effective_port: port,
      }),
    );
    return shim;
  }

  statusEvents(): StatusEventMessage[] {
    return this.received.filter((message): message is StatusEventMessage => message.type === 'status_event');
  }

  sendRequest(command: string): string {
    const id = randomUUID();
    this.socket.write(encodeIpcMessage({ type: 'request', id, command, params: {} }));
    return id;
  }

  async awaitResponse(id: string): Promise<{ ok: boolean; error?: { code?: string } }> {
    await waitFor(
      () => this.received.some((message) => message.type === 'response' && message.id === id),
      `a broker response for request ${id}`,
    );
    return this.received.find(
      (message): message is Extract<BrokerToClientMessage, { type: 'response' }> =>
        message.type === 'response' && message.id === id,
    )!;
  }

  close(): void {
    this.socket.destroy();
  }
}

interface Harness {
  port: number;
  endpoint: string;
  server: BrokerServer;
  addPlugin(): Promise<RevokingPlugin>;
  addShim(label: string, ipcVersion?: number): Promise<RawShim>;
}

async function createHarness(t: TestContext): Promise<Harness> {
  const port = allocatePort();
  const directory = await mkdtemp(join(tmpdir(), 'bbtnt-'));
  // A Windows named pipe name is machine-wide, so the identity is derived from
  // this harness's own mkdtemp directory: no two live harnesses can collide.
  const endpoint = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: directory,
    identity: computeConfigIdentity(directory),
  });
  const recordPath = join(directory, 'broker.json');
  const instanceId = `startup-taint-${String(port)}`;
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
    requestTimeoutMs: 15_000,
    heartbeatIntervalMs: 30_000,
    heartbeatMissLimit: 2,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 64 * 1024,
    leaseIdleTimeoutMs: 30_000,
    brokerIdleTimeoutMs: 30_000,
    clientHeartbeatIntervalMs: 30_000,
    log: () => undefined,
  });

  const plugins: RevokingPlugin[] = [];
  const shims: RawShim[] = [];
  t.after(async () => {
    for (const shim of shims) shim.close();
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
      const plugin = new RevokingPlugin(port);
      plugins.push(plugin);
      await plugin.connect();
      return plugin;
    },
    async addShim(label, ipcVersion = IPC_PROTOCOL_VERSION) {
      const shim = await RawShim.attach(endpoint, port, label, ipcVersion);
      shims.push(shim);
      return shim;
    },
  };
}

// ---------------------------------------------------------------------------
// The unknown starting state
// ---------------------------------------------------------------------------

test('a broker that has just started never grants controller ownership to its first client before a revocation clears the scoped directory it cannot see', async (t) => {
  const harness = await createHarness(t);
  const shim = await harness.addShim('First client after broker start');
  await waitFor(() => shim.received.some((message) => message.type === 'hello_ack'), 'the broker hello acknowledgement');

  // No plugin is attached, so nothing can acknowledge a revocation. A broker
  // that starts with its scoped-directory state unknown has to say so rather
  // than granting control, and the state it lands in is the observable
  // difference: with the unknown state cleared at construction the same request
  // takes the lease outright and this client is recorded as the owner.
  const answered = await shim.awaitResponse(shim.sendRequest('get_project_state'));
  assert.equal(answered.ok, false, 'a command was answered successfully with no plugin attached');
  assert.equal(answered.error?.code, 'E_PLUGIN_NOT_CONNECTED');

  const states = shim.statusEvents().map((event) => event.controller_state);
  assert.ok(
    states.includes('recovering'),
    `the broker never entered the recovering state, so it did not treat its own starting scoped-directory ` +
      `state as unknown. Observed controller states: ${JSON.stringify(states)}`,
  );
  assert.ok(
    !states.includes('owned'),
    `the broker granted controller ownership before any revocation was acknowledged. Observed controller ` +
      `states: ${JSON.stringify(states)}`,
  );
  assert.deepEqual(
    shim.statusEvents().map((event) => event.controller_owner).filter((owner) => owner !== null),
    [],
    'a client was recorded as the controller owner while the scoped-directory state was still unknown',
  );
});

test('a broker that has just started enters recovery the moment Blockbench authenticates, before any client asks for control', async (t) => {
  const harness = await createHarness(t);
  const shim = await harness.addShim('Observer attached before the plugin');
  await waitFor(() => shim.received.some((message) => message.type === 'hello_ack'), 'the broker hello acknowledgement');
  const beforePlugin = shim.statusEvents().length;

  const plugin = await harness.addPlugin();
  await waitFor(() => plugin.commands.includes('revoke_scope'), 'the scope revocation for the new plugin session');
  await waitFor(
    () => shim.statusEvents().length > beforePlugin && shim.statusEvents().at(-1)?.plugin_connected === true,
    'the status broadcast for the authenticated plugin',
  );
  await delay(200);

  const afterPlugin = shim.statusEvents().slice(beforePlugin);
  assert.ok(
    afterPlugin.some((event) => event.controller_state === 'recovering'),
    'authenticating a plugin left a freshly started broker outside the recovering state, so the broker treated ' +
      `its inherited scoped-directory state as already known. Observed: ${JSON.stringify(afterPlugin.map((event) => event.controller_state))}`,
  );
  // Positive control: the broadcasts really are being read, and they carry the
  // plugin session this test attached.
  assert.equal(shim.statusEvents().at(-1)?.plugin_connected, true, 'no status broadcast reported the attached plugin');
  assert.ok(plugin.commands.length > 0, 'the plugin recorded no command at all, so nothing was observed');
});

// ---------------------------------------------------------------------------
// The IPC protocol version
// ---------------------------------------------------------------------------

test('the broker IPC protocol version is 2, the revision that added cancel_request', () => {
  assert.equal(
    IPC_PROTOCOL_VERSION,
    EXPECTED_IPC_PROTOCOL_VERSION,
    'IPC_PROTOCOL_VERSION changed. Version 2 is the revision that added the cancel_request message; reverting ' +
      'it to 1 lets a broker without cancel_request complete a handshake with a shim that sends one, which is ' +
      'the mixed dialect the exact version comparison exists to prevent. A genuine bump has to update this ' +
      'literal and the behaviour assertions below together.',
  );
  // The message the bump was for has to be part of the dialect this version
  // names, otherwise the number is pinned but means nothing.
  assert.equal(
    clientToBrokerMessageSchema.safeParse({ type: 'cancel_request', id: 'abc' }).success,
    true,
    'the current IPC dialect does not carry cancel_request, which is what version 2 was bumped for',
  );
});

test('a broker refuses a shim declaring IPC protocol version 1 and accepts one declaring version 2', async (t) => {
  const harness = await createHarness(t);

  const old = await harness.addShim('Shim from before cancel_request', IPC_PROTOCOL_VERSION_BEFORE_CANCEL_REQUEST);
  await waitFor(
    () => old.received.some((message) => message.type === 'hello_reject' || message.type === 'hello_ack'),
    'the broker answer to a version 1 handshake',
  );
  const refusal = old.received.find((message) => message.type === 'hello_reject');
  assert.ok(
    refusal !== undefined,
    'a shim declaring IPC protocol version 1 completed the handshake. Version 1 predates cancel_request, so ' +
      'that pairing can silently drop a withdrawal instead of refusing the connection.',
  );
  assert.equal(refusal.reason, 'version_mismatch');
  assert.equal(
    refusal.ipc_protocol_version,
    EXPECTED_IPC_PROTOCOL_VERSION,
    'the refusal did not report the version this broker actually speaks',
  );

  // Control: the literal current version is accepted on the same broker, so the
  // refusal above is about the declared version and not about the handshake.
  const current = await harness.addShim('Shim speaking the current version', EXPECTED_IPC_PROTOCOL_VERSION);
  await waitFor(() => current.received.some((message) => message.type === 'hello_ack'), 'the version 2 acknowledgement');
  const acknowledgement = current.received.find((message) => message.type === 'hello_ack');
  assert.equal(
    acknowledgement?.ipc_protocol_version,
    EXPECTED_IPC_PROTOCOL_VERSION,
    'the broker acknowledged a handshake while reporting a different IPC protocol version',
  );
  assert.equal(
    current.received.some((message) => message.type === 'hello_reject'),
    false,
    'a shim declaring the current version was refused',
  );
});
