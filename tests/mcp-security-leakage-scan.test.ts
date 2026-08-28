// What must never leave the adapter, and what a client must never be able to
// decide by saying so.
//
// Two separate claims are checked here.
//
// The first is disclosure: the shared secret, and anything a client puts in
// its own metadata, must not reach stdout, stderr, a `health` envelope, the
// broker rendezvous record, or a process argument list. Every scan is paired
// with a positive control that proves the surface being scanned was actually
// read and actually contains something.
//
// The second is authority: what a client declares about itself — its MCP
// revision, its capabilities, its name and version — is a claim, not a
// credential. It must not decide which client owns the controller lease and it
// must not decide which client a confirmed scoped directory belongs to.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import type { TestContext } from 'node:test';

import { computeConfigIdentity, ensureRuntimeDirectory, ipcEndpointFor } from '../src/adapter/broker/endpoint.js';
import { IPC_PROTOCOL_VERSION } from '../src/adapter/broker/ipc-protocol.js';
import { ADAPTER_VERSION } from '../src/adapter/mcp-server.js';
import { readBrokerRecord, writeBrokerRecordAtomic } from '../src/adapter/broker/rendezvous.js';
import {
  advertisedTools,
  envelopeOf,
  errorCodeOf,
  exchange,
  exchangeExpectingSilence,
  legacyRequest,
  modernRequest,
  openLegacyConnection,
} from './helpers/mcp-era-wire.ts';
import {
  CLI_ENTRY_PATH,
  describeStdoutFramingViolations,
  startRawStdioServer,
} from './helpers/raw-stdio.ts';
import type { RawStdioSession } from './helpers/raw-stdio.ts';
import { processEntry, type ProcessEntry } from './helpers/process-scan.ts';
import { createRuntimeRoot, removeRuntimeRoot } from './helpers/runtime-root.ts';
import { WireFakePlugin, waitUntil } from './helpers/wire-plugin.ts';

assert.ok(
  existsSync(CLI_ENTRY_PATH),
  `the built executable is missing at ${CLI_ENTRY_PATH}; run \`npm run build\` before this suite`,
);

/** Distinctive enough that a substring match cannot be a coincidence. */
const SECRET = 'leakage-scan-secret-Zq7Z9uL4tR2mWx8v';
let nextPort = 42_500;

function allocatePort(): number {
  const port = nextPort++;
  assert.ok(port <= 42_599, 'the leakage scan tests must stay inside the reserved 42500-42599 port range');
  return port;
}

/**
 * Client-declared strings a hostile client might try to smuggle through. Each
 * is distinctive, and each targets a different sink: log formatting, JSON-RPC
 * framing, terminal rendering, path handling, and the secret itself.
 */
const ADVERSARIAL_CLIENT_NAMES: readonly string[] = [
  'name-with-\n{"jsonrpc":"2.0","id":999,"method":"injected"}',
  'name-with-[31mansi[0m-escape',
  'name-with-../../../etc/passwd-traversal',
  `name-carrying-the-secret-${SECRET}`,
  'name-with-`command` $(substitution) ${expansion}',
];

/**
 * The label used while scanning for a leaked MCP client identity.
 *
 * `--client-label` is a separate, deliberately visible surface: the broker
 * reports it to other clients as `controller_owner`, which is why it is held to
 * its own contract in its own test rather than mixed into the scan below.
 * Keeping it fixed and distinctive here means an occurrence of the adversarial
 * MCP client name on any scanned surface can only have come from the MCP
 * identity the client declared.
 */
const METADATA_SCAN_LABEL = 'adversarial-metadata-scan-client';

/**
 * Self-declared `--client-label` values a hostile client might choose, minus
 * the secret-carrying one: a client that puts a string it already knows into
 * its own label discloses nothing, and mixing that case in would make the
 * "the shared secret never reaches the health envelope" assertion ambiguous.
 */
const ADVERSARIAL_CLIENT_LABELS: readonly string[] = [
  'label-with-\n{"jsonrpc":"2.0","id":998,"method":"injected"}',
  'label-with-\u001b[31mansi\u001b[0m-escape',
  'label-with-../../../etc/passwd-traversal',
  'label-with-`command` $(substitution) ${expansion}',
];

