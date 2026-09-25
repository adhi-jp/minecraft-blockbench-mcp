// A `hello_reject` naming `session_in_use` must never cost a live broker its
// endpoint.
//
// `BrokerServer` refuses a `client_hello` with `session_in_use` precisely
// because it is running and already has a still-connected client holding that
// `session_id`. Every other handshake failure leaves the broker's liveness
// unknown, so `probe()` in `src/adapter/cli.ts` reporting "nobody answered" is
// the right conclusion for them: `electOrAttach` then runs `startBroker`, which
// unlinks the endpoint socket file and spawns a replacement. Drawing that same
// conclusion from `session_in_use` destroys a working broker.
//
// These tests drive the built `dist/adapter/cli.js` against a stand-in broker
// that answers exactly the way `BrokerServer` does, so `npm run build` must
// precede this file. Three channels are observed: who owns the endpoint (asked
// by speaking broker IPC to it), the rendezvous record, and a process scan for
// spawned `__broker` processes. The stale-record test is the positive control
// that proves all three do move when the endpoint really is dead — without it,
// an assertion that merely cannot see a takeover would read as proof there was
// none. An inode comparison was tried first and is exactly that trap: the
// kernel reuses the freed inode number for the socket bound in its place, so
// the inode matches whether or not the endpoint was destroyed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { ensureRuntimeDirectory, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import { IPC_PROTOCOL_VERSION } from '../src/adapter/broker/ipc-protocol.js';
import { readBrokerRecord, writeBrokerRecordAtomic, type BrokerRecord } from '../src/adapter/broker/rendezvous.js';
import { ADAPTER_VERSION } from '../src/adapter/mcp-server.js';
import { findProcessPids, hasArgument } from './helpers/process-scan.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { platformHasCapability } from './platform-capabilities.ts';

const SECRET = 'session-in-use-endpoint-secret-123456';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');

/**
 * The setup issue a refused shim must report. The code stays
 * `E_BROKER_UNAVAILABLE` — no broker is available *to this shim* — but the
 * default message for that code ("No healthy broker could be reached or
 * started.") would be a false statement here, because the broker that refused
 * us is running and serving its other clients.
 */
const SESSION_IN_USE_SETUP_MESSAGE =
  'The running broker refused this session id because a connected client already holds it.';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let nextPort = 42_750;

interface World {
  root: string;
  runtimeRoot: string;
  configPath: string;
  identity: string;
  port: number;
  endpoint: string;
  recordPath: string;
  lockPath: string;
}

/**
 * Who is bound at the endpoint right now, learned by speaking broker IPC to it.
 *
 * This is the channel that tells "the same broker still owns this endpoint"
 * apart from "something else was bound here in its place". A socket file's inode
 * cannot: the kernel readily hands the same inode number back to a socket bound
 * immediately after the old one was unlinked, so inode equality holds in both
 * cases and proves nothing.
 */
type EndpointOwner =
  | { kind: 'unreachable' }
  | { kind: 'hello_ack'; brokerInstanceId: string }
  | { kind: 'hello_reject'; reason: string };

/** What the refusing stand-in broker answers a well-formed hello. */
const OWNED_BY_REFUSING_BROKER: EndpointOwner = { kind: 'hello_reject', reason: 'session_in_use' };

