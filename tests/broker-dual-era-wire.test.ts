// One broker, two shims, two MCP wire eras.
//
// The broker is shared process-wide state. Which MCP revision a stdio shim
// happens to speak must never reach it: not into the controller lease, not
// into scope revocation or taint, not into the heartbeat, and not into how a
// client is identified after a broker or plugin restart. These tests put a
// `2026-07-28` shim and a 2025-era shim on the same broker at the same time
// and check that every one of those behaviours is decided by something other
// than the era.
//
// `tests/broker-e2e.test.ts` and `tests/broker-server.test.ts` already hold the
// broker's own contract. What is new here is the era dimension, and the
// cross-era pairing that only a raw-wire harness can set up.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

import { computeConfigIdentity, ensureRuntimeDirectory, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import { IPC_PROTOCOL_VERSION } from '../src/adapter/broker/ipc-protocol.js';
import { readBrokerRecord, writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import {
  advertisedTools,
  envelopeOf,
  errorCodeOf,
  exchange,
  legacyRequest,
  modernRequest,
  openLegacyConnection,
} from './helpers/mcp-era-wire.ts';
import { CLI_ENTRY_PATH, parseStdoutMessages, startRawStdioServer } from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { WireFakePlugin, projectStateResult, waitUntil } from './helpers/wire-plugin.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

const SECRET = 'broker-dual-era-secret-9753';
let nextPort = 42_400;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_499, 'the dual-era broker tests must stay inside the reserved 42400-42499 port range');
  return port;
}

type Era = 'legacy' | 'modern';

/** One stdio shim, already opened on its era. */
interface Shim {
  era: Era;
  session: RawStdioSession;
  /** Frame a request the way this shim's era does. */
  request(id: number | string, method: string, params?: Record<string, unknown>): Record<string, unknown>;
  /** Send a request and return the single message it produced. */
  call(id: number | string, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Every message this shim has been sent that carries `id`. */
  messagesWithId(id: number | string): Array<Record<string, unknown>>;
}

interface BrokerWorld {
  port: number;
  configPath: string;
  runtimeRoot: string;
  brokerRecordPath: string;
  brokerEndpoint: string;
  plugin: WireFakePlugin;
  addShim(era: Era, options?: { label?: string; leaseIdleTimeoutMs?: number; requestTimeoutMs?: number }): Promise<Shim>;
  attachPlugin(): Promise<void>;
  currentBrokerPid(): Promise<number | null>;
}

/** How long a lease may sit idle before the broker reclaims it. */
const LEASE_IDLE_TIMEOUT_MS = 1_000;

async function createBrokerWorld(t: TestContext, hold?: readonly string[]): Promise<BrokerWorld> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-broker-dual-era-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const runtimeRoot = await createRuntimeRoot('bbdew-');
  const brokerRuntime = join(runtimeRoot, 'minecraft-blockbench-mcp');
  const identity = computeConfigIdentity(configPath);
  const brokerRecordPath = join(brokerRuntime, `broker-${identity}.json`);
  const brokerEndpoint = ipcEndpointFor({ platform: process.platform, runtimeDir: brokerRuntime, identity });
  const plugin = new WireFakePlugin({ port, secret: SECRET, hold });
  const sessions: RawStdioSession[] = [];

  t.after(async () => {
    await plugin.close();
    await Promise.all(sessions.map((session) => session.dispose()));
    const record = await readBrokerRecord(brokerRecordPath).catch(() => null);
    if (record !== null) {
      try {
        process.kill(record.broker_pid, 'SIGKILL');
      } catch {
        // Already gone, which is the normal case.
      }
    }
    await rm(root, { recursive: true, force: true });
    await removeRuntimeRoot(runtimeRoot);
  });

