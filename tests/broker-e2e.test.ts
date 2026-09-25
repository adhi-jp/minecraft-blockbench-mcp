// End-to-end coverage for brokered mode over the built stdio CLI. The child
// processes run dist/adapter/cli.js, so `npm run build` must precede this file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket from 'ws';

import { IPC_PROTOCOL_VERSION } from '../src/adapter/broker/ipc-protocol.js';
import { ensureRuntimeDirectory, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import { readBrokerRecord, writeBrokerRecordAtomic, type BrokerRecord } from '../src/adapter/broker/rendezvous.js';
import { ADAPTER_VERSION } from '../src/adapter/mcp-server.js';
import { WsBridge } from '../src/adapter/ws-bridge.js';
import { COMMAND_NAMES, PROTOCOL_VERSION } from '../src/shared/protocol.js';
import { MODERN_PROTOCOL_VERSION } from './helpers/mcp-era-wire.ts';
import { processCommandLine } from './helpers/process-scan.ts';
import { createRuntimeRoot, MAX_UNIX_SOCKET_PATH_LENGTH, removeRuntimeRoot } from './helpers/runtime-root.ts';

const SECRET = 'broker-e2e-secret-1234567890';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'adapter', 'cli.js');
let nextPort = 41_300;

interface Envelope {
  summary: string;
  ok: boolean;
  command?: string;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface ConfigFixture {
  path: string;
  port: number;
  recordPath: string;
  lockPath: string;
  endpoint: string;
}

interface ManagedClient {
  client: Client;
  close(): Promise<void>;
  stderrText(): string;
}

interface StartClientOptions {
  label: string;
  mode?: 'brokered' | 'direct' | 'default';
  initializationTimeoutMs?: number;
  leaseIdleTimeoutMs?: number;
  requestTimeoutMs?: number;
  trackBroker?: boolean;
  /**
   * Which MCP wire era this client negotiates. `@modelcontextprotocol/client`
   * defaults to the 2025-era latest, so every client here speaks the legacy era
   * unless it says otherwise; pinning the modern revision fails loudly rather
   * than falling back, which is what makes a modern arm a second observation
   * instead of a second legacy run.
   */
  era?: 'legacy' | 'modern';
  /** Adapter CLI flags appended after `--client-label`, such as `--port` or `--secret`. */
  extraArgs?: readonly string[];
  /**
   * The environment the shim starts from, in place of this process's own plus
   * the world's runtime root, for a test that models what a particular MCP
   * harness hands its servers. The `BLOCKBENCH_MCP_*` settings derived from the
   * fixture and the options above are still applied on top of it.
   */
  baseEnv?: Readonly<Record<string, string>>;
}

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 41_399, 'broker e2e tests exhausted the reserved 41200-41399 port range');
  return port;
}

function configIdentity(configPath: string): string {
  return createHash('sha256').update(configPath).digest('hex').slice(0, 16);
}

/** Where the adapter keeps broker files when handed `runtimeRoot` as BLOCKBENCH_MCP_RUNTIME_DIR. */
function overrideBrokerRuntime(runtimeRoot: string): string {
  return join(runtimeRoot, 'minecraft-blockbench-mcp');
}