/**
 * The package version the adapter reports over broker IPC. Must track the real
 * `ADAPTER_VERSION`: the client's handshake probe rejects a broker whose
 * acknowledged `package_version` does not match it (see `probe()` in
 * `src/adapter/cli.ts`), so a stale local literal here silently fails every
 * exchange in this file at the handshake layer instead of relaying anything.
 */
const ADAPTER_PACKAGE_VERSION = ADAPTER_VERSION;

/**
 * Distinctive values placed in a tool argument to prove a scan reaches the
 * frames it clears. One per scanned path, so a sentinel found on one path
 * cannot stand in for the other.
 */
const PLUGIN_FRAME_SENTINEL = 'plugin-frame-reachability-sentinel-Kx4Qw9';
const IPC_FRAME_SENTINEL = 'broker-ipc-reachability-sentinel-Vt7Ry2';

/**
 * MCP-level values that belong to the wire between the client and this adapter,
 * and must not appear below it — neither in a broker IPC frame nor in a plugin
 * protocol envelope. Both of those speak this project's own protocols, which
 * know nothing about MCP revisions, MCP capabilities, or MCP client identity.
 */
const MCP_LEVEL_VALUES_FORBIDDEN_BELOW_THE_ADAPTER: readonly string[] = [
  '2026-07-28',
  '2025-06-18',
  'io.modelcontextprotocol',
  'clientCapabilities',
  'clientInfo',
  'listChanged',
  'resultType',
  'cacheScope',
  'elicitation',
];

/** MCP-level protocol metadata that must never reach a `health` envelope. */
const MCP_PROTOCOL_METADATA_MARKERS: readonly string[] = [
  '2026-07-28',
  '2025-06-18',
  'io.modelcontextprotocol',
  'clientCapabilities',
  'clientInfo',
  'listChanged',
  'resultType',
  'cacheScope',
];

interface LeakWorld {
  port: number;
  configPath: string;
  runtimeRoot: string;
  brokerRecordPath: string;
  /** The IPC endpoint a broker for this config binds, derived the way the adapter derives it. */
  brokerEndpointPath: string;
  plugin: WireFakePlugin;
  start(options?: {
    mode?: 'direct' | 'brokered';
    label?: string;
    clientName?: string;
    era?: 'legacy' | 'modern';
  }): Promise<RawStdioSession>;
  attachPlugin(): Promise<void>;
}