  return {
    port,
    configPath,
    runtimeRoot,
    brokerRecordPath,
    brokerEndpoint,
    plugin,
    async addShim(era, options) {
      // The broker reports the controller owner by client label, so each shim
      // needs its own; without one they are indistinguishable in `health`.
      const label = options?.label ?? `${era}-shim-${String(sessions.length + 1)}`;
      const session = startRawStdioServer({
        args: ['--client-label', label],
        env: {
          BLOCKBENCH_MCP_CONFIG: configPath,
          XDG_RUNTIME_DIR: runtimeRoot,
          BLOCKBENCH_MCP_BROKER: '1',
          BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS: '2000',
          BLOCKBENCH_MCP_LEASE_IDLE_TIMEOUT_MS: String(options?.leaseIdleTimeoutMs ?? LEASE_IDLE_TIMEOUT_MS),
          BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: String(options?.requestTimeoutMs ?? 30_000),
        },
      });
      sessions.push(session);
      if (era === 'legacy') await openLegacyConnection(session, { id: 'open', protocolVersion: '2025-06-18' });
      else await exchange(session, modernRequest('open', 'tools/list'), 20_000);

      const request = (id: number | string, method: string, params: Record<string, unknown> = {}) =>
        era === 'legacy' ? legacyRequest(id, method, params) : modernRequest(id, method, params);
      return {
        era,
        session,
        request,
        call: (id, name, args = {}) => exchange(session, request(id, 'tools/call', { name, arguments: args }), 30_000),
        messagesWithId: (id) => parseStdoutMessages(session.stdoutLines()).filter((message) => message.id === id),
      };
    },
    async attachPlugin() {
      const before = plugin.requests('revoke_scope').length;
      await plugin.connect();
      await waitUntil(
        () => plugin.requests('revoke_scope').length > before,
        'the scope revocation that starts every authenticated plugin session',
      );
    },
    async currentBrokerPid() {
      const record = await readBrokerRecord(brokerRecordPath).catch(() => null);
      return record?.broker_pid ?? null;
    },
  };
}

/**
 * Poll an asynchronous condition. `waitUntil` from the plugin helper takes a
 * synchronous predicate, and a promise is always truthy, so an async check has
 * to go through this instead.
 */
async function pollUntil(
  check: () => Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Read the broker view a `health` envelope reports. */
function brokerView(message: Record<string, unknown>): Record<string, unknown> {
  return envelopeOf(message).result as Record<string, unknown>;
}

test('a 2026-07-28 shim and a 2025-era shim attach to the same broker and each sees only its own results', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  const legacy = await world.addShim('legacy');
  await world.attachPlugin();

  const modernHealth = brokerView(await modern.call(1, 'health'));
  const legacyHealth = brokerView(await legacy.call(1, 'health'));

  assert.equal(modernHealth.mode, 'brokered', 'the modern shim did not run in brokered mode');
  assert.equal(legacyHealth.mode, 'brokered', 'the legacy shim did not run in brokered mode');
  assert.equal(modernHealth.broker_connected, true, 'the modern shim never attached to the broker');
  assert.equal(legacyHealth.broker_connected, true, 'the legacy shim never attached to the broker');
  assert.equal(
    modernHealth.client_count,
    legacyHealth.client_count,
    'the two shims report a different view of how many clients the shared broker has',
  );
  assert.ok(
    (modernHealth.client_count as number) >= 2,
    `the broker reported ${String(modernHealth.client_count)} client(s); both shims should be counted`,
  );
  assert.equal(modernHealth.port, world.port, 'the modern shim reported a different WebSocket port');
  assert.equal(legacyHealth.port, world.port, 'the legacy shim reported a different WebSocket port');

  // Each shim's answers land only on its own stream.
  assert.equal(modern.messagesWithId(1).length, 1, 'the modern shim received more than its own answer');
  assert.equal(legacy.messagesWithId(1).length, 1, 'the legacy shim received more than its own answer');
});