function parseEnvelope(toolResult: unknown): Envelope {
  const content = (toolResult as { content?: Array<{ type: string; text: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, 'tool result must carry text content');
  return JSON.parse(content[0].text) as Envelope;
}

async function callEnvelope(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope> {
  return parseEnvelope(await client.callTool({ name, arguments: args }));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForValue<T>(
  read: () => T | null | Promise<T | null>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  let value: T | null = null;
  await waitFor(async () => {
    value = await read();
    return value !== null;
  }, description, timeoutMs);
  return value as T;
}

async function withDeadline<T>(promise: Promise<T>, description: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The command line of `pid`, argument-separated by single spaces on every
 * platform, so the `__broker` check below reads the same thing on Linux, macOS
 * and Windows. A pid that is gone throws, exactly as the `/proc` read this
 * replaced did: refusing to answer is the honest result, and answering with an
 * empty line would turn the identity check into one that cannot fail.
 */
async function brokerCommandLine(pid: number): Promise<string> {
  const commandLine = await processCommandLine(pid);
  if (commandLine === null) throw new Error(`no process is running as pid ${pid}, so it has no command line to read`);
  return commandLine;
}

async function assertBrokerIdentity(pid: number): Promise<string> {
  const commandLine = await brokerCommandLine(pid);
  assert.match(commandLine, /(?:^|\s)__broker(?:\s|$)/, `pid ${pid} is not an owned broker: ${commandLine}`);
  return commandLine;
}

async function launchClient(
  fixture: ConfigFixture,
  runtimeRoot: string,
  options: StartClientOptions,
): Promise<ManagedClient> {
  const env: Record<string, string> = {};
  if (options.baseEnv !== undefined) {
    Object.assign(env, options.baseEnv);
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.BLOCKBENCH_MCP_RUNTIME_DIR = runtimeRoot;
  }
  delete env.BLOCKBENCH_MCP_DIRECT;
  delete env.BLOCKBENCH_MCP_BROKER;
  delete env.BLOCKBENCH_MCP_PORT;
  delete env.BLOCKBENCH_MCP_SECRET;
  env.BLOCKBENCH_MCP_CONFIG = fixture.path;
  env.BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS = '1000';
  if (options.leaseIdleTimeoutMs !== undefined) {
    env.BLOCKBENCH_MCP_LEASE_IDLE_TIMEOUT_MS = String(options.leaseIdleTimeoutMs);
  } else {
    delete env.BLOCKBENCH_MCP_LEASE_IDLE_TIMEOUT_MS;
  }
  if (options.requestTimeoutMs !== undefined) {
    env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS = String(options.requestTimeoutMs);
  } else {
    delete env.BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS;
  }
  if (options.mode === 'brokered') env.BLOCKBENCH_MCP_BROKER = '1';
  if (options.mode === 'direct') env.BLOCKBENCH_MCP_DIRECT = '1';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--client-label', options.label, ...(options.extraArgs ?? [])],
    env,
    cwd: projectRoot,
    stderr: 'pipe',
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(String(chunk)));
  const client = new Client(
    { name: options.label, version: '0.0.0' },
    {
      versionNegotiation:
        (options.era ?? 'legacy') === 'legacy' ? { mode: 'legacy' } : { mode: { pin: MODERN_PROTOCOL_VERSION } },
    },
  );
  try {
    await withDeadline(
      client.connect(transport),
      `${options.label} MCP initialization`,
      options.initializationTimeoutMs,
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    const stderr = stderrChunks.join('');
    throw new Error(
      `${options.label} could not initialize: ${error instanceof Error ? error.message : String(error)}${
        stderr === '' ? '' : `\nChild stderr:\n${stderr}`
      }`,
    );
  }
  let closed = false;
  return {
    client,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
    },
    stderrText: () => stderrChunks.join(''),
  };
}

class TestWorld {
  readonly clients: ManagedClient[] = [];
  readonly plugins: FakePlugin[] = [];
  readonly actualBrokerRecords = new Set<string>();
  readonly observedBrokerPids = new Map<string, Set<number>>();
  readonly beforeBrokerCleanup: Array<() => Promise<void>> = [];
  readonly pendingClientStarts = new Set<Promise<ManagedClient>>();
  readonly root: string;
  readonly runtimeRoot: string;
  readonly config: ConfigFixture;
  #cleaned = false;

  private constructor(root: string, runtimeRoot: string, config: ConfigFixture) {
    this.root = root;
    this.runtimeRoot = runtimeRoot;
    this.config = config;
  }

  static async create(t: TestContext, port: number): Promise<TestWorld> {
    const root = await mkdtemp(join(tmpdir(), 'minecraft-blockbench-broker-e2e-'));
    // The runtime root lives outside `root` on purpose: see
    // `tests/helpers/runtime-root.ts` for why a socket under `os.tmpdir()`
    // cannot fit in a macOS `sun_path`. It is removed by `cleanup` below.
    const runtimeRoot = await createRuntimeRoot('bbe2e-');
    const config = await TestWorld.writeConfig(root, overrideBrokerRuntime(runtimeRoot), 'config.json', port);
    const world = new TestWorld(root, runtimeRoot, config);
    t.after(() => world.cleanup());
    return world;
  }

  async addConfig(fileName: string, port: number, secret: string | null = SECRET): Promise<ConfigFixture> {
    return TestWorld.writeConfig(this.root, overrideBrokerRuntime(this.runtimeRoot), fileName, port, secret);
  }

  async startClient(fixture: ConfigFixture, options: StartClientOptions): Promise<ManagedClient> {
    const brokered = options.mode === 'brokered' || (options.mode !== 'direct' && process.platform !== 'win32');
    if (brokered && options.trackBroker !== false) this.actualBrokerRecords.add(fixture.recordPath);
    const starting = launchClient(fixture, this.runtimeRoot, options);
    this.pendingClientStarts.add(starting);
    try {
      const client = await starting;
      this.clients.push(client);
      return client;
    } finally {
      this.pendingClientStarts.delete(starting);
    }
  }

  async addPlugin(port: number): Promise<FakePlugin> {
    const plugin = new FakePlugin(port);
    this.plugins.push(plugin);
    await plugin.connect();
    // The adapter revokes any scoped directory the plugin still holds as soon as
    // a session authenticates. Settle that before handing the plugin back, so a
    // test that changes revocation behaviour afterwards cannot race it.
    await waitFor(
      () => plugin.requests('revoke_scope').length >= 1,
      'the scope revocation that starts every authenticated plugin session',
    );
    return plugin;
  }

  async brokerRecord(fixture: ConfigFixture): Promise<BrokerRecord> {
    const record = await waitForValue(
      () => readBrokerRecord(fixture.recordPath),
      `broker rendezvous record for port ${fixture.port}`,
    );
    let pids = this.observedBrokerPids.get(fixture.recordPath);
    if (pids === undefined) {
      pids = new Set<number>();
      this.observedBrokerPids.set(fixture.recordPath, pids);
    }
    pids.add(record.broker_pid);
    return record;
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    const failures: Error[] = [];

    await Promise.allSettled([...this.pendingClientStarts]);
    await Promise.all(
      this.clients.map((client) =>
        client.close().catch((error) => failures.push(error instanceof Error ? error : new Error(String(error)))),
      ),
    );
    for (const cleanup of this.beforeBrokerCleanup) {
      await cleanup().catch((error) => failures.push(error instanceof Error ? error : new Error(String(error))));
    }
    await Promise.all(
      [...this.actualBrokerRecords].map((recordPath) =>
        this.#ensureBrokerExited(recordPath).catch((error) =>
          failures.push(error instanceof Error ? error : new Error(String(error))),
        ),
      ),
    );
    await Promise.all(
      this.plugins.map((plugin) =>
        plugin.close().catch((error) => failures.push(error instanceof Error ? error : new Error(String(error)))),
      ),
    );
    await rm(this.root, { recursive: true, force: true }).catch((error) =>
      failures.push(error instanceof Error ? error : new Error(String(error))),
    );
    await removeRuntimeRoot(this.runtimeRoot).catch((error) =>
      failures.push(error instanceof Error ? error : new Error(String(error))),
    );

    if (failures.length > 0) throw new AggregateError(failures, 'Broker e2e teardown failed.');
  }

  async #ensureBrokerExited(recordPath: string): Promise<void> {
    const observed = this.observedBrokerPids.get(recordPath) ?? new Set<number>();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const record = await readBrokerRecord(recordPath);
      if (record !== null) observed.add(record.broker_pid);
      if (record === null || !pidAlive(record.broker_pid)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    const record = await readBrokerRecord(recordPath);
    if (record !== null) observed.add(record.broker_pid);
    const livePids = [...observed].filter(pidAlive);
    if (livePids.length === 0) return;

    const diagnostics: string[] = [];
    for (const pid of livePids) {
      const commandLine = await assertBrokerIdentity(pid);
      diagnostics.push(`pid=${pid} command=${commandLine}`);
      process.kill(pid, 'SIGKILL');
    }
    await waitFor(() => livePids.every((pid) => !pidAlive(pid)), 'forced broker termination', 5_000).catch(
      () => undefined,
    );
    const stderr = this.clients.map((client) => client.stderrText()).filter(Boolean).join('\n');
    throw new Error(
      `Broker outlived its 5 second teardown window and was killed. ${diagnostics.join('; ')}${
        stderr === '' ? '' : `\nChild stderr:\n${stderr}`
      }`,
    );
  }

  /**
   * Write `root/fileName` and describe where the broker for it will keep its
   * files: `brokerRuntime` is the directory the launched shims resolve for that
   * config file.
   */
  static async writeConfig(
    root: string,
    brokerRuntime: string,
    fileName: string,
    port: number,
    secret: string | null = SECRET,
  ): Promise<ConfigFixture> {
    const path = join(root, fileName);
    const contents = secret === null ? { version: 1, port } : { version: 1, mode: 'shared-secret', port, secret };
    await writeFile(
      path,
      `${JSON.stringify(contents, null, 2)}\n`,
      { mode: 0o600 },
    );
    const identity = configIdentity(path);
    return {
      path,
      port,
      recordPath: join(brokerRuntime, `broker-${identity}.json`),
      lockPath: join(brokerRuntime, `broker-${identity}.lock`),
      endpoint: ipcEndpointFor({ platform: process.platform, runtimeDir: brokerRuntime, identity }),
    };
  }
}

interface PluginRequestFrame {
  type: 'request';
  id: string;
  command: string;
  params: unknown;
}

interface RecordedPluginRequest extends PluginRequestFrame {
  connection: number;
  sequence: number;
  timestamp: number;
}

interface PluginTimelineEntry {
  kind: 'request' | 'response';
  command: string;
  connection: number;
  sequence: number;
  timestamp: number;
}

class FakePlugin {
  readonly frames: RecordedPluginRequest[] = [];
  readonly timeline: PluginTimelineEntry[] = [];
  readonly unansweredCommands = new Set<string>();
  delayRevocations = false;
  current: WebSocket | null = null;
  #connection = 0;
  #sequence = 0;
  #scopeConfirmed = false;
  #closing = false;
  #autoReconnect = false;
  #connectPromise: Promise<void> | null = null;
  #reconnectTask: Promise<void> | null = null;
  readonly #sockets = new Set<WebSocket>();
  readonly #delayedRevocations: Array<{ socket: WebSocket; frame: RecordedPluginRequest }> = [];

  constructor(readonly port: number) {}

  connect(): Promise<void> {
    if (this.current?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#connectPromise !== null) return this.#connectPromise;
    const running = this.#connectOnce();
    this.#connectPromise = running;
    return running.finally(() => {
      if (this.#connectPromise === running) this.#connectPromise = null;
    });
  }

  enableAutoReconnect(): void {
    this.#autoReconnect = true;
  }

  requests(command: string): RecordedPluginRequest[] {
    return this.frames.filter((frame) => frame.command === command);
  }

  responses(command: string): PluginTimelineEntry[] {
    return this.timeline.filter((entry) => entry.kind === 'response' && entry.command === command);
  }

  acknowledgeLatestRevocation(): void {
    const pending = this.#delayedRevocations.findLast(({ socket }) => socket.readyState === WebSocket.OPEN);
    assert.ok(pending, 'expected an open delayed revoke_scope request');
    this.#respond(pending.socket, pending.frame, { ok: true, result: { state: 'revoked' } });
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
    this.#closing = true;
    this.#autoReconnect = false;
    await Promise.all(
      [...this.#sockets].map(async (socket) => {
        if (socket.readyState === WebSocket.CLOSED) return;
        // Teardown kills the broker before it reaches here, so an auto-
        // reconnecting plugin can be holding a socket that is still mid-
        // handshake. Aborting one makes `ws` emit 'error' first, and
        // `events.once` would turn that expected teardown noise into a failed
        // test. Waiting on 'close' alone still proves every socket was closed.
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.terminate();
        await closed;
      }),
    );
    await this.#reconnectTask?.catch(() => undefined);
  }

  async #connectOnce(): Promise<void> {
    const connection = ++this.#connection;
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.current = socket;
    this.#sockets.add(socket);
    let acknowledge!: () => void;
    let rejectAcknowledgement!: (error: Error) => void;
    let helloSent = false;
    let authenticated = false;
    const acknowledged = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      rejectAcknowledgement = reject;
    });

    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type?: string } | PluginRequestFrame;
      if (message.type === 'hello_ack') {
        authenticated = true;
        this.#scopeConfirmed = false;
        acknowledge();
        return;
      }
      if (message.type !== 'request') return;
      const request = message as PluginRequestFrame;
      const frame: RecordedPluginRequest = {
        ...request,
        connection,
        sequence: ++this.#sequence,
        timestamp: Date.now(),
      };
      this.frames.push(frame);
      this.timeline.push({
        kind: 'request',
        command: frame.command,
        connection,
        sequence: frame.sequence,
        timestamp: frame.timestamp,
      });
      this.#handleRequest(socket, frame);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      if (this.current === socket) this.current = null;
      if (helloSent && !authenticated) rejectAcknowledgement(new Error('Plugin socket closed before hello_ack.'));
      if (this.#autoReconnect && !this.#closing) this.#scheduleReconnect();
    });

    await withDeadline(
      new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Plugin socket closed before opening.')));
      }),
      `plugin WebSocket connection on port ${this.port}`,
    );
    helloSent = true;
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        secret: SECRET,
        plugin_version: ADAPTER_VERSION,
        blockbench_version: '5.1.4',
        capabilities: ['java_block'],
      }),
    );
    await withDeadline(acknowledged, `plugin hello_ack on port ${this.port}`);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTask !== null) return;
    const running = (async () => {
      while (this.#autoReconnect && !this.#closing && this.current === null) {
        await this.connect().catch(() => undefined);
        if (this.current?.readyState === WebSocket.OPEN) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    })();
    this.#reconnectTask = running;
    void running.finally(() => {
      if (this.#reconnectTask === running) this.#reconnectTask = null;
    });
  }

  #handleRequest(socket: WebSocket, frame: RecordedPluginRequest): void {
    if (frame.command === 'revoke_scope') {
      if (this.delayRevocations) this.#delayedRevocations.push({ socket, frame });
      else this.#respond(socket, frame, { ok: true, result: { state: 'revoked' } });
      return;
    }
    if (this.unansweredCommands.has(frame.command)) return;

    if (frame.command === 'propose_scoped_directory') {
      this.#scopeConfirmed = true;
      this.#respond(socket, frame, {
        ok: true,
        result: { state: 'confirmed', normalized_path: '/tmp/blockbench-mcp-broker-e2e' },
      });
      return;
    }
    if (frame.command === 'read_file') {
      if (!this.#scopeConfirmed) {
        this.#respond(socket, frame, {
          ok: false,
          error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'No scoped directory has been confirmed.' },
        });
      } else {
        this.#respond(socket, frame, {
          ok: true,
          result: { path: 'model.json', content: '{}', encoding: 'utf8', bytes: 2 },
        });
      }
      return;
    }
    if (frame.command === 'get_project_state') {
      this.#respond(socket, frame, {
        ok: true,
        result: { open: true, format: 'java_block', counts: { cubes: 1, groups: 0, textures: 0 } },
      });
      return;
    }
    if (frame.command === 'get_elements') {
      this.#respond(socket, frame, { ok: true, result: { cubes: [], groups: [] } });
      return;
    }
    if (frame.command === 'create_cubes') {
      this.#respond(socket, frame, { ok: true, result: { cubes: [{ uuid: 'cube-1', name: 'Cube' }] } });
      return;
    }
    this.#respond(socket, frame, {
      ok: false,
      error: { code: 'E_UNSUPPORTED_COMMAND', message: `Fake plugin does not implement ${frame.command}.` },
    });
  }

  #respond(
    socket: WebSocket,
    frame: RecordedPluginRequest,
    outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (frame.command === 'revoke_scope' && outcome.ok) this.#scopeConfirmed = false;
    const sequence = ++this.#sequence;
    this.timeline.push({
      kind: 'response',
      command: frame.command,
      connection: frame.connection,
      sequence,
      timestamp: Date.now(),
    });
    socket.send(
      JSON.stringify({
        type: 'response',
        id: frame.id,
        ok: outcome.ok,
        ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
      }),
    );
  }
}