async function createLeakWorld(t: TestContext): Promise<LeakWorld> {
  const port = allocatePort();
  const root = await mkdtemp(join(tmpdir(), 'blockbench-mcp-leakage-scan-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, mode: 'shared-secret', port, secret: SECRET }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const runtimeRoot = await createRuntimeRoot('bbleak-');
  const brokerDirectory = join(runtimeRoot, 'minecraft-blockbench-mcp');
  const brokerRecordPath = join(brokerDirectory, `broker-${computeConfigIdentity(configPath)}.json`);
  const brokerEndpointPath = ipcEndpointFor({
    platform: process.platform,
    runtimeDir: brokerDirectory,
    identity: computeConfigIdentity(configPath),
  });
  const plugin = new WireFakePlugin({ port, secret: SECRET });
  const sessions: RawStdioSession[] = [];

  t.after(async () => {
    await plugin.close();
    await Promise.all(sessions.map((session) => session.dispose()));
    const record = await readBrokerRecord(brokerRecordPath).catch(() => null);
    // A record this test wrote itself can name this process as the broker; the
    // teardown must never signal the test runner.
    if (record !== null && record.broker_pid !== process.pid) {
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
    brokerEndpointPath,
    plugin,
    async start(options = {}) {
      const mode = options.mode ?? 'direct';
      const args = mode === 'direct' ? ['--direct'] : [];
      if (options.label !== undefined) args.push('--client-label', options.label);
      const session = startRawStdioServer({
        args,
        env: {
          BLOCKBENCH_MCP_CONFIG: configPath,
          XDG_RUNTIME_DIR: runtimeRoot,
          BLOCKBENCH_MCP_REQUEST_TIMEOUT_MS: '5000',
          BLOCKBENCH_MCP_LEASE_IDLE_TIMEOUT_MS: '1000',
          BLOCKBENCH_MCP_BROKER_IDLE_TIMEOUT_MS: '2000',
          ...(mode === 'brokered' ? { BLOCKBENCH_MCP_BROKER: '1' } : {}),
        },
      });
      sessions.push(session);
      const clientInfo = { name: options.clientName ?? 'leakage-scan-client', version: '1.0.0' };
      if ((options.era ?? 'legacy') === 'legacy') {
        await openLegacyConnection(session, { id: 'open', protocolVersion: '2025-06-18', clientInfo });
      } else {
        await exchange(session, modernRequest('open', 'tools/list', {}, { clientInfo }), 20_000);
      }
      return session;
    },
    async attachPlugin() {
      const before = plugin.requests('revoke_scope').length;
      await plugin.connect();
      await waitUntil(
        () => plugin.requests('revoke_scope').length > before,
        'the scope revocation that starts every authenticated plugin session',
      );
    },
  };
}

/**
 * A running process as this platform reports it, or null when nothing is
 * running under that pid.
 *
 * This used to read `/proc/<pid>/cmdline` directly and answer null for anything
 * it could not read, which off Linux is *everything*: the one scan proving the
 * shared secret never reaches an argument vector reported green on macOS and
 * Windows without having looked at a single argument — on exactly the two
 * platforms the matrix exists to cover. `tests/helpers/process-scan.ts`
 * enumerates real command lines on linux, darwin and win32 and throws rather
 * than reporting an empty one when it cannot query, so a null answer now
 * carries the single meaning the Linux read gave it: that pid is gone.
 */
async function brokerProcess(pid: number): Promise<ProcessEntry | null> {
  return processEntry(pid);
}

test('the shared secret never reaches stdout, stderr, a health envelope, or the broker rendezvous record', async (t) => {
  const world = await createLeakWorld(t);
  const session = await world.start({ mode: 'brokered' });
  await world.attachPlugin();

  const health = await exchange(session, legacyRequest(1, 'tools/call', { name: 'health', arguments: {} }), 20_000);
  await exchange(session, legacyRequest(2, 'tools/call', { name: 'get_project_state', arguments: {} }));
  await exchange(session, legacyRequest(3, 'tools/call', { name: 'read_file', arguments: { path: 42 } }));
  await exchange(session, legacyRequest(4, 'tools/call', { name: 'not_a_registered_tool', arguments: {} }));

  const stdout = session.stdoutLines().join('\n');
  const stderr = session.stderrText();
  const envelope = JSON.stringify(envelopeOf(health));
  const record = JSON.stringify(await readBrokerRecord(world.brokerRecordPath));

  for (const [surface, text] of [
    ['stdout', stdout],
    ['stderr', stderr],
    ['the health envelope', envelope],
    ['the broker rendezvous record', record],
  ] as const) {
    assert.ok(!text.includes(SECRET), `the shared secret reached ${surface}`);
  }

  // Positive controls: each scanned surface was really read and really has
  // content, so a clean scan is not an empty one.
  assert.ok(stdout.includes('"jsonrpc"'), 'the stdout scan read no JSON-RPC message at all');
  assert.ok(stderr.includes('[minecraft-blockbench-mcp]'), 'the stderr scan read no adapter log line at all');
  assert.ok(envelope.includes('adapter_version'), 'the health envelope scan read no health payload at all');
  assert.ok(record.includes('ipc_protocol_version'), 'the broker record scan read no record at all');
  // And the secret really is the value in play: the plugin authenticated with it.
  assert.ok(world.plugin.requests('revoke_scope').length >= 1, 'the plugin never authenticated with this secret');
});

test('the shared secret never reaches the process arguments of the adapter or of the broker it starts', async (t) => {
  const world = await createLeakWorld(t);
  const session = await world.start({ mode: 'brokered', label: 'argument-scan-client' });
  await world.attachPlugin();
  await exchange(session, legacyRequest(1, 'tools/call', { name: 'health', arguments: {} }), 20_000);

  const record = await readBrokerRecord(world.brokerRecordPath);
  assert.ok(record !== null, 'no broker was elected, so there are no broker arguments to scan');
  const broker = await brokerProcess(record.broker_pid);
  // A pid that cannot be found means the broker died mid-test. That is a
  // failure of this test's premise, not something to note in a diagnostic and
  // then step over — the scan below would have nothing to read, and calling
  // that a pass is exactly what the /proc-only version did on every non-Linux
  // runner.
  assert.ok(
    broker !== null,
    `no process is running as broker pid ${String(record.broker_pid)}, so its arguments could not be scanned`,
  );
  const brokerArguments = broker.argv;
  assert.ok(
    !brokerArguments.join('\0').includes(SECRET) && !broker.commandLine.includes(SECRET),
    `the shared secret appeared in the broker's command line: ${JSON.stringify(broker.commandLine)}`,
  );
  // Positive control: the scan read a real command line for a real broker.
  assert.ok(
    brokerArguments.some((argument) => argument.includes('cli.js')),
    `the argument scan did not read the broker's own command line: ${JSON.stringify(brokerArguments)}`,
  );
  assert.ok(brokerArguments.length >= 2, 'the argument scan read a suspiciously short command line');
});

test('adversarial client metadata is never echoed into stdout, stderr, health, or the broker record', async (t) => {
  for (const clientName of ADVERSARIAL_CLIENT_NAMES) {
    const world = await createLeakWorld(t);
    const session = await world.start({ mode: 'brokered', clientName, label: METADATA_SCAN_LABEL });
    await world.attachPlugin();

    // The plugin command comes first on purpose. `health` and `tools/list` take
    // no controller lease, so a `health` read taken before any plugin command
    // reports `controller_owner: null` and samples the one moment at which the
    // field this scan cares about cannot carry anything at all.
    await exchange(session, legacyRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }), 20_000);
    const health = await exchange(session, legacyRequest(2, 'tools/call', { name: 'health', arguments: {} }));
    const sampled = envelopeOf(health).result as Record<string, unknown>;
    assert.equal(
      sampled.controller_state,
      'owned',
      'the health envelope was sampled while no client held the controller lease, so controller_owner was empty ' +
        'and this scan would pass without reading anything',
    );
    assert.equal(
      sampled.controller_owner,
      METADATA_SCAN_LABEL,
      'the sampled health envelope does not name the client label this session declared, so the scan is not ' +
        'looking at a populated owner field',
    );

    const stdout = session.stdoutLines().join('\n');
    const stderr = session.stderrText();
    const envelope = JSON.stringify(envelopeOf(health));
    const record = JSON.stringify(await readBrokerRecord(world.brokerRecordPath));
    const pluginFrames = JSON.stringify(world.plugin.frames);

    for (const [surface, text] of [
      ['stdout', stdout],
      ['stderr', stderr],
      ['the health envelope', envelope],
      ['the broker rendezvous record', record],
      ['a plugin protocol envelope', pluginFrames],
    ] as const) {
      assert.ok(
        !text.includes(clientName),
        `a client-declared name reached ${surface}: ${JSON.stringify(clientName)}`,
      );
    }
    // The injected JSON-RPC fragment must not have become a message either.
    const framing = describeStdoutFramingViolations(session.stdoutLines(), session.pendingStdout());
    assert.deepEqual(framing, [], `client metadata broke stdout framing: ${JSON.stringify(framing)}`);
    assert.equal(
      session.stdoutLines().filter((line) => line.includes('"injected"')).length,
      0,
      'a JSON-RPC fragment inside client metadata was re-emitted as a message',
    );

    // Positive control on every scanned surface.
    assert.ok(stdout.includes('"jsonrpc"'), 'the stdout scan read nothing');
    assert.ok(stderr.includes('[minecraft-blockbench-mcp]'), 'the stderr scan read nothing');
    assert.ok(envelope.includes('adapter_version'), 'the health envelope scan read nothing');
    assert.ok(record.includes('ipc_protocol_version'), 'the broker record scan read nothing');
    assert.ok(world.plugin.frames.length > 0, 'the plugin envelope scan read nothing');
    await session.dispose();
  }
});

/**
 * `controller_owner` is a deliberate disclosure, and this is the test that says
 * so out loud.
 *
 * The broker reports the lease holder to every other client by the label that
 * holder passed on its own command line with `--client-label`. That is design,
 * not leakage: it predates this migration (see the `--client-label` section of
 * README.md), and the same label is what the `E_CLIENT_BUSY` message names so a
 * person can tell which of their sessions is holding Blockbench. It is a claim
 * a client makes about itself, never a credential — `a client cannot take the
 * controller lease by claiming another client identity` covers that half.
 *
 * What must never appear in that envelope is anything the client did not put
 * there itself: the shared secret, and the MCP-level protocol metadata — the
 * negotiated revision, the declared capabilities, the declared client identity.
 */
test('the health envelope reports a peer\u2019s self-declared client label as controller_owner by design, and carries no shared secret or MCP protocol metadata', async (t) => {
  for (const label of ADVERSARIAL_CLIENT_LABELS) {
    const world = await createLeakWorld(t);
    const session = await world.start({
      mode: 'brokered',
      label,
      clientName: 'controller-owner-contract-client',
      era: 'modern',
    });
    await world.attachPlugin();

    // Take the lease first: the owner field is only populated once a command
    // that needs the plugin has been served.
    await exchange(
      session,
      modernRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }),
      20_000,
    );
    const health = await exchange(session, modernRequest(2, 'tools/call', { name: 'health', arguments: {} }));
    const envelope = envelopeOf(health);
    const result = envelope.result as Record<string, unknown>;

    assert.equal(result.controller_state, 'owned', 'the lease was not held when the envelope was sampled');
    assert.equal(
      result.controller_owner,
      label,
      'controller_owner did not report the label this client declared for itself, so this test is not observing ' +
        'the disclosure it exists to describe',
    );

    // Everything except that one field. The label is expected there and only
    // there, so it is removed rather than searched for.
    const withoutOwner = JSON.stringify({ ...envelope, result: { ...result, controller_owner: '<owner-label>' } });
    assert.ok(!withoutOwner.includes(SECRET), 'the shared secret reached the health envelope');
    assert.ok(
      !withoutOwner.includes(label),
      `the self-declared client label reached the health envelope somewhere other than controller_owner: ${JSON.stringify(label)}`,
    );
    for (const marker of MCP_PROTOCOL_METADATA_MARKERS) {
      assert.ok(
        !withoutOwner.includes(marker),
        `the health envelope carries the MCP-level value ${marker}, which belongs to the wire and not to the ` +
          'adapter status a tool reports',
      );
    }
    assert.ok(
      !withoutOwner.includes('controller-owner-contract-client'),
      'the MCP client identity this session declared reached the health envelope',
    );

    // The label is disclosed to MCP clients and nowhere else: not to Blockbench,
    // not to the rendezvous record, not to the adapter log.
    const pluginFrames = JSON.stringify(world.plugin.frames);
    const record = JSON.stringify(await readBrokerRecord(world.brokerRecordPath));
    for (const [surface, text] of [
      ['a plugin protocol envelope', pluginFrames],
      ['the broker rendezvous record', record],
      ['stderr', session.stderrText()],
    ] as const) {
      assert.ok(!text.includes(label), `a self-declared client label reached ${surface}: ${JSON.stringify(label)}`);
    }

    // A hostile label cannot break framing on its way to controller_owner.
    const framing = describeStdoutFramingViolations(session.stdoutLines(), session.pendingStdout());
    assert.deepEqual(framing, [], `a client label broke stdout framing: ${JSON.stringify(framing)}`);
    assert.equal(
      session.stdoutLines().filter((line) => line.includes('"injected"')).length,
      0,
      'a JSON-RPC fragment inside a client label was re-emitted as a message',
    );

    // Positive controls: every scanned surface was read and carries content.
    assert.ok(withoutOwner.includes('adapter_version'), 'the health envelope scan read nothing');
    assert.ok(record.includes('ipc_protocol_version'), 'the broker record scan read nothing');
    assert.ok(world.plugin.frames.length > 0, 'the plugin envelope scan read nothing');
    assert.ok(session.stderrText().includes('[minecraft-blockbench-mcp]'), 'the stderr scan read nothing');
    await session.dispose();
  }
});