test('discovery and health never acquire the controller lease, on either era', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  const legacy = await world.addShim('legacy');
  await world.attachPlugin();

  for (const shim of [modern, legacy]) {
    const listed = await exchange(shim.session, shim.request(10, 'tools/list'), 20_000);
    assert.ok(advertisedTools(listed).length > 0, `${shim.era}: the catalogue was not served`);
    const health = brokerView(await shim.call(11, 'health'));
    assert.equal(
      health.controller_state,
      'idle',
      `${shim.era}: listing tools or reading health took the controller lease`,
    );
    assert.equal(health.controller_owner, null, `${shim.era}: a lease owner appeared without any plugin command`);
  }
  // Neither surface reached Blockbench at all: the only plugin traffic so far
  // is the revocation that starts an authenticated session.
  assert.deepEqual(
    world.plugin.frames.filter((frame) => frame.command !== 'revoke_scope').map((frame) => frame.command),
    [],
    'a discovery or health request was relayed to Blockbench',
  );

  // Positive control on the same lease: a real plugin command does take it.
  await modern.call(12, 'get_project_state');
  const afterCommand = brokerView(await modern.call(13, 'health'));
  assert.equal(afterCommand.controller_state, 'owned', 'a plugin command did not take the controller lease');
  assert.ok(typeof afterCommand.controller_owner === 'string', 'the lease was taken but reports no owner');
});

test('controller contention between a modern shim and a legacy shim is decided without regard to era', async (t) => {
  // Run the same contention twice with the eras swapped. If the era mattered
  // anywhere in the broker, one of the two orderings would come out different.
  for (const [firstEra, secondEra] of [
    ['modern', 'legacy'],
    ['legacy', 'modern'],
  ] as Array<[Era, Era]>) {
    const world = await createBrokerWorld(t, ['get_project_state']);
    const first = await world.addShim(firstEra);
    const second = await world.addShim(secondEra);
    await world.attachPlugin();

    // The first shim's command reaches Blockbench and stays there.
    const firstCall = first.call(20, 'get_project_state');
    await waitUntil(
      () => world.plugin.requests('get_project_state').length === 1,
      `${firstEra}: the first shim's command reaching Blockbench`,
    );

    // The second shim asks while the first still holds the session.
    const refused = await second.call(20, 'get_project_state');
    assert.equal(
      errorCodeOf(envelopeOf(refused)),
      'E_CLIENT_BUSY',
      `${secondEra} behind ${firstEra}: the waiting shim was not told the session is busy`,
    );
    assert.equal(
      world.plugin.requests('get_project_state').length,
      1,
      `${secondEra} behind ${firstEra}: the refused command was relayed anyway`,
    );
    assert.deepEqual(
      first.messagesWithId(20),
      [],
      `${secondEra} behind ${firstEra}: the refusal was delivered to the wrong shim`,
    );

    // Releasing the first shim completes only the first shim's request.
    world.plugin.answer(world.plugin.heldRequests('get_project_state')[0], {
      ok: true,
      result: projectStateResult(7_001),
    });
    const answered = await firstCall;
    assert.equal(envelopeOf(answered).ok, true, `${firstEra}: the holding shim's own command did not complete`);
    assert.equal(first.messagesWithId(20).length, 1, `${firstEra}: the holding shim ended with more than one outcome`);
  }
});

test('the controller lease hands over between eras after a revocation the plugin acknowledges', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern', { leaseIdleTimeoutMs: 1_000 });
  const legacy = await world.addShim('legacy', { leaseIdleTimeoutMs: 1_000 });
  await world.attachPlugin();

  await modern.call(30, 'get_project_state');
  const owned = brokerView(await modern.call(31, 'health'));
  assert.equal(owned.controller_state, 'owned');
  const firstOwner = owned.controller_owner;

  // The modern shim's lease goes idle and the legacy shim takes over. The
  // handover must be preceded by a revocation, whichever era is arriving.
  const revocationsBefore = world.plugin.requests('revoke_scope').length;
  await pollUntil(async () => {
    const answered = await legacy.call(`handover-${String(Date.now())}`, 'get_project_state');
    return envelopeOf(answered).ok === true;
  }, 'the legacy shim taking the controller lease from the modern shim', 15_000);

  assert.ok(
    world.plugin.requests('revoke_scope').length > revocationsBefore,
    'the lease changed hands without a scope revocation, so a replacement client could inherit a grant',
  );
  const handedOver = brokerView(await legacy.call(32, 'health'));
  assert.equal(handedOver.controller_state, 'owned', 'the arriving shim did not end up owning the lease');
  assert.notEqual(handedOver.controller_owner, firstOwner, 'the lease owner did not change');
});