async function waitForHealth(
  client: Client,
  predicate: (health: Envelope) => boolean,
  description: string,
): Promise<Envelope> {
  let latest: Envelope | null = null;
  try {
    await waitFor(async () => {
      latest = await callEnvelope(client, 'health');
      return predicate(latest);
    }, description);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Last health: ${JSON.stringify((latest as Envelope | null)?.result ?? null)}`,
    );
  }
  return latest as Envelope;
}

function setupErrorCodes(health: Envelope): string[] {
  return ((health.result?.setup_errors ?? []) as Array<{ code: string }>).map((issue) => issue.code);
}

test('an over-length broker endpoint is reported through health with its actionable setup issue', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bbmcp-broker-path-guard-'));
  const configPath = join(root, 'config.json');
  const port = allocatePort();
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const identity = configIdentity(configPath);
  const endpointTail = join('minecraft-blockbench-mcp', `broker-${identity}.sock`);
  const paddingLength = Math.max(
    1,
    MAX_UNIX_SOCKET_PATH_LENGTH + 1 - Buffer.byteLength(root, 'utf8') - Buffer.byteLength(endpointTail, 'utf8') - 2,
  );
  const runtimeRoot = join(root, 'r'.repeat(paddingLength));
  await mkdir(runtimeRoot);
  const brokerRuntime = join(runtimeRoot, 'minecraft-blockbench-mcp');
  const endpoint = join(brokerRuntime, `broker-${identity}.sock`);
  const endpointLength = Buffer.byteLength(endpoint, 'utf8');
  const fixture: ConfigFixture = {
    path: configPath,
    port,
    recordPath: join(brokerRuntime, `broker-${identity}.json`),
    lockPath: join(brokerRuntime, `broker-${identity}.lock`),
    endpoint,
  };
  let managedClient: ManagedClient | null = null;
  t.after(async () => {
    await managedClient?.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.ok(endpointLength > MAX_UNIX_SOCKET_PATH_LENGTH);
  managedClient = await launchClient(fixture, runtimeRoot, {
    label: 'Over-length endpoint client',
    mode: 'brokered',
    initializationTimeoutMs: 15_000,
    trackBroker: false,
  });
  const health = await callEnvelope(managedClient.client, 'health');
  const setupErrors = (health.result?.setup_errors ?? []) as Array<{ code: string; message: string }>;
  const issue = setupErrors.find(({ code }) => code === 'E_UNIX_SOCKET_PATH_TOO_LONG');
  assert.equal(health.ok, true);
  assert.equal(health.result?.mode, 'brokered');
  assert.equal(health.result?.broker_connected, false);
  assert.ok(issue, `expected E_UNIX_SOCKET_PATH_TOO_LONG, got ${JSON.stringify(setupErrors)}`);
  assert.ok(issue.message.includes(endpoint));
  assert.ok(issue.message.includes(String(endpointLength)));
  assert.ok(issue.message.includes(String(MAX_UNIX_SOCKET_PATH_LENGTH)));
  assert.ok(managedClient.stderrText().includes(`Setup issue (E_UNIX_SOCKET_PATH_TOO_LONG): ${issue.message}`));
});

test('concurrent MCP clients share one broker and retain partial availability without Blockbench', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const [a, b] = await Promise.all([
    world.startClient(world.config, { label: 'Client A', mode: 'brokered' }),
    world.startClient(world.config, { label: 'Client B', mode: 'brokered' }),
  ]);

  const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
  const namesA = toolsA.tools.map((tool) => tool.name).sort();
  const namesB = toolsB.tools.map((tool) => tool.name).sort();
  assert.deepEqual(namesA, ['health', ...COMMAND_NAMES].sort());
  assert.deepEqual(namesB, namesA);

  const [healthA, healthB] = await Promise.all([
    waitForHealth(
      a.client,
      (health) => health.result?.broker_connected === true && health.result?.client_count === 2,
      'Client A to observe the shared broker',
    ),
    waitForHealth(
      b.client,
      (health) => health.result?.broker_connected === true && health.result?.client_count === 2,
      'Client B to observe the shared broker',
    ),
  ]);
  for (const health of [healthA, healthB]) {
    assert.equal(health.result?.mode, 'brokered');
    assert.equal(health.result?.broker_connected, true);
    assert.equal(health.result?.plugin_connected, false);
    assert.equal(health.result?.client_count, 2);
    assert.ok(!setupErrorCodes(health).includes('E_PORT_IN_USE'));
  }

  const record = await world.brokerRecord(world.config);
  assert.equal(record.ws_port, port);
  assert.equal(record.broker_pid > 0, true);
});

test('clients launched with different harness environments share the broker of their common config file', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  // The config lives in the world's short runtime root, not its `os.tmpdir()`
  // root: with no override the socket is `<config dir>/run/broker-<16 hex>.sock`,
  // which would not fit in a `sun_path` under a macOS `os.tmpdir()`.
  const fixture = await TestWorld.writeConfig(world.runtimeRoot, join(world.runtimeRoot, 'run'), 'config.json', port);

  // Claude Code hands its MCP servers its whole environment, XDG_RUNTIME_DIR
  // included. That variable is set here deliberately, to model that harness;
  // it must not decide where the broker lives.
  const claudeRuntimeDir = join(world.runtimeRoot, 'xdg');
  await mkdir(claudeRuntimeDir);
  const claudeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('BLOCKBENCH_MCP_')) claudeEnv[key] = value;
  }
  claudeEnv.XDG_RUNTIME_DIR = claudeRuntimeDir;
  // Codex CLI starts a stdio MCP server with only these variables, plus the ones
  // its server registration sets explicitly.
  const codexEnv: Record<string, string> = {};
  for (const key of ['HOME', 'LANG', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER']) {
    const value = process.env[key];
    if (value !== undefined) codexEnv[key] = value;
  }

  const claudeLike = await world.startClient(fixture, {
    label: 'Claude-like client',
    mode: 'brokered',
    baseEnv: claudeEnv,
  });
  await waitForHealth(
    claudeLike.client,
    (health) => health.result?.broker_connected === true,
    'the Claude-like client to elect a broker',
  );
  const codexLike = await world.startClient(fixture, { label: 'Codex-like client', mode: 'brokered', baseEnv: codexEnv });

  const [claudeHealth, codexHealth] = await Promise.all([
    waitForHealth(
      claudeLike.client,
      (health) => health.result?.broker_connected === true && health.result?.client_count === 2,
      'the Claude-like client to see the Codex-like client on its broker',
    ),
    waitForHealth(
      codexLike.client,
      (health) => health.result?.broker_connected === true && health.result?.client_count === 2,
      'the Codex-like client to join the Claude-like client on one broker',
    ),
  ]);
  for (const health of [claudeHealth, codexHealth]) {
    assert.equal(health.result?.broker_connected, true);
    assert.equal(health.result?.client_count, 2);
    assert.deepEqual(setupErrorCodes(health), []);
  }
  const record = await world.brokerRecord(fixture);
  assert.equal(record.ws_port, port);
});

test('the first plugin command owns control and excludes a second client without blocking read-only MCP surfaces', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const a = await world.startClient(world.config, { label: 'Client A', mode: 'brokered' });
  const b = await world.startClient(world.config, { label: 'Client B', mode: 'brokered' });
  const plugin = await world.addPlugin(port);
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'plugin connection');

  assert.equal((await callEnvelope(a.client, 'get_project_state')).ok, true);
  const owned = await waitForHealth(
    b.client,
    (health) => health.result?.controller_state === 'owned' && health.result?.controller_owner === 'Client A',
    'Client A controller ownership',
  );
  assert.equal(owned.result?.controller_owner, 'Client A');

  const before = plugin.requests('get_project_state').length;
  const busy = await callEnvelope(b.client, 'get_project_state');
  assert.equal(busy.ok, false);
  assert.equal(busy.error?.code, 'E_CLIENT_BUSY');
  assert.deepEqual(busy.error?.details, { owner: 'Client A' });
  assert.equal(plugin.requests('get_project_state').length, before, 'Client B command reached the plugin');

  const tools = await b.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['health', ...COMMAND_NAMES].sort());
  const stillHealthy = await callEnvelope(b.client, 'health');
  assert.equal(stillHealthy.ok, true);
  assert.equal(stillHealthy.result?.broker_connected, true);
  assert.equal(stillHealthy.result?.controller_owner, 'Client A');
});

test('a broker client that starts without --client-label reports the invoking package manager as controller_owner, not its version', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const npmEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('BLOCKBENCH_MCP_')) npmEnv[key] = value;
  }
  npmEnv.BLOCKBENCH_MCP_RUNTIME_DIR = world.runtimeRoot;
  // The shape npm sets in every package's bin process: name/version, then the
  // invoking Node version and platform. An empty `--client-label` parses the
  // same as an absent one, so this drives the same fallback a client that
  // never passes the flag would take.
  npmEnv.npm_config_user_agent = 'npm/10.8.2 node/v22.12.0 linux x64 workspaces/false';

  const npmLike = await world.startClient(world.config, { label: '', mode: 'brokered', baseEnv: npmEnv });
  await world.addPlugin(port);
  await waitForHealth(npmLike.client, (health) => health.result?.plugin_connected === true, 'plugin connection');

  assert.equal((await callEnvelope(npmLike.client, 'get_project_state')).ok, true);
  const owned = await waitForHealth(
    npmLike.client,
    (health) => health.result?.controller_state === 'owned',
    'controller ownership after the label-less client acted',
  );
  assert.equal(owned.result?.controller_owner, 'npm');
});

test('closing the controller revokes its scoped directory exactly once before the next client command', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const a = await world.startClient(world.config, { label: 'Client A', mode: 'brokered' });
  const b = await world.startClient(world.config, { label: 'Client B', mode: 'brokered' });
  const plugin = await world.addPlugin(port);
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'plugin connection');

  const proposed = await callEnvelope(a.client, 'propose_scoped_directory', {
    path: '/tmp/blockbench-mcp-broker-e2e',
  });
  assert.equal(proposed.ok, true);
  await a.close();
  await waitForHealth(b.client, (health) => health.result?.client_count === 1, 'Client A to close');

  const read = await callEnvelope(b.client, 'read_file', { path: 'model.json' });
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'E_SCOPE_NOT_CONFIRMED');
  const readFrame = plugin.requests('read_file')[0];
  assert.ok(readFrame, 'Client B read_file request did not reach the plugin');
  const revocationsBeforeRead = plugin.frames.filter(
    (frame) => frame.command === 'revoke_scope' && frame.sequence < readFrame.sequence,
  );
  // One when the plugin session authenticated, one when the controller changed.
  assert.equal(revocationsBeforeRead.length, 2);
  assert.equal(plugin.requests('revoke_scope').length, 2);
  const revocationResponse = plugin.responses('revoke_scope').at(-1);
  assert.ok(revocationResponse, 'fake plugin did not observe its revoke_scope response');
  assert.ok(revocationResponse.sequence < readFrame.sequence);
});

test('a handoff command remains unrelayed until the plugin acknowledges scope revocation', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const a = await world.startClient(world.config, { label: 'Client A', mode: 'brokered' });
  const b = await world.startClient(world.config, { label: 'Client B', mode: 'brokered' });
  const plugin = await world.addPlugin(port);
  plugin.delayRevocations = true;
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'plugin connection');
  assert.equal((await callEnvelope(a.client, 'get_project_state')).ok, true);
  await a.close();
  await waitForHealth(b.client, (health) => health.result?.client_count === 1, 'Client A to close');

  let settled = false;
  const requested = callEnvelope(b.client, 'get_project_state').then((outcome) => {
    settled = true;
    return outcome;
  });
  // Two in total: one when the plugin session authenticated, one for this handoff.
  await waitFor(() => plugin.requests('revoke_scope').length === 2, 'withheld revoke_scope request');
  assert.equal(plugin.requests('get_project_state').length, 1, 'Client B command was relayed before revocation');
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false);

  plugin.acknowledgeLatestRevocation();
  const outcome = await requested;
  assert.equal(outcome.ok, true);
  const commands = plugin.requests('get_project_state');
  assert.equal(commands.length, 2);
  const response = plugin.responses('revoke_scope').at(-1);
  assert.ok(response && response.sequence < commands[1].sequence);
  plugin.delayRevocations = false;
});

test('a lost revocation acknowledgement is requested again after plugin reconnection before handoff', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const a = await world.startClient(world.config, { label: 'Client A', mode: 'brokered' });
  const b = await world.startClient(world.config, { label: 'Client B', mode: 'brokered' });
  const plugin = await world.addPlugin(port);
  plugin.delayRevocations = true;
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'plugin connection');
  assert.equal((await callEnvelope(a.client, 'get_project_state')).ok, true);
  await a.close();
  await waitForHealth(b.client, (health) => health.result?.client_count === 1, 'Client A to close');

  const firstAttempt = callEnvelope(b.client, 'get_project_state');
  await waitFor(() => plugin.requests('revoke_scope').length === 2, 'first revoke_scope request');
  await plugin.disconnectCurrent();
  assert.equal((await firstAttempt).error?.code, 'E_PLUGIN_NOT_CONNECTED');
  assert.equal(plugin.requests('get_project_state').length, 1);

  await plugin.connect();
  await waitFor(() => plugin.requests('revoke_scope').length === 3, 'replayed revoke_scope request');
  const retry = callEnvelope(b.client, 'get_project_state');
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  assert.equal(plugin.requests('get_project_state').length, 1, 'Client B command passed the unacknowledged retry');
  plugin.acknowledgeLatestRevocation();
  assert.equal((await retry).ok, true);

  const commands = plugin.requests('get_project_state');
  const secondRevocation = plugin.requests('revoke_scope').at(-1)!;
  const secondResponse = plugin.responses('revoke_scope').at(-1);
  assert.equal(commands.length, 2);
  assert.ok(secondResponse && secondResponse.sequence > secondRevocation.sequence);
  assert.ok(secondResponse.sequence < commands[1].sequence);
  assert.equal(secondRevocation.connection, commands[1].connection);
  plugin.delayRevocations = false;
});

test('brokered mutating timeouts preserve the direct-mode reconciliation error shape', async (t) => {
  const brokerPort = allocatePort();
  const directPort = allocatePort();
  const world = await TestWorld.create(t, brokerPort);
  const directConfig = await world.addConfig('direct-config.json', directPort);
  const brokered = await world.startClient(world.config, {
    label: 'Brokered client',
    mode: 'brokered',
    requestTimeoutMs: 40,
  });
  const direct = await world.startClient(directConfig, {
    label: 'Direct client',
    mode: 'direct',
    requestTimeoutMs: 40,
  });
  const brokerPlugin = await world.addPlugin(brokerPort);
  const directPlugin = await world.addPlugin(directPort);
  brokerPlugin.unansweredCommands.add('create_cubes');
  directPlugin.unansweredCommands.add('create_cubes');
  await Promise.all([
    waitForHealth(brokered.client, (health) => health.result?.plugin_connected === true, 'brokered plugin'),
    waitForHealth(direct.client, (health) => health.result?.plugin_connected === true, 'direct plugin'),
  ]);

  const args = { cubes: [{ from: [0, 0, 0], to: [1, 1, 1] }] };
  const [brokeredTimeout, directTimeout] = await Promise.all([
    callEnvelope(brokered.client, 'create_cubes', args),
    callEnvelope(direct.client, 'create_cubes', args),
  ]);
  assert.equal(brokeredTimeout.error?.code, 'E_TIMEOUT');
  assert.deepEqual(brokeredTimeout.error, directTimeout.error);
  const details = brokeredTimeout.error?.details as {
    execution_state?: unknown;
    retry?: unknown;
    reconciliation?: unknown;
  };
  assert.equal(details.execution_state, 'unknown');
  assert.equal(typeof details.retry, 'string');
  assert.ok(details.reconciliation && typeof details.reconciliation === 'object');
});

test('an incompatible broker is reported without replacing or terminating the running endpoint', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  // The runtime directory has to exist before the stand-in binds inside it and
  // before the record and lock files below are written. It is derived from the
  // record path, not from the endpoint: on Windows the endpoint is a named pipe
  // whose `dirname` is `\\.\pipe`, a device namespace that holds neither.
  await ensureRuntimeDirectory(dirname(world.config.recordPath));
  const sockets = new Set<Socket>();
  let helloCount = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      while (true) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line === '') continue;
        const message = JSON.parse(line) as { type?: string };
        if (message.type !== 'client_hello') continue;
        helloCount += 1;
        socket.write(
          `${JSON.stringify({
            type: 'hello_reject',
            reason: 'version_mismatch',
            ipc_protocol_version: IPC_PROTOCOL_VERSION + 1,
            package_version: `${ADAPTER_VERSION}-incompatible`,
          })}\n`,
        );
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(world.config.endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const fakeRecord: BrokerRecord = {
    endpoint: world.config.endpoint,
    broker_instance_id: 'incompatible-test-broker',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION + 1,
    package_version: `${ADAPTER_VERSION}-incompatible`,
    ws_port: port,
  };
  await writeFile(world.config.recordPath, `${JSON.stringify(fakeRecord)}\n`, { mode: 0o600 });
  await writeFile(world.config.lockPath, JSON.stringify({ pid: process.pid, created_at: Date.now() }), { mode: 0o600 });
  world.beforeBrokerCleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([
      unlink(world.config.recordPath).catch(() => undefined),
      unlink(world.config.lockPath).catch(() => undefined),
      unlink(world.config.endpoint).catch(() => undefined),
    ]);
  });

  const client = await world.startClient(world.config, {
    label: 'Version mismatch client',
    mode: 'brokered',
    trackBroker: false,
  });
  const health = await callEnvelope(client.client, 'health');
  assert.ok(setupErrorCodes(health).includes('E_BROKER_VERSION_MISMATCH'));
  const tool = await callEnvelope(client.client, 'get_project_state');
  assert.equal(tool.error?.code, 'E_BROKER_VERSION_MISMATCH');

  assert.equal(server.listening, true);
  assert.ok(helloCount >= 1);
  assert.deepEqual(await readBrokerRecord(world.config.recordPath), fakeRecord);
  assert.equal(await pathExists(world.config.lockPath), true);
});

test('direct mode binds its own WebSocket listener while an unrelated broker is running', async (t) => {
  const brokerPort = allocatePort();
  const directPort = allocatePort();
  const world = await TestWorld.create(t, brokerPort);
  const directConfig = await world.addConfig('direct-config.json', directPort);
  const brokered = await world.startClient(world.config, { label: 'Brokered client', mode: 'brokered' });
  const brokerHealth = await waitForHealth(
    brokered.client,
    (health) => health.result?.broker_connected === true,
    'unrelated broker startup',
  );
  assert.equal(brokerHealth.result?.mode, 'brokered');
  const brokerRecord = await world.brokerRecord(world.config);

  const direct = await world.startClient(directConfig, { label: 'Direct client', mode: 'direct' });
  const directHealth = await callEnvelope(direct.client, 'health');
  assert.equal(directHealth.result?.mode, 'direct');
  assert.equal(directHealth.result?.ws_listening, true);
  assert.equal(directHealth.result?.port, directPort);
  assert.equal(directHealth.result?.broker_connected, false);
  assert.ok(!setupErrorCodes(directHealth).includes('E_PORT_IN_USE'));
  assert.deepEqual(await readBrokerRecord(world.config.recordPath), brokerRecord);
});

test('an idle broker exits cleanly and a later client elects a fresh instance', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const first = await world.startClient(world.config, { label: 'First client', mode: 'brokered' });
  await waitForHealth(first.client, (health) => health.result?.broker_connected === true, 'first broker connection');
  const firstRecord = await world.brokerRecord(world.config);
  await first.close();

  await waitFor(async () => !(await pathExists(world.config.recordPath)), 'idle broker rendezvous removal');
  await waitFor(() => !pidAlive(firstRecord.broker_pid), 'idle broker process exit');

  const second = await world.startClient(world.config, { label: 'Second client', mode: 'brokered' });
  const secondHealth = await waitForHealth(
    second.client,
    (health) => health.result?.broker_connected === true && health.result?.client_count === 1,
    'fresh broker connection',
  );
  const secondRecord = await world.brokerRecord(world.config);
  assert.notEqual(secondRecord.broker_instance_id, firstRecord.broker_instance_id);
  assert.equal(secondHealth.result?.mode, 'brokered');
  assert.equal(secondHealth.result?.broker_connected, true);
});

test('lease expiry revokes scope for a different client but not when the same client reacquires', async (t) => {
  const handoffPort = allocatePort();
  const reacquirePort = allocatePort();
  const world = await TestWorld.create(t, handoffPort);
  const reacquireConfig = await world.addConfig('reacquire-config.json', reacquirePort);

  const a = await world.startClient(world.config, {
    label: 'Client A',
    mode: 'brokered',
    leaseIdleTimeoutMs: 1000,
  });
  const b = await world.startClient(world.config, {
    label: 'Client B',
    mode: 'brokered',
    leaseIdleTimeoutMs: 1000,
  });
  const handoffPlugin = await world.addPlugin(handoffPort);
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'handoff plugin');
  assert.equal((await callEnvelope(a.client, 'get_project_state')).ok, true);
  await waitForHealth(b.client, (health) => health.result?.controller_state === 'idle', 'Client A lease expiry');
  assert.equal((await callEnvelope(b.client, 'get_project_state')).ok, true);
  const handoffCommands = handoffPlugin.requests('get_project_state');
  const handoffRevocation = handoffPlugin.requests('revoke_scope');
  assert.equal(handoffCommands.length, 2);
  // One when the plugin session authenticated, one when control changed hands.
  assert.equal(handoffRevocation.length, 2);
  assert.ok(handoffRevocation.at(-1)!.sequence < handoffCommands[1].sequence);

  const sameClient = await world.startClient(reacquireConfig, {
    label: 'Solo client',
    mode: 'brokered',
    leaseIdleTimeoutMs: 1000,
  });
  const reacquirePlugin = await world.addPlugin(reacquirePort);
  await waitForHealth(sameClient.client, (health) => health.result?.plugin_connected === true, 'solo plugin');
  assert.equal((await callEnvelope(sameClient.client, 'get_project_state')).ok, true);
  await waitForHealth(
    sameClient.client,
    (health) => health.result?.controller_state === 'idle',
    'solo client lease expiry',
  );
  assert.equal((await callEnvelope(sameClient.client, 'get_project_state')).ok, true);
  assert.equal(reacquirePlugin.requests('get_project_state').length, 2);
  // Only the one that started the plugin session: reacquiring adds none.
  assert.equal(reacquirePlugin.requests('revoke_scope').length, 1);
});

test('an attached MCP client re-elects a broker after the broker process is replaced', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const a = await world.startClient(world.config, { label: 'Client A', mode: 'brokered' });
  const plugin = await world.addPlugin(port);
  plugin.enableAutoReconnect();
  await waitForHealth(a.client, (health) => health.result?.plugin_connected === true, 'initial plugin connection');
  assert.equal((await callEnvelope(a.client, 'get_project_state')).ok, true);
  const firstRecord = await world.brokerRecord(world.config);
  await assertBrokerIdentity(firstRecord.broker_pid);
  process.kill(firstRecord.broker_pid, 'SIGKILL');
  await waitFor(() => !pidAlive(firstRecord.broker_pid), 'test-owned broker termination');

  const failures: Envelope[] = [];
  let success: Envelope | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await callEnvelope(a.client, 'get_project_state');
    if (outcome.ok) {
      success = outcome;
      break;
    }
    failures.push(outcome);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(success, `tool call did not recover within three attempts: ${JSON.stringify(failures)}`);
  // Before recovery completes a call may see the dead IPC endpoint, or reach a
  // freshly elected broker whose plugin has not re-authenticated yet.
  assert.ok(
    failures.every(
      (failure) => failure.error?.code === 'E_BROKER_UNAVAILABLE' || failure.error?.code === 'E_PLUGIN_NOT_CONNECTED',
    ),
  );

  const secondRecord = await waitForValue(async () => {
    const record = await readBrokerRecord(world.config.recordPath);
    return record !== null && record.broker_instance_id !== firstRecord.broker_instance_id ? record : null;
  }, 'replacement broker record');
  let observed = world.observedBrokerPids.get(world.config.recordPath);
  if (observed === undefined) {
    observed = new Set<number>();
    world.observedBrokerPids.set(world.config.recordPath, observed);
  }
  observed.add(secondRecord.broker_pid);
  assert.notEqual(secondRecord.broker_instance_id, firstRecord.broker_instance_id);
  const health = await waitForHealth(
    a.client,
    (value) => value.result?.broker_connected === true && value.result?.plugin_connected === true,
    'reattached broker health',
  );
  assert.equal(health.result?.broker_connected, true);
});

test('a directly spawned broker never writes the shared secret to stderr', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('BLOCKBENCH_MCP_')) env[key] = value;
  }
  env.BLOCKBENCH_MCP_CONFIG = world.config.path;
  env.BLOCKBENCH_MCP_RUNTIME_DIR = world.runtimeRoot;
  env.BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS = '3000';

  const child = spawn(process.execPath, [cliPath, '__broker'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  await waitForValue(() => readBrokerRecord(world.config.recordPath), 'directly spawned broker record');
  // Authenticate a plugin so the secret-bearing hello flows through the broker
  // before it idle-exits with no attached MCP clients.
  await world.addPlugin(port);
  await waitFor(() => child.exitCode !== null, 'broker idle exit', 15_000);

  assert.ok(stderrText.length > 0, 'the broker must log its lifecycle to stderr');
  assert.ok(stderrText.includes('authenticated'), 'the plugin authentication must be logged');
  for (const encoded of [SECRET, Buffer.from(SECRET).toString('base64')]) {
    assert.ok(!stderrText.includes(encoded), 'broker stderr must never contain the shared secret');
  }
});

test('a broker speaking a different IPC version is reported to the client and is neither stopped nor replaced', async (t) => {
  const port = allocatePort();
  const world = await TestWorld.create(t, port);

  // Stand in for a broker built before the cancel_request message existed: it
  // completes the handshake far enough to state its version and refuse.
  const hellos: Array<Record<string, unknown>> = [];
  const incompatibleBroker: Server = createServer((socket: Socket) => {
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
                ipc_protocol_version: IPC_PROTOCOL_VERSION - 1,
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
  t.after(() => new Promise<void>((resolve) => incompatibleBroker.close(() => resolve())));
  // The adapter creates this directory when it starts a broker of its own; here
  // the stand-in has to bind inside it first, and the stale record below has to
  // land in it. It is derived from the record path, not from the endpoint,
  // because a Windows endpoint is a named pipe whose `dirname` is `\\.\pipe`.
  await ensureRuntimeDirectory(dirname(world.config.recordPath));
  await new Promise<void>((resolve, reject) => {
    incompatibleBroker.once('error', reject);
    incompatibleBroker.listen(world.config.endpoint, () => resolve());
  });

  const staleRecord: BrokerRecord = {
    endpoint: world.config.endpoint,
    broker_instance_id: 'broker-from-an-earlier-build',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION - 1,
    package_version: ADAPTER_VERSION,
    ws_port: port,
  };
  await writeBrokerRecordAtomic(world.config.recordPath, staleRecord);

  const client = await world.startClient(world.config, {
    label: 'Mismatched client',
    mode: 'brokered',
    trackBroker: false,
  });
  const health = await callEnvelope(client.client, 'health');
  assert.equal(health.ok, true);
  assert.equal(health.result?.broker_connected, false);
  assert.ok(
    setupErrorCodes(health).includes('E_BROKER_VERSION_MISMATCH'),
    `expected E_BROKER_VERSION_MISMATCH, got ${JSON.stringify(setupErrorCodes(health))}`,
  );

  // The incompatible broker is untouched: still listening, still the published
  // rendezvous target, and asked exactly once rather than displaced by a
  // replacement the client started for itself.
  assert.equal(incompatibleBroker.listening, true);
  assert.equal(hellos.length, 1);
  assert.deepEqual(await readBrokerRecord(world.config.recordPath), staleRecord);
  await client.close();

  // Positive control: with the incompatible broker gone, the identical client
  // setup does attach, so the failure above came from the version refusal and
  // not from a harness that can never connect.
  await new Promise<void>((resolve) => incompatibleBroker.close(() => resolve()));
  await unlink(world.config.recordPath).catch(() => undefined);
  const compatible = await world.startClient(world.config, { label: 'Compatible client', mode: 'brokered' });
  const healthy = await waitForHealth(
    compatible.client,
    (value) => value.result?.broker_connected === true,
    'the compatible client to attach to a broker it started',
  );
  assert.ok(!setupErrorCodes(healthy).includes('E_BROKER_VERSION_MISMATCH'));
  const freshRecord = await world.brokerRecord(world.config);
  assert.notEqual(freshRecord.broker_instance_id, staleRecord.broker_instance_id);
  assert.equal(freshRecord.ipc_protocol_version, IPC_PROTOCOL_VERSION);
});

test('broker taint recovery, idle shutdown, and rendezvous cleanup behave identically for a 2026-07-28 client and a 2025-era one', async (t) => {
  // The broker path is negotiated once, by the stdio shim, and everything below
  // it — election, the controller lease, scope revocation, the idle timer, the
  // rendezvous record — is era-blind by construction. "By construction" is the
  // claim being checked: every other broker test here runs on the client
  // default, which is the 2025-era latest, so nothing observed a modern client
  // driving these paths at all.
  const observed: Partial<Record<'legacy' | 'modern', Record<string, unknown>>> = {};

  for (const era of ['legacy', 'modern'] as const) {
    const port = allocatePort();
    const world = await TestWorld.create(t, port);

    // Taint recovery: a broker that has just started cannot know which scoped
    // directory the plugin still holds, so it revokes before serving anyone.
    const first = await world.startClient(world.config, { label: `First ${era} client`, mode: 'brokered', era });
    await waitForHealth(first.client, (health) => health.result?.broker_connected === true, `${era} broker connection`);
    const plugin = await world.addPlugin(port);
    const revocationsBeforeWork = plugin.requests('revoke_scope').length;
    const relayed = await callEnvelope(first.client, 'get_project_state');
    const firstRecord = await world.brokerRecord(world.config);

    // Idle shutdown and rendezvous cleanup: with the only client gone, the
    // broker exits and removes the record it published.
    await first.close();
    await waitFor(async () => !(await pathExists(world.config.recordPath)), `${era} idle broker rendezvous removal`);
    await waitFor(() => !pidAlive(firstRecord.broker_pid), `${era} idle broker process exit`);
    // Read both facts here, while the broker is gone and before anything elects
    // a replacement: after the second client starts, a present record would be
    // the new broker's and would say nothing about the cleanup.
    const recordAbsentAfterIdle = !(await pathExists(world.config.recordPath));
    const firstBrokerExited = !pidAlive(firstRecord.broker_pid);

    // A later client of the same era elects a fresh instance against the same
    // config, which is what proves the cleanup left nothing behind.
    const second = await world.startClient(world.config, { label: `Second ${era} client`, mode: 'brokered', era });
    const secondHealth = await waitForHealth(
      second.client,
      (health) => health.result?.broker_connected === true && health.result?.client_count === 1,
      `${era} fresh broker connection`,
    );
    const secondRecord = await world.brokerRecord(world.config);

    observed[era] = {
      revokedBeforeFirstCommand: revocationsBeforeWork >= 1,
      firstCommandOk: relayed.ok,
      recordAbsentAfterIdle,
      firstBrokerExited,
      freshInstanceElected: secondRecord.broker_instance_id !== firstRecord.broker_instance_id,
      mode: secondHealth.result?.mode,
      brokerConnected: secondHealth.result?.broker_connected,
      clientCount: secondHealth.result?.client_count,
      ipcProtocolVersion: secondRecord.ipc_protocol_version,
    };
  }

  for (const era of ['legacy', 'modern'] as const) {
    const arm = observed[era] as Record<string, unknown>;
    assert.equal(arm.revokedBeforeFirstCommand, true, `${era}: the broker served a command with no scope revocation`);
    assert.equal(arm.firstCommandOk, true, `${era}: the first brokered command failed`);
    assert.equal(arm.recordAbsentAfterIdle, true, `${era}: the idle broker left its rendezvous record behind`);
    assert.equal(arm.firstBrokerExited, true, `${era}: the idle broker process did not exit`);
    assert.equal(arm.freshInstanceElected, true, `${era}: the second client reused the exited broker instance`);
    assert.equal(arm.mode, 'brokered', `${era}: the adapter did not report brokered mode`);
    assert.equal(arm.brokerConnected, true, `${era}: the second client never attached to a broker`);
    assert.equal(arm.clientCount, 1, `${era}: the exited broker's client was still counted`);
    assert.equal(arm.ipcProtocolVersion, IPC_PROTOCOL_VERSION, `${era}: the fresh record declared another IPC version`);
  }
  assert.deepEqual(
    observed.modern,
    observed.legacy,
    'broker taint recovery, idle shutdown, or rendezvous cleanup differs between the two MCP wire eras',
  );
});