/**
 * What this covers, and what it does not.
 *
 * The impostor here declares the holder's `--client-label` and the holder's MCP
 * `clientInfo`. Neither is what the lease is keyed on: `ControllerLease.acquire`
 * in `src/adapter/broker/lease.ts` compares the broker IPC `session_id`, which
 * a stdio shim generates for itself and never publishes. So this asserts that
 * the two client-declared identities carry no authority — the surface a client
 * can actually reach over MCP — and it does not, and cannot, say anything about
 * a peer that declares the holder's `session_id` over broker IPC. That is a
 * different boundary, reachable only by a process that can already open the
 * broker's unix socket under the caller's own `0o700` runtime directory.
 */
test('a client cannot take the controller lease by claiming another client identity', async (t) => {
  const world = await createLeakWorld(t);
  const holder = await world.start({ mode: 'brokered', label: 'holder', clientName: 'holder' });
  await world.attachPlugin();
  await exchange(holder, legacyRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }));

  const owned = envelopeOf(
    await exchange(holder, legacyRequest(2, 'tools/call', { name: 'health', arguments: {} })),
  ).result as Record<string, unknown>;
  assert.equal(owned.controller_state, 'owned', 'the first client never took the lease');
  const owner = owned.controller_owner;
  assert.ok(typeof owner === 'string', 'the lease has no owner to impersonate');

  // A second shim declares the holder's label and the holder's MCP identity,
  // then asks for the plugin while the holder still owns it.
  const impostor = await world.start({
    mode: 'brokered',
    label: String(owner),
    clientName: 'holder',
    era: 'modern',
  });
  const refused = envelopeOf(
    await exchange(impostor, modernRequest(3, 'tools/call', { name: 'get_project_state', arguments: {} })),
  );

  if (refused.ok === true) {
    // The holder's lease had already gone idle, which is a legitimate handover
    // rather than impersonation. Re-establish it and try again while it is
    // certainly held.
    await exchange(holder, legacyRequest(4, 'tools/call', { name: 'get_project_state', arguments: {} }));
    const secondTry = envelopeOf(
      await exchange(impostor, modernRequest(5, 'tools/call', { name: 'get_project_state', arguments: {} })),
    );
    assert.equal(
      errorCodeOf(secondTry),
      'E_CLIENT_BUSY',
      'a client that declared another client identity was let past the controller lease',
    );
  } else {
    assert.equal(
      errorCodeOf(refused),
      'E_CLIENT_BUSY',
      'a client that declared another client identity was refused for the wrong reason',
    );
  }

  // Positive control: the holder still owns its own lease and still works.
  const stillOwned = envelopeOf(
    await exchange(holder, legacyRequest(6, 'tools/call', { name: 'get_project_state', arguments: {} })),
  );
  assert.equal(stillOwned.ok, true, 'the impersonation attempt disturbed the real lease holder');
});