test('a tools/call claiming an unsupported protocol revision takes no controller lease and reaches no plugin', async (t) => {
  // The refusal has to happen before anything with a side effect runs. In
  // brokered mode that means two observation channels: the controller lease
  // the broker hands out per plugin command, and the plugin socket itself.
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  await world.attachPlugin();

  const refused = await exchange(
    modern.session,
    modernRequest(
      20,
      'tools/call',
      { name: 'get_project_state', arguments: {} },
      { protocolVersion: '1999-01-01' },
    ),
    20_000,
  );
  const error = refused.error as { code?: number; data?: Record<string, unknown> } | undefined;
  assert.equal(refused.result, undefined, 'a tool call claiming an unsupported revision was served');
  assert.equal(error?.code, -32022, 'a tool call claiming an unsupported revision must be refused with -32022');
  assert.deepEqual(error?.data?.supported, ['2026-07-28'], 'the refusal must report the supported revisions');

  const afterRefusal = brokerView(await modern.call(21, 'health'));
  assert.equal(afterRefusal.controller_state, 'idle', 'a refused tool call took the controller lease');
  assert.equal(afterRefusal.controller_owner, null, 'a refused tool call produced a lease owner');
  assert.deepEqual(
    world.plugin.frames.filter((frame) => frame.command !== 'revoke_scope').map((frame) => frame.command),
    [],
    'a tool call claiming an unsupported revision was relayed to Blockbench',
  );

  // Positive control on both channels: the same tool call with a supported
  // revision does take the lease and does reach Blockbench, so the two
  // absences above are not an artefact of a dead broker or a dead plugin.
  await modern.call(22, 'get_project_state');
  const afterAccepted = brokerView(await modern.call(23, 'health'));
  assert.equal(afterAccepted.controller_state, 'owned', 'an accepted tool call did not take the controller lease');
  assert.ok(typeof afterAccepted.controller_owner === 'string', 'the lease was taken but reports no owner');
  assert.deepEqual(
    world.plugin.frames.filter((frame) => frame.command !== 'revoke_scope').map((frame) => frame.command),
    ['get_project_state'],
    'the accepted tool call never reached Blockbench, so the plugin channel proves nothing',
  );
});

test('a shim that never speaks a plugin command is still counted, heartbeated, and released on exit', async (t) => {
  const world = await createBrokerWorld(t);
  const keeper = await world.addShim('legacy');
  const transient = await world.addShim('modern');
  await world.attachPlugin();

  const withBoth = brokerView(await keeper.call(40, 'health'));
  assert.ok((withBoth.client_count as number) >= 2, 'the transient shim was never registered with the broker');

  await transient.session.dispose();
  await pollUntil(async () => {
    const health = brokerView(await keeper.call(`drop-${String(Date.now())}`, 'health'));
    return (health.client_count as number) < (withBoth.client_count as number);
  }, 'the broker noticing that the modern shim went away', 15_000);

  // Positive control: the surviving shim is still fully usable afterwards.
  const survivor = brokerView(await keeper.call(41, 'health'));
  assert.equal(survivor.broker_connected, true, 'the surviving shim lost its broker attachment');
  assert.equal(survivor.mode, 'brokered');
});

test('a plugin reconnect re-establishes the scope gate for a modern shim exactly as for a legacy one', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  await world.attachPlugin();
  await modern.call(50, 'get_project_state');

  const revocationsBefore = world.plugin.requests('revoke_scope').length;
  await world.plugin.disconnect();
  await world.attachPlugin();
  assert.ok(
    world.plugin.requests('revoke_scope').length > revocationsBefore,
    'a reconnecting plugin was not asked to give up whatever scoped directory it still held',
  );

  // A later request recovers on the reattached plugin, which is the demand
  // recovery path, and it works the same for a modern shim.
  const recovered = await modern.call(51, 'get_project_state');
  assert.equal(envelopeOf(recovered).ok, true, 'a later request did not recover after the plugin reconnected');
  assert.equal(modern.messagesWithId(51).length, 1, 'the recovered request produced more than one outcome');
});