/** A loopback listener on an OS-assigned port, standing in for whatever else holds the plugin port. */
async function holdLoopbackPort(t: TestContext): Promise<{ port: number; release(): Promise<void> }> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(release);
  return { port: (server.address() as { port: number }).port, release };
}

/** An OS-assigned loopback port that nothing is listening on any more. */
async function unusedLoopbackPort(t: TestContext): Promise<number> {
  const held = await holdLoopbackPort(t);
  await held.release();
  return held.port;
}

function setupErrors(health: Envelope): Array<{ code: string; message: string }> {
  return (health.result?.setup_errors ?? []) as Array<{ code: string; message: string }>;
}

async function directModeSetupIssue(port: number, secret: string | null): Promise<{ code: string; message: string }> {
  const bridge = new WsBridge({
    port,
    secret,
    requestTimeoutMs: 1_000,
    heartbeatIntervalMs: 1_000,
    heartbeatMissLimit: 3,
    handshakeTimeoutMs: 1_000,
    maxMessageBytes: 1_048_576,
    log: () => undefined,
  });
  const started = await bridge.start();
  await bridge.stop();
  assert.equal(started.ok, false, 'direct mode was expected to refuse this listener');
  return (started as { issue: { code: string; message: string } }).issue;
}

test('a spawned broker runs with the port and secret the shim was given on its command line', async (t) => {
  const configPort = await unusedLoopbackPort(t);
  const cliPort = await unusedLoopbackPort(t);
  const world = await TestWorld.create(t, await unusedLoopbackPort(t));
  const fixture = await world.addConfig('cli-flags-config.json', configPort, null);

  const managed = await world.startClient(fixture, {
    label: 'CLI flag client',
    mode: 'brokered',
    extraArgs: ['--port', String(cliPort), '--secret', SECRET],
  });
  const health = await waitForHealth(
    managed.client,
    (value) => value.result?.broker_connected === true,
    'the broker spawned with the shim configuration',
  );
  assert.equal(health.result?.port, cliPort);
  assert.deepEqual(setupErrors(health), []);

  await world.addPlugin(cliPort);
  assert.equal((await callEnvelope(managed.client, 'get_project_state')).ok, true);
  const record = await world.brokerRecord(fixture);
  assert.equal(record.ws_port, cliPort);
  const commandLine = await assertBrokerIdentity(record.broker_pid);
  assert.ok(commandLine.includes(String(cliPort)), `the broker argv must carry the resolved port: ${commandLine}`);
  assert.ok(!commandLine.includes(SECRET), 'the shared secret must never appear in the broker argv');
});