/**
 * A broker stand-in that records every raw IPC line a client writes to it.
 *
 * The scan below has to look at what the adapter actually puts on the broker
 * socket, and no client of a real broker can see that: a peer attached to the
 * same broker observes only what the broker sends outward. Standing in for the
 * broker is what makes the adapter's own frames readable, and the lines are
 * kept as raw text so the scan reads the bytes rather than a re-serialization
 * of them.
 */
class RecordingBroker {
  readonly lines: string[] = [];
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async listen(endpoint: string, port: number, runtimeDir: string): Promise<RecordingBroker> {
    let broker: RecordingBroker | null = null;
    const server = createServer((socket: Socket) => {
      let buffered = '';
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
          if (line === '') continue;
          broker?.lines.push(line);
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.type === 'client_hello') {
            socket.write(
              `${JSON.stringify({
                type: 'hello_ack',
                ipc_protocol_version: IPC_PROTOCOL_VERSION,
                package_version: ADAPTER_PACKAGE_VERSION,
                broker_instance_id: 'recording-broker',
                broker_pid: process.pid,
                effective_port: port,
              })}\n`,
            );
            continue;
          }
          if (message.type === 'request') {
            // Every relayed command is refused the same way, so no result
            // schema has to be satisfied and the adapter still produces its
            // ordinary failure envelope on the MCP side.
            socket.write(
              `${JSON.stringify({
                type: 'response',
                id: message.id,
                ok: false,
                error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'No scoped directory has been confirmed.' },
              })}\n`,
            );
          }
        }
      });
    });
    broker = new RecordingBroker(server);
    // The runtime directory holds the rendezvous record on every platform, and
    // on POSIX it also holds the socket file this server binds. It is created
    // from the directory rather than from the endpoint, because a Windows
    // endpoint is a named pipe whose `dirname` is not a directory at all.
    await ensureRuntimeDirectory(runtimeDir);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => resolve());
    });
    return broker;
  }

  /** Every recorded line that decoded as the given IPC message type. */
  messagesOfType(type: string): Array<Record<string, unknown>> {
    return this.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message.type === type);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