interface Envelope {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface SetupIssueShape {
  code: string;
  message: string;
}

/**
 * Every live `__broker` process started for `configPath`.
 *
 * `buildBrokerSpawnArgs` lays the command line out as
 * `<node> <cli> __broker --config <configPath>`, and every test here writes its
 * config into a fresh `mkdtemp` directory, so an exact argv-token match on both
 * `__broker` and that path can only be a broker this test's shim spawned. This
 * is the one channel that observes the spawn directly rather than through its
 * after-effects; the CLI passes `node:child_process.spawn` to
 * `spawnDetachedBroker` unmodified, so there is no seam to intercept.
 *
 * `tests/helpers/process-scan.ts` supplies the same argument match on Linux,
 * macOS and Windows. It is deliberately not allowed to answer "none" on a
 * platform it cannot enumerate: the assertions below read an empty list as
 * proof that no broker was spawned, so a lookup that could not look has to
 * throw rather than agree with them.
 */
async function brokerPidsForConfig(configPath: string): Promise<number[]> {
  return findProcessPids((entry) => hasArgument(entry, '__broker') && hasArgument(entry, configPath));
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Whether something is bound at `endpoint` and accepting connections, asked the
 * only way that means the same thing on both transports: by connecting to it.
 *
 * `stat` and `access` cannot answer this. A POSIX endpoint is a socket file and
 * they see it; a Windows endpoint is a named pipe in the `\\.\pipe` namespace,
 * which is not a filesystem object at all, so they report ENOENT for a pipe that
 * is bound and serving. A connect attempt is refused for an endpoint that is
 * absent, unlinked, or has nothing listening behind it, on either platform.
 *
 * Nothing is written, so this never disturbs a stand-in broker's hello count.
 */
async function endpointIsBound(endpoint: string): Promise<boolean> {
  const socket = createConnection(endpoint);
  socket.on('error', () => undefined);
  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), 5_000).unref();
  });
  try {
    return await Promise.race([once(socket, 'connect').then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report a cleanup failure without becoming one. Even the report is guarded:
 * an `after` hook that throws while explaining why it could not finish is the
 * failure mode this whole hook is written to avoid.
 */
function noteCleanupFailure(context: TestContext, message: string): void {
  try {
    context.diagnostic(message);
  } catch {
    // Nothing left to do; staying silent beats throwing out of the hook.
  }
}

async function createWorld(t: TestContext): Promise<World> {
  const port = nextPort++;
  assert.ok(port <= 42_799, 'these tests must stay inside the reserved 42750-42799 port range');
  const root = await mkdtemp(join(tmpdir(), 'blockbench-session-in-use-'));
  // The runtime root lives outside `root`: a socket path built under
  // `os.tmpdir()` does not fit in a macOS `sun_path`, and binding an over-long
  // one fails silently. See `tests/helpers/runtime-root.ts`.
  const runtimeRoot = await createRuntimeRoot('bbsiu-');
  const brokerRuntime = join(runtimeRoot, 'minecraft-blockbench-mcp');
  // This is the directory every rendezvous record below is written into, and on
  // POSIX it is also where the endpoint socket lives. Created the way the
  // adapter creates it.
  await ensureRuntimeDirectory(brokerRuntime);
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const identity = createHash('sha256').update(configPath).digest('hex').slice(0, 16);
  const world: World = {
    root,
    runtimeRoot,
    configPath,
    identity,
    port,
    endpoint: ipcEndpointFor({ platform: process.platform, runtimeDir: brokerRuntime, identity }),
    recordPath: join(brokerRuntime, `broker-${identity}.json`),
    lockPath: join(brokerRuntime, `broker-${identity}.lock`),
  };
  // Nothing in this hook may throw. It is what kills the brokers a test
  // spawned, and an exception raised before the kills leaves those processes
  // running with no owner — the difference between one failing assertion and a
  // test file that never finishes. Every failure is reported as a diagnostic
  // and cleanup carries on.
  t.after(async (hook: TestContext) => {
    try {
      for (const pid of await brokerPidsForConfig(configPath)) {
        try {
          // `process.kill` on Windows ignores the signal name and terminates
          // the target outright, which is exactly what a detached broker with
          // no parent left to signal it needs.
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      noteCleanupFailure(hook, `could not scan for spawned brokers of ${configPath}: ${describeError(error)}`);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      noteCleanupFailure(hook, `could not remove the test world at ${root}: ${describeError(error)}`);
    }
    try {
      await removeRuntimeRoot(runtimeRoot);
    } catch (error) {
      noteCleanupFailure(hook, `could not remove the runtime root at ${runtimeRoot}: ${describeError(error)}`);
    }
  });
  return world;
}

interface StandInBroker {
  server: Server;
  hellos: Array<Record<string, unknown>>;
}

/**
 * A broker that is alive and refuses everyone.
 *
 * It answers every `client_hello` the way `BrokerServer.#registerClient`
 * answers one whose `session_id` a still-connected client already holds:
 * `hello_reject` naming `session_in_use`, carrying the current
 * `IPC_PROTOCOL_VERSION` and package version so nothing in the shim can mistake
 * it for a dialect problem, then ends that one socket. It keeps listening
 * afterwards, which is the point — a real broker refusing one session goes on
 * serving every other client.
 */
async function startStandInBroker(t: TestContext, world: World): Promise<StandInBroker> {
  const hellos: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let buffered = '';
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
                reason: 'session_in_use',
                ipc_protocol_version: IPC_PROTOCOL_VERSION,
                package_version: ADAPTER_VERSION,
              })}\n`,
            );
            socket.end();
          }
        }
        newline = buffered.indexOf('\n');
      }
    });
  });
  // Derived from the record path, never from the endpoint: on Windows the
  // endpoint is a named pipe whose `dirname` is `\\.\pipe`, a device namespace
  // that is not the runtime directory and holds no record.
  await ensureRuntimeDirectory(dirname(world.recordPath));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(world.endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, hellos };
}

/**
 * Leaves a real unix socket file at `endpoint` with nothing listening behind
 * it: a child binds it and is then SIGKILLed, which skips the cleanup that
 * `server.close()` would do. This is the leftover `startBroker`'s `unlink`
 * exists to clear — a new broker cannot bind over it.
 */
async function leaveDeadBrokerSocket(endpoint: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('bound\\n')); setInterval(() => undefined, 3_600_000);",
      endpoint,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  child.stdout?.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the dead-broker socket was never bound')), 10_000);
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('bound')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the dead-broker socket helper exited before binding'));
    });
  });
  child.kill('SIGKILL');
  await once(child, 'exit');
}

/**
 * Connect to the endpoint, send one well-formed `client_hello`, and report the
 * answer. `config_identity` and both versions are the real ones, so a genuine
 * broker acknowledges rather than refusing for an unrelated reason.
 */
async function probeEndpointOwner(world: World): Promise<EndpointOwner> {
  // No filesystem pre-check: a Windows named pipe is invisible to `access`, and
  // an absent POSIX socket path makes the connect below fail anyway, which
  // reaches the same `unreachable` answer.
  const socket = createConnection(world.endpoint);
  socket.on('error', () => undefined);
  try {
    await once(socket, 'connect');
  } catch {
    socket.destroy();
    return { kind: 'unreachable' };
  }
  const reply = new Promise<Record<string, unknown> | null>((resolve) => {
    let buffered = '';
    const timer = setTimeout(() => resolve(null), 5_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  socket.write(
    `${JSON.stringify({
      type: 'client_hello',
      ipc_protocol_version: IPC_PROTOCOL_VERSION,
      package_version: ADAPTER_VERSION,
      config_identity: world.identity,
      session_id: randomUUID(),
      client_label: 'endpoint-owner-probe',
      effective_port: world.port,
    })}\n`,
  );
  const message = await reply;
  socket.destroy();
  if (message === null) return { kind: 'unreachable' };
  if (message.type === 'hello_ack') {
    return { kind: 'hello_ack', brokerInstanceId: String(message.broker_instance_id) };
  }
  if (message.type === 'hello_reject') return { kind: 'hello_reject', reason: String(message.reason) };
  return { kind: 'unreachable' };
}

function parseEnvelope(toolResult: unknown): Envelope {
  const content = (toolResult as { content?: Array<{ type: string; text: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'tool result must carry text content');
  return JSON.parse(content[0].text) as Envelope;
}

async function callEnvelope(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  return parseEnvelope(await client.callTool({ name, arguments: args }));
}

function brokerSetupIssues(health: Envelope): SetupIssueShape[] {
  const issues = (health.result?.setup_errors ?? []) as SetupIssueShape[];
  return issues.filter((issue) => issue.code.startsWith('E_BROKER_'));
}

async function launchShim(t: TestContext, world: World, label: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('BLOCKBENCH_MCP_')) env[key] = value;
  }
  env.BLOCKBENCH_MCP_CONFIG = world.configPath;
  env.BLOCKBENCH_MCP_RUNTIME_DIR = world.runtimeRoot;
  env.BLOCKBENCH_MCP_BROKER = '1';
  env.BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS = '5000';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--client-label', label],
    env,
    cwd: projectRoot,
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(String(chunk)));
  const client = new Client({ name: label, version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(
      `${label} could not initialize: ${error instanceof Error ? error.message : String(error)}\n` +
        `Child stderr:\n${stderrChunks.join('')}`,
    );
  }
  t.after(() => client.close().catch(() => undefined));
  return client;
}

test('a broker refusing client_hello with session_in_use keeps its endpoint file and is never replaced by a spawned broker', async (t) => {
  const world = await createWorld(t);
  const standIn = await startStandInBroker(t, world);
  const liveRecord: BrokerRecord = {
    endpoint: world.endpoint,
    broker_instance_id: 'live-broker-already-holding-the-session',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: ADAPTER_VERSION,
    ws_port: world.port,
  };
  await writeBrokerRecordAtomic(world.recordPath, liveRecord);
  assert.equal(
    await endpointIsBound(world.endpoint),
    true,
    'the stand-in broker is not bound at its endpoint, so nothing below could observe it being preserved',
  );
  assert.deepEqual(
    await probeEndpointOwner(world),
    OWNED_BY_REFUSING_BROKER,
    'the refusing broker must own the endpoint before the shim runs',
  );

  const client = await launchShim(t, world, 'Refused session client');
  const health = await callEnvelope(client, 'health');
  assert.equal(health.ok, true, 'the shim must keep serving MCP after the broker refuses it');

  // The reported condition: E_BROKER_UNAVAILABLE, but never the message that
  // claims no healthy broker exists, and never a version mismatch.
  assert.deepEqual(brokerSetupIssues(health), [
    { code: 'E_BROKER_UNAVAILABLE', message: SESSION_IN_USE_SETUP_MESSAGE },
  ]);
  const tool = await callEnvelope(client, 'get_project_state');
  assert.equal(tool.error?.code, 'E_BROKER_UNAVAILABLE');

  // Channel 1: the endpoint file survives and still belongs to the same broker.
  assert.equal(
    await endpointIsBound(world.endpoint),
    true,
    'the live broker endpoint stopped accepting connections: on POSIX its socket file was unlinked out from ' +
      'under it, on Windows its pipe was taken away',
  );
  assert.equal(standIn.hellos.length, 2, 'the shim must ask once and report, not retry into a takeover');
  assert.deepEqual(
    await probeEndpointOwner(world),
    OWNED_BY_REFUSING_BROKER,
    'the endpoint no longer routes to the broker that owned it before the shim ran',
  );
  assert.equal(standIn.hellos.length, 3, 'the endpoint must still route into the same stand-in broker process');
  assert.equal(standIn.server.listening, true, 'the refusing broker must still be serving its other clients');

  // Channel 2: no replacement broker process exists.
  assert.deepEqual(
    await brokerPidsForConfig(world.configPath),
    [],
    'a session_in_use refusal spawned a replacement broker against a healthy one',
  );

  // Channel 3: the rendezvous record still names the live broker.
  assert.deepEqual(await readBrokerRecord(world.recordPath), liveRecord);
  assert.equal(
    await pathExists(world.lockPath),
    false,
    'the refusal must travel out of probe() before the startup lock is ever taken',
  );
});

test('the same endpoint, spawn, and record checks all move when the record really is stale', async (t) => {
  const world = await createWorld(t);
  await leaveDeadBrokerSocket(world.endpoint);
  // On POSIX a SIGKILLed broker leaves its socket file behind, and clearing that
  // leftover is exactly what `startBroker`'s `unlink` is for, so the recovery
  // below has to be tested against a real one. On Windows the kernel destroys a
  // named pipe with its last handle, so no such leftover can be manufactured
  // there and this invariant does not exist to check. That absence is declared,
  // with its mechanism and with what has to be asserted instead, as
  // `posix-socket-file-outlives-the-process-bound-to-it` in
  // `tests/platform-capabilities.ts`.
  //
  // What both platforms do share is the state the killed broker leaves: an
  // endpoint the stale record still names and nothing answers at. That is what
  // the next assertion checks, on both.
  if (platformHasCapability('posix-socket-file-outlives-the-process-bound-to-it')) {
    assert.equal((await stat(world.endpoint)).isSocket(), true, 'the leftover must be a socket file, as a killed broker leaves');
  }
  assert.deepEqual(
    await probeEndpointOwner(world),
    { kind: 'unreachable' },
    'the endpoint the killed broker was bound to must have nothing listening behind it',
  );
  const staleRecord: BrokerRecord = {
    endpoint: world.endpoint,
    broker_instance_id: 'broker-that-died-without-cleaning-up',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: ADAPTER_VERSION,
    ws_port: world.port,
  };
  await writeBrokerRecordAtomic(world.recordPath, staleRecord);

  const client = await launchShim(t, world, 'Stale record client');
  const health = await callEnvelope(client, 'health');
  assert.equal(health.ok, true);
  assert.deepEqual(brokerSetupIssues(health), [], 'a genuinely stale record must recover, not report a failure');

  // The very assertions that hold in the session_in_use test all fail here, so
  // none of them is passing by being unobservable.
  const spawned = await brokerPidsForConfig(world.configPath);
  assert.equal(spawned.length, 1, `a stale record must start exactly one replacement broker, got ${String(spawned.length)}`);

  const rewritten = await readBrokerRecord(world.recordPath);
  assert.notEqual(rewritten, null);
  assert.notEqual(
    rewritten?.broker_instance_id,
    staleRecord.broker_instance_id,
    'the replacement broker must publish a rendezvous record of its own',
  );
  assert.equal(rewritten?.broker_pid, spawned[0], 'the published record must name the broker process that was spawned');
  assert.equal(
    await endpointIsBound(world.endpoint),
    true,
    'the replacement broker must rebind the endpoint it cleared',
  );
  assert.deepEqual(
    await probeEndpointOwner(world),
    { kind: 'hello_ack', brokerInstanceId: rewritten?.broker_instance_id },
    'the endpoint must now be owned by the replacement broker named in the record',
  );
});

test('each stdio shim declares a fresh session_id, so a session_in_use refusal is never a shim colliding with itself', async (t) => {
  const world = await createWorld(t);
  const standIn = await startStandInBroker(t, world);
  await writeBrokerRecordAtomic(world.recordPath, {
    endpoint: world.endpoint,
    broker_instance_id: 'live-broker-refusing-every-session',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: ADAPTER_VERSION,
    ws_port: world.port,
  });

  const firstHealth = await callEnvelope(await launchShim(t, world, 'First refused client'), 'health');
  const secondHealth = await callEnvelope(await launchShim(t, world, 'Second refused client'), 'health');

  assert.equal(standIn.hellos.length, 2, 'both shims must have reached the broker');
  const sessionIds = standIn.hellos.map((hello) => String(hello.session_id));
  assert.match(sessionIds[0], UUID_PATTERN);
  assert.match(sessionIds[1], UUID_PATTERN);
  assert.notEqual(
    sessionIds[0],
    sessionIds[1],
    'a shim allocates its session_id per process, so two shims can never collide with each other',
  );

  assert.deepEqual(brokerSetupIssues(firstHealth), [
    { code: 'E_BROKER_UNAVAILABLE', message: SESSION_IN_USE_SETUP_MESSAGE },
  ]);
  assert.deepEqual(brokerSetupIssues(secondHealth), [
    { code: 'E_BROKER_UNAVAILABLE', message: SESSION_IN_USE_SETUP_MESSAGE },
  ]);

  assert.equal(
    await endpointIsBound(world.endpoint),
    true,
    'repeated refusals must still leave the endpoint bound to the broker that owns it',
  );
  assert.deepEqual(
    await probeEndpointOwner(world),
    OWNED_BY_REFUSING_BROKER,
    'the endpoint must still be owned by the broker that refused both shims',
  );
  assert.equal(standIn.server.listening, true);
  assert.deepEqual(await brokerPidsForConfig(world.configPath), [], 'neither refusal may spawn a replacement broker');
});