test('a modern shim re-elects a broker after the broker process is replaced', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  await world.attachPlugin();
  assert.equal(envelopeOf(await modern.call(60, 'get_project_state')).ok, true, 'the modern shim never worked');

  const firstRecord = await readBrokerRecord(world.brokerRecordPath);
  assert.ok(firstRecord !== null, 'no broker was elected for the modern shim');
  process.kill(firstRecord.broker_pid, 'SIGKILL');

  // A killed broker cannot tidy up after itself, and re-election is driven by
  // demand: a later plugin command is what makes the shim notice the dead
  // endpoint and elect a replacement. The plugin has to come back too, because
  // its WebSocket died with the broker that owned the listener.
  const failures: string[] = [];
  let recovered = false;
  for (let attempt = 0; attempt < 12 && !recovered; attempt += 1) {
    const envelope = envelopeOf(await modern.call(`recover-${String(attempt)}`, 'get_project_state'));
    if (envelope.ok === true) {
      recovered = true;
      break;
    }
    failures.push(String(errorCodeOf(envelope)));
    try {
      await world.attachPlugin();
    } catch {
      // The replacement listener may not be up yet; the next attempt retries.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(recovered, `a later request never recovered on a replacement broker; saw ${JSON.stringify(failures)}`);
  assert.ok(
    failures.every((code) => code === 'E_BROKER_UNAVAILABLE' || code === 'E_PLUGIN_NOT_CONNECTED'),
    `recovery reported an unexpected failure on the way: ${JSON.stringify(failures)}`,
  );

  const secondRecord = await readBrokerRecord(world.brokerRecordPath);
  assert.ok(secondRecord !== null, 'no replacement broker record was written');
  assert.notEqual(
    secondRecord.broker_instance_id,
    firstRecord.broker_instance_id,
    'the modern shim reattached to the broker instance it had just killed',
  );
  const health = brokerView(await modern.call(61, 'health'));
  assert.equal(health.mode, 'brokered', 'the modern shim fell out of brokered mode after the broker died');
  assert.equal(health.broker_connected, true, 'the modern shim never attached to the replacement broker');
});

test('a broker speaking a different IPC version is reported to a modern shim and is neither stopped nor replaced', async (t) => {
  const world = await createBrokerWorld(t);
  // Stand in for a broker built before the cancel_request message existed: it
  // answers the handshake far enough to state its version and refuse. A record
  // that merely points at nothing would be indistinguishable from a stale one,
  // so this has to be a real listener.
  const incompatibleVersion = IPC_PROTOCOL_VERSION - 1;
  const hellos: Array<Record<string, unknown>> = [];
  const incompatibleBroker = createServer((socket: Socket) => {
    let buffered = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line !== '') {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === 'client_hello') {
            hellos.push(message);
            socket.write(
              `${JSON.stringify({
                type: 'hello_reject',
                reason: 'version_mismatch',
                ipc_protocol_version: incompatibleVersion,
                package_version: '0.1.0',
              })}\n`,
            );
            socket.end();
          }
        }
        newline = buffered.indexOf('\n');
      }
    });
  });
  t.after(() => new Promise<void>((resolve) => incompatibleBroker.close(() => resolve())));

  // A live process to name as the incompatible broker's owner. It has to be a
  // real pid so "was it signalled?" is answerable, and it must not be this
  // test process, which the world teardown would then SIGKILL.
  const standIn = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 3600_000);'], {
    stdio: 'ignore',
  });
  t.after(() => {
    standIn.kill('SIGKILL');
  });
  await waitUntil(() => typeof standIn.pid === 'number', 'the stand-in broker owner starting');

  // The runtime directory is derived from the rendezvous record, never from the
  // endpoint: on Windows the endpoint is a named pipe whose `dirname` is
  // `\\.\pipe`, a device namespace that is not the runtime directory and never
  // holds the record `writeBrokerRecordAtomic` writes below.
  await ensureRuntimeDirectory(dirname(world.brokerRecordPath));
  await new Promise<void>((resolve, reject) => {
    incompatibleBroker.once('error', reject);
    incompatibleBroker.listen(world.brokerEndpoint, resolve);
  });
  await writeBrokerRecordAtomic(world.brokerRecordPath, {
    endpoint: world.brokerEndpoint,
    broker_instance_id: 'incompatible-broker-instance',
    broker_pid: standIn.pid as number,
    ipc_protocol_version: incompatibleVersion,
    package_version: '0.1.0',
    ws_port: world.port,
  });

  const modern = await world.addShim('modern');
  const health = brokerView(await modern.call(70, 'health'));

  assert.ok(hellos.length > 0, 'the modern shim never tried to attach, so nothing about compatibility was tested');
  assert.equal(health.broker_connected, false, 'the modern shim reported attaching to an incompatible broker');
  const codes = (health.setup_errors as Array<{ code: string }>).map((issue) => issue.code);
  assert.ok(
    codes.length > 0,
    `an incompatible broker produced no setup error, so nothing was reported: ${JSON.stringify(health)}`,
  );

  const record = await readBrokerRecord(world.brokerRecordPath);
  assert.equal(
    record?.broker_instance_id,
    'incompatible-broker-instance',
    'the incompatible broker record was replaced; an endpoint this build cannot speak to must be left alone',
  );
  assert.equal(
    record?.ipc_protocol_version,
    incompatibleVersion,
    'the incompatible broker record was rewritten to a version this build speaks',
  );
  assert.ok(incompatibleBroker.listening, 'the incompatible endpoint was shut down instead of being left alone');
  assert.equal(
    standIn.killed || standIn.exitCode !== null,
    false,
    'the process the incompatible broker record names as its owner was terminated; an endpoint this build ' +
      'cannot speak to must be reported, never stopped',
  );
});