test('a declared MCP revision, capability set, or client identity never reaches a plugin protocol envelope', async (t) => {
  const world = await createLeakWorld(t);
  const session = await world.start({
    mode: 'brokered',
    era: 'modern',
    clientName: 'identity-scan-client',
    label: 'identity-scan-client',
  });
  await world.attachPlugin();
  await exchange(
    session,
    modernRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }, {
      clientCapabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    }),
    20_000,
  );
  // Reachability control for the scan below. The forbidden values are all
  // things the adapter is supposed to strip, so their absence proves nothing
  // until something a client controls is shown to travel this same path into a
  // plugin envelope. A tool argument does, so a sentinel is sent through one.
  await exchange(
    session,
    modernRequest(2, 'tools/call', { name: 'read_file', arguments: { path: PLUGIN_FRAME_SENTINEL } }),
  );

  const pluginFrames = JSON.stringify(world.plugin.frames);
  assert.ok(
    pluginFrames.includes(PLUGIN_FRAME_SENTINEL),
    'a value placed in a tool argument did not appear in any plugin protocol envelope, so this scan cannot ' +
      'show that MCP-level values are absent — it has not been shown to reach the frames at all',
  );

  for (const forbidden of MCP_LEVEL_VALUES_FORBIDDEN_BELOW_THE_ADAPTER) {
    assert.ok(!pluginFrames.includes(forbidden), `a plugin protocol envelope carries the MCP-level value ${forbidden}`);
  }
  // Positive control: commands really were relayed, in both shapes.
  assert.ok(world.plugin.requests('get_project_state').length >= 1, 'no command was relayed, so nothing was scanned');
  assert.ok(world.plugin.requests('read_file').length >= 1, 'the sentinel command was never relayed');
});