test('a shim without a secret still attaches to a broker that is already running', async (t) => {
  const port = await unusedLoopbackPort(t);
  const world = await TestWorld.create(t, await unusedLoopbackPort(t));
  const fixture = await world.addConfig('secretless-config.json', port, null);

  const owner = await world.startClient(fixture, {
    label: 'Secret-holding client',
    mode: 'brokered',
    extraArgs: ['--secret', SECRET],
  });
  await waitForHealth(owner.client, (value) => value.result?.broker_connected === true, 'the first broker attach');

  const secretless = await world.startClient(fixture, { label: 'Secretless client', mode: 'brokered' });
  const health = await waitForHealth(
    secretless.client,
    (value) => value.result?.broker_connected === true && value.result?.client_count === 2,
    'the secretless client to share the running broker',
  );
  assert.deepEqual(setupErrors(health), []);
});

test('a shim with no secret reports E_SECRET_MISSING promptly instead of spawning a broker that cannot start', async (t) => {
  const port = await unusedLoopbackPort(t);
  const world = await TestWorld.create(t, await unusedLoopbackPort(t));
  const fixture = await world.addConfig('no-secret-config.json', port, null);

  const startedAt = Date.now();
  const managed = await world.startClient(fixture, {
    label: 'No secret client',
    mode: 'brokered',
    initializationTimeoutMs: 15_000,
    trackBroker: false,
  });
  const health = await callEnvelope(managed.client, 'health');
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 5_000, `startup and health took ${String(elapsedMs)} ms`);
  assert.deepEqual(setupErrors(health), [await directModeSetupIssue(port, null)]);
  assert.equal(health.result?.broker_connected, false);
  assert.equal(await pathExists(fixture.recordPath), false, 'no broker may be spawned without a secret');
});