test('no MCP protocol version, capability, or client identity reaches the broker rendezvous record', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  const legacy = await world.addShim('legacy');
  await world.attachPlugin();
  await modern.call(80, 'get_project_state');
  await legacy.call(80, 'health');

  const record = await readBrokerRecord(world.brokerRecordPath);
  const serialized = JSON.stringify(record);
  for (const forbidden of [
    '2026-07-28',
    '2025-06-18',
    'io.modelcontextprotocol',
    'clientCapabilities',
    'clientInfo',
    'listChanged',
    'era-matrix-client',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `the broker rendezvous record carries the MCP-level value ${forbidden}: ${serialized}`,
    );
  }
  // Positive control: the record does carry the things it is supposed to, so
  // the absence above is not an empty file.
  assert.equal(record.ipc_protocol_version, IPC_PROTOCOL_VERSION);
  assert.equal(record.ws_port, world.port);
  assert.ok(typeof record.broker_instance_id === 'string' && record.broker_instance_id.length > 0);
});

test('no MCP protocol version, capability, or client identity reaches a plugin protocol envelope', async (t) => {
  const world = await createBrokerWorld(t);
  const modern = await world.addShim('modern');
  await world.attachPlugin();
  await modern.call(90, 'get_project_state');
  await modern.call(91, 'health');

  assert.ok(world.plugin.frames.length > 0, 'no plugin frame was captured, so this scan has nothing to look at');
  const serialized = JSON.stringify(world.plugin.frames);
  for (const forbidden of [
    '2026-07-28',
    '2025-06-18',
    'io.modelcontextprotocol',
    'clientCapabilities',
    'clientInfo',
    'resultType',
    'cacheScope',
    'era-matrix-client',
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `a plugin protocol envelope carries the MCP-level value ${forbidden}: ${serialized.slice(0, 600)}`,
    );
  }
  // Positive control: the frames the scan read are real relayed commands.
  assert.ok(
    world.plugin.requests('get_project_state').length >= 1,
    'the scan read no relayed command, so it proves nothing about what a relay carries',
  );
});