test('a declared MCP revision, capability set, or client identity never reaches a broker IPC frame or the rendezvous record', async (t) => {
  const world = await createLeakWorld(t);
  const broker = await RecordingBroker.listen(world.brokerEndpointPath, world.port, dirname(world.brokerRecordPath));
  t.after(async () => {
    await broker.close();
  });
  await writeBrokerRecordAtomic(world.brokerRecordPath, {
    endpoint: world.brokerEndpointPath,
    broker_instance_id: 'recording-broker',
    broker_pid: process.pid,
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: ADAPTER_PACKAGE_VERSION,
    ws_port: world.port,
  });

  const session = await world.start({
    mode: 'brokered',
    era: 'modern',
    clientName: 'ipc-scan-client',
    label: 'ipc-scan-client',
  });
  await exchange(
    session,
    modernRequest(1, 'tools/call', { name: 'get_project_state', arguments: {} }, {
      clientCapabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    }),
    20_000,
  );
  // The same reachability control as the plugin scan, on the IPC path: a tool
  // argument does cross it, so an absence here is a decision rather than an
  // empty capture.
  await exchange(session, modernRequest(2, 'tools/call', { name: 'read_file', arguments: { path: IPC_FRAME_SENTINEL } }));
  await session.settle(200);

  const ipcFrames = broker.lines.join('\n');
  assert.ok(
    ipcFrames.includes(IPC_FRAME_SENTINEL),
    'a value placed in a tool argument did not appear in any captured broker IPC frame, so this scan has not ' +
      'been shown to read the frames it claims to clear',
  );

  const record = JSON.stringify(await readBrokerRecord(world.brokerRecordPath));
  for (const forbidden of MCP_LEVEL_VALUES_FORBIDDEN_BELOW_THE_ADAPTER) {
    assert.ok(!ipcFrames.includes(forbidden), `a broker IPC frame carries the MCP-level value ${forbidden}`);
    assert.ok(!record.includes(forbidden), `the broker rendezvous record carries the MCP-level value ${forbidden}`);
  }

  // Positive controls: the capture holds the frames a working attachment
  // produces, in both of the shapes the adapter sends.
  assert.equal(broker.messagesOfType('client_hello').length, 1, 'the capture holds no broker handshake');
  assert.ok(broker.messagesOfType('request').length >= 2, 'the capture holds fewer relayed requests than were sent');
  assert.ok(record.includes('ws_port'), 'the broker record scan read nothing');
});