test('a plugin port held by another process is reported as E_PORT_IN_USE without stalling the MCP handshake', async (t) => {
  const held = await holdLoopbackPort(t);
  const world = await TestWorld.create(t, await unusedLoopbackPort(t));
  const fixture = await world.addConfig('held-port-config.json', held.port);

  const startedAt = Date.now();
  const managed = await world.startClient(fixture, {
    label: 'Held port client',
    mode: 'brokered',
    initializationTimeoutMs: 15_000,
  });
  const health = await callEnvelope(managed.client, 'health');
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 5_000, `startup and health took ${String(elapsedMs)} ms`);
  assert.deepEqual(setupErrors(health), [await directModeSetupIssue(held.port, SECRET)]);
  assert.equal(setupErrors(health)[0]?.code, 'E_PORT_IN_USE');
  assert.equal(health.result?.broker_connected, false);
});

test('a shim whose broker could not start attaches on a later tool call once the cause clears', async (t) => {
  const held = await holdLoopbackPort(t);
  const world = await TestWorld.create(t, await unusedLoopbackPort(t));
  const fixture = await world.addConfig('recovering-config.json', held.port);
  const managed = await world.startClient(fixture, {
    label: 'Recovering client',
    mode: 'brokered',
    initializationTimeoutMs: 15_000,
  });
  assert.deepEqual(setupErrorCodes(await callEnvelope(managed.client, 'health')), ['E_PORT_IN_USE']);

  // Still held: the call re-runs election, fails, and health keeps the latest cause.
  const whileHeld = await callEnvelope(managed.client, 'get_project_state');
  assert.equal(whileHeld.error?.code, 'E_BROKER_UNAVAILABLE');
  assert.deepEqual(setupErrorCodes(await callEnvelope(managed.client, 'health')), ['E_PORT_IN_USE']);

  await held.release();
  const afterRelease = await callEnvelope(managed.client, 'get_project_state');
  assert.equal(afterRelease.error?.code, 'E_PLUGIN_NOT_CONNECTED');
  const health = await callEnvelope(managed.client, 'health');
  assert.equal(health.result?.broker_connected, true);
  assert.deepEqual(setupErrors(health), []);

  await world.addPlugin(held.port);
  assert.equal((await callEnvelope(managed.client, 'get_project_state')).ok, true);
});