test('stdout carries exactly one JSON-RPC object per line across startup, work, errors, cancellation, and shutdown', async (t) => {
  const world = await createLeakWorld(t);
  const session = await world.start({ mode: 'direct' });
  await world.attachPlugin();

  // Startup is already behind us: the opening handshake produced line 1.
  assert.equal(session.stdoutLines().length, 1, 'the opening handshake did not produce exactly one line');

  // Normal operation.
  const listed = await exchange(session, legacyRequest(1, 'tools/list'));
  assert.ok(advertisedTools(listed).length > 0);
  await exchange(session, legacyRequest(2, 'tools/call', { name: 'get_project_state', arguments: {} }));

  // Errors, in each of the shapes this server can produce.
  await exchange(session, legacyRequest(3, 'tools/call', { name: 'read_file', arguments: { path: 42 } }));
  await exchange(session, legacyRequest(4, 'tools/call', { name: 'not_a_registered_tool', arguments: {} }));
  await exchange(session, legacyRequest(5, 'blockbench/not-a-method'));
  await exchange(session, legacyRequest(6, 'tools/call', { name: 'validate_geckolib_file', arguments: {} }));

  // Hostile framing: a malformed line, a frame with no `jsonrpc`, and a batch
  // array. None of them may put anything unframed on stdout.
  session.sendRawLine('{not json at all');
  session.sendRawLine('{"id":7,"method":"tools/list"}');
  session.sendRawLine('[{"jsonrpc":"2.0","id":8,"method":"tools/list"}]');
  await session.settle(400);

  // Cancellation, including the notification for a request that never existed.
  const silent = await exchangeExpectingSilence(session, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 4242, reason: 'never issued' },
  });
  assert.deepEqual(silent, [], 'a cancellation for an unknown request produced a client-facing message');

  // Recovery: the plugin drops and comes back, and a later request works.
  await world.plugin.disconnect();
  const whileGone = envelopeOf(
    await exchange(session, legacyRequest(9, 'tools/call', { name: 'get_project_state', arguments: {} })),
  );
  assert.equal(errorCodeOf(whileGone), 'E_PLUGIN_NOT_CONNECTED');
  await world.attachPlugin();
  const afterRecovery = envelopeOf(
    await exchange(session, legacyRequest(10, 'tools/call', { name: 'get_project_state', arguments: {} })),
  );
  assert.equal(afterRecovery.ok, true, 'the adapter did not recover after the plugin came back');

  // Shutdown.
  session.kill('SIGTERM');
  const exit = await session.waitForExit();
  await session.settle(300);

  const lines = session.stdoutLines();
  assert.deepEqual(
    describeStdoutFramingViolations(lines, session.pendingStdout()),
    [],
    'stdout carried something that is not exactly one JSON-RPC object per line',
  );
  assert.equal(session.pendingStdout(), '', 'stdout ended with an unterminated partial line');
  for (const line of lines) {
    assert.ok(!line.includes('[minecraft-blockbench-mcp]'), `an adapter log line reached stdout: ${line.slice(0, 200)}`);
    assert.ok(!line.includes(SECRET), 'the shared secret reached stdout');
  }
  // Positive control: the scan covered a real, busy stream carrying every
  // outbound shape this server can produce, and a real exit.
  const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(lines.length >= 9, `the framing scan only saw ${String(lines.length)} line(s)`);
  assert.ok(
    messages.some((message) => 'result' in message && (message.result as Record<string, unknown>).isError !== true),
    'the framing scan saw no ordinary successful result',
  );
  assert.ok(
    messages.some((message) => (message.result as Record<string, unknown> | undefined)?.isError === true),
    'the framing scan saw no isError tool result',
  );
  assert.ok(messages.some((message) => 'error' in message), 'the framing scan saw no JSON-RPC error');
  assert.equal(exit.signal === 'SIGTERM' || exit.code !== null, true, 'the process did not actually shut down');
  assert.ok(
    session.stderrText().includes('[minecraft-blockbench-mcp]'),
    'no adapter log reached stderr, so the stdout purity check has no positive control',
  );
});
