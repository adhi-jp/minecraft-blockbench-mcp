#!/usr/bin/env node
// Stdio MCP adapter entry point, launched by Claude Code (or any MCP client
// that supports local stdio servers). stdout carries MCP JSON-RPC frames;
// all logging goes to stderr and never includes the shared secret.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { makeError } from '../shared/protocol.js';
import { resolveDefaultConfigPath } from '../shared/config-path.js';
import { routeCli } from '../setup/route.js';
import { BrokerClient, BrokerHandshakeError, type BrokerClientHello } from './broker/broker-client.js';
import { HybridOpeningInitializeNormalizer } from './hybrid-opening-normalizer.js';
import { BrokerServer } from './broker/broker-server.js';
import { electOrAttach } from './broker/election.js';
import { computeConfigIdentity, ensureRuntimeDirectory, ipcEndpointFor, resolveRuntimeDirectory } from './broker/endpoint.js';
import { IPC_PROTOCOL_VERSION, type StatusEventMessage } from './broker/ipc-protocol.js';
import { readBrokerRecord, writeBrokerRecordAtomic, type BrokerRecord } from './broker/rendezvous.js';
import { buildBrokerSpawnArgs, spawnDetachedBroker } from './broker/spawn.js';
import { loadConfig, resolveAdapterMode, type AdapterConfig, type SetupIssue } from './config.js';
import { ADAPTER_VERSION, buildMcpServer, type BrokerStatus, type PluginBridge } from './mcp-server.js';
import { WsBridge } from './ws-bridge.js';

function logLine(line: string): void {
  process.stderr.write(`[minecraft-blockbench-mcp] ${line}\n`);
}

interface LoadedAdapterSettings {
  config: AdapterConfig;
  issues: SetupIssue[];
  resolvedConfigPath: string | null;
}

function loadAdapterSettings(argv: string[]): LoadedAdapterSettings {
  const implicitDefaultPath = resolveDefaultConfigPath({
    platform: process.platform,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME ?? homedir(),
    appData: process.env.APPDATA,
    userProfile: process.env.USERPROFILE ?? homedir(),
  });
  const { config, issues, configSource } = loadConfig(
    argv,
    process.env,
    (path) => readFileSync(path, 'utf8'),
    implicitDefaultPath,
  );
  logLine(
    configSource.kind === 'none'
      ? 'Config source: no config file (CLI/env/defaults only).'
      : configSource.kind === 'explicit-failed'
        ? `Config source: ${configSource.path} (explicit, failed to load — see the setup issue below).`
        : `Config source: ${configSource.path} (${configSource.kind === 'default' ? 'default location' : 'explicit'}).`,
  );
  for (const issue of issues) {
    logLine(`Setup issue (${issue.code}): ${issue.message}`);
  }
  const configPath = configSource.path ?? implicitDefaultPath;
  return {
    config,
    issues,
    resolvedConfigPath: configPath === null || configPath === undefined ? null : resolve(configPath),
  };
}

interface BrokerLocation {
  configIdentity: string;
  endpoint: string;
  recordPath: string;
  runtimeDir: string;
}

async function resolveBrokerLocation(resolvedConfigPath: string): Promise<BrokerLocation> {
  const configIdentity = computeConfigIdentity(resolvedConfigPath);
  const runtimeDir = resolveRuntimeDirectory({
    platform: process.platform,
    env: process.env,
    configDir: dirname(resolvedConfigPath),
  });
  await ensureRuntimeDirectory(runtimeDir);
  return {
    configIdentity,
    endpoint: ipcEndpointFor({ platform: process.platform, runtimeDir, identity: configIdentity }),
    recordPath: `${runtimeDir}/broker-${configIdentity}.json`,
    runtimeDir,
  };
}

async function runBroker(argv: string[]): Promise<void> {
  const { config, resolvedConfigPath } = loadAdapterSettings(argv);
  if (resolvedConfigPath === null) {
    throw new Error('No configuration path could be resolved for the broker runtime.');
  }
  const { configIdentity, endpoint, recordPath } = await resolveBrokerLocation(resolvedConfigPath);
  const broker = new BrokerServer({
    endpoint,
    configIdentity,
    recordPath,
    packageVersion: ADAPTER_VERSION,
    port: config.port,
    secret: config.secret,
    requestTimeoutMs: config.requestTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatMissLimit: config.heartbeatMissLimit,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    maxMessageBytes: config.maxMessageBytes,
    leaseIdleTimeoutMs: config.leaseIdleTimeoutMs,
    brokerIdleTimeoutMs: config.brokerIdleTimeoutMs,
    clientHeartbeatIntervalMs: config.heartbeatIntervalMs,
    log: logLine,
  });

  try {
    const startResult = await broker.start();
    if (!startResult.ok) {
      logLine(`Setup issue (${startResult.issue.code}): ${startResult.issue.message}`);
      await broker.stop();
      process.exitCode = 1;
      return;
    }
    await writeBrokerRecordAtomic(recordPath, {
      endpoint,
      broker_instance_id: broker.instanceId,
      broker_pid: process.pid,
      ipc_protocol_version: IPC_PROTOCOL_VERSION,
      package_version: ADAPTER_VERSION,
      ws_port: config.port,
    });
  } catch (error) {
    await broker.stop().catch(() => undefined);
    logLine(`Broker failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let shutdown: Promise<void> | null = null;
  const stop = (reason: string) => {
    if (shutdown !== null) return;
    shutdown = (async () => {
      logLine(`Shutting down broker (${reason}).`);
      await broker.stop();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

class BrokerVersionMismatchError extends Error {
  constructor() {
    super('The running broker uses an incompatible IPC or package version.');
    this.name = 'BrokerVersionMismatchError';
  }
}

/**
 * Raised when the broker answered `client_hello` with `hello_reject` naming
 * `session_in_use`. Every other handshake failure leaves the broker's liveness
 * unknown; this one is positive proof the broker is alive and healthy, because
 * only a running broker holding a still-connected client on that `session_id`
 * can produce it.
 *
 * A shim allocates a fresh `session_id` per process (`randomUUID()` in
 * `attachBroker` below), so it can never collide with itself. The refusal
 * therefore means either a genuine duplicate session or the narrow reattach
 * window where the broker has not yet processed the previous socket's close. In
 * both cases the broker owns its endpoint and is serving other clients, so this
 * must never be mistaken for a stale record: unlinking that endpoint and
 * spawning a replacement would destroy a working broker.
 */
class BrokerSessionInUseError extends Error {
  constructor() {
    super('The running broker already has a connected client holding this session id.');
    this.name = 'BrokerSessionInUseError';
  }
}

function clientLabel(argv: string[]): string {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: { 'client-label': { type: 'string' } },
  });
  if (typeof values['client-label'] === 'string' && values['client-label'] !== '') {
    return values['client-label'];
  }
  const userAgent = process.env.npm_config_user_agent?.trim();
  return userAgent === undefined || userAgent === '' ? 'mcp-client' : basename(userAgent.split(/\s+/, 1)[0]) || 'mcp-client';
}

function unavailableBridge(code: 'E_BROKER_UNAVAILABLE' | 'E_BROKER_VERSION_MISMATCH'): PluginBridge {
  return {
    connected: false,
    listening: false,
    pluginInfo: null,
    request: async () => ({
      ok: false,
      error: makeError(
        code,
        code === 'E_BROKER_VERSION_MISMATCH'
          ? 'The running broker is incompatible with this adapter version.'
          : 'The broker is unavailable.',
      ),
    }),
  };
}

function brokerStatus(client: BrokerClient): BrokerStatus | null {
  const status: StatusEventMessage | null = client.brokerStatus();
  if (!client.listening || status === null) return null;
  return {
    broker_connected: true,
    controller_state: status.controller_state,
    controller_owner: status.controller_owner,
    client_count: status.client_count,
    effective_port: status.effective_port,
  };
}

async function attachBroker(
  config: AdapterConfig,
  resolvedConfigPath: string,
  location: BrokerLocation,
  label: string,
): Promise<BrokerClient | null> {
  const hello: BrokerClientHello = {
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: ADAPTER_VERSION,
    config_identity: location.configIdentity,
    session_id: randomUUID(),
    client_label: label,
    effective_port: config.port,
  };

  function createBrokerClient(): BrokerClient {
    let client!: BrokerClient;
    client = new BrokerClient({
      reattach: async () => {
        if ((await electBroker(client)) === null) throw new Error('Broker is unavailable.');
      },
    });
    return client;
  }

  async function probe(record: BrokerRecord, candidate: BrokerClient): Promise<BrokerClient | null> {
    try {
      const acknowledgement = await candidate.connect(record.endpoint, hello);
      if (
        acknowledgement.ipc_protocol_version !== IPC_PROTOCOL_VERSION ||
        acknowledgement.package_version !== ADAPTER_VERSION
      ) {
        throw new BrokerVersionMismatchError();
      }
      return candidate;
    } catch (error) {
      await candidate.close().catch(() => undefined);
      if (error instanceof BrokerVersionMismatchError) throw error;
      if (error instanceof BrokerHandshakeError && error.reason === 'version_mismatch') {
        throw new BrokerVersionMismatchError();
      }
      // `session_in_use` is refused *because* the broker is alive and already
      // has that session connected. Returning null here would report "no broker
      // answered", which sends electOrAttach into startBroker and costs a
      // healthy broker its endpoint; throw instead, so the refusal travels out
      // as a live-broker condition.
      if (error instanceof BrokerHandshakeError && error.reason === 'session_in_use') {
        throw new BrokerSessionInUseError();
      }
      return null;
    }
  }

  async function electBroker(preferredClient?: BrokerClient): Promise<BrokerClient | null> {
    let startedClient: BrokerClient | null = null;
    const connectRecord = async (record: BrokerRecord): Promise<BrokerClient | null> => {
      const candidate = preferredClient ?? createBrokerClient();
      return probe(record, candidate);
    };
    const startBroker = async (): Promise<BrokerRecord> => {
      // This callback runs while holding the startup lock, and only after a
      // probe that neither attached nor proved a broker alive. A probe that
      // reached a live broker which refused this shim does not arrive here at
      // all: it throws out of `probe` (BrokerVersionMismatchError or
      // BrokerSessionInUseError) and past electOrAttach entirely. So by the time
      // this runs, a socket file still sitting at the endpoint is a leftover
      // from a dead broker, and must be removed or the new broker cannot bind.
      // A failed probe alone does not prove that; the absence of those throws is
      // what does.
      if (process.platform !== 'win32') {
        await unlink(location.endpoint).catch(() => undefined);
      }
      spawnDetachedBroker(
        spawn,
        buildBrokerSpawnArgs({
          execPath: process.execPath,
          cliEntryPath: fileURLToPath(import.meta.url),
          configPath: resolvedConfigPath,
        }),
      );
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const record = await readBrokerRecord(location.recordPath);
        if (record !== null) {
          const client = await connectRecord(record);
          if (client !== null) {
            startedClient = client;
            return record;
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for a healthy broker.');
    };

    try {
      const election = await electOrAttach({
        lockPath: `${location.runtimeDir}/broker-${location.configIdentity}.lock`,
        readRecord: () => readBrokerRecord(location.recordPath),
        probe: connectRecord,
        startBroker,
        publish: async () => undefined,
        now: Date.now,
        pid: process.pid,
        waitTimeoutMs: 10_000,
      });
      if (election.kind === 'attached') return election.attachment;
      if (election.kind === 'started') return startedClient;
      return null;
    } catch (error) {
      if (error instanceof BrokerVersionMismatchError) throw error;
      if (error instanceof BrokerSessionInUseError) throw error;
      return null;
    }
  }

  return electBroker();
}

/**
 * The stdio serving options shared by direct and brokered mode.
 *
 * `legacy: 'serve'` keeps every supported 2025-era `initialize` revision
 * negotiating exactly as before, alongside 2026-07-28 clients that open with
 * `server/discover` and never send `initialize` at all.
 *
 * The transport is wrapped so that an `initialize` carrying the reserved
 * 2026-07-28 `_meta` claims is still served as a 2025-era connection instead of
 * being classified as 2026-07-28 and answered with `-32601`; see
 * `hybrid-opening-normalizer.ts` for the exact, closed rewrite it performs.
 *
 * No `onerror` is installed: out-of-band transport errors stay off stderr, the
 * way they always have, so a malformed inbound frame is dropped silently rather
 * than emitting a diagnostic line the wire contract never carried.
 */
function serveStdioOptions(): { legacy: 'serve'; transport: HybridOpeningInitializeNormalizer } {
  return {
    legacy: 'serve',
    transport: new HybridOpeningInitializeNormalizer(new StdioServerTransport()),
  };
}

/**
 * Closes the stdio serving handle at most once and never lets a teardown error
 * stop the rest of the shutdown: the process is exiting either way, and the
 * bridge/broker client still have to be released.
 */
async function closeStdio(handle: StdioServerHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // The connection is going away regardless; nothing here is recoverable.
  }
}

async function serveDirect(config: AdapterConfig, issues: SetupIssue[]): Promise<void> {
  const bridge = new WsBridge({
    port: config.port,
    secret: config.secret,
    requestTimeoutMs: config.requestTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatMissLimit: config.heartbeatMissLimit,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    maxMessageBytes: config.maxMessageBytes,
    log: logLine,
  });

  const startResult = await bridge.start();
  if (!startResult.ok) {
    issues.push(startResult.issue);
    logLine(`Setup issue (${startResult.issue.code}): ${startResult.issue.message}`);
  }

  let stdioHandle: StdioServerHandle | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    // SIGINT/SIGTERM and both stdin end-of-input events can all fire for the
    // same teardown; run the teardown once and log it once.
    if (shuttingDown) return;
    shuttingDown = true;
    logLine(`Shutting down (${reason}).`);
    await closeStdio(stdioHandle);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // When the MCP client disappears without a signal, stdin reaches EOF. Exit
  // instead of squatting the WebSocket port as an orphan process.
  process.stdin.once('end', () => void shutdown('stdio closed'));
  process.stdin.once('close', () => void shutdown('stdio closed'));

  stdioHandle = serveStdio(
    (ctx) => buildMcpServer({ bridge, config, setupIssues: issues, mode: 'direct', era: ctx.era }),
    serveStdioOptions(),
  );
  logLine('MCP server connected over stdio.');
}

async function serveBrokered(
  config: AdapterConfig,
  issues: SetupIssue[],
  resolvedConfigPath: string | null,
  argv: string[],
): Promise<void> {
  let client: BrokerClient | null = null;
  let failureCode: 'E_BROKER_UNAVAILABLE' | 'E_BROKER_VERSION_MISMATCH' = 'E_BROKER_UNAVAILABLE';
  // E_BROKER_UNAVAILABLE's default message asserts something this shim cannot
  // always know. When the broker refused us with `session_in_use` it is running
  // and healthy, so "No healthy broker could be reached or started." would be
  // false; the code is still right, because no broker is available *to us*.
  let failureMessage = 'No healthy broker could be reached or started.';
  try {
    if (resolvedConfigPath === null) {
      throw new Error('No configuration path could be resolved for the broker runtime.');
    }
    const location = await resolveBrokerLocation(resolvedConfigPath);
    client = await attachBroker(config, resolvedConfigPath, location, clientLabel(argv));
  } catch (error) {
    if (error instanceof BrokerVersionMismatchError) {
      failureCode = 'E_BROKER_VERSION_MISMATCH';
      failureMessage = 'The running broker is incompatible with this adapter version.';
    } else if (error instanceof BrokerSessionInUseError) {
      // The broker stays untouched and keeps serving its other clients; only
      // this shim is shut out, and it says so without claiming the broker died.
      failureMessage = 'The running broker refused this session id because a connected client already holds it.';
    }
  }

  if (client === null) {
    issues.push({ code: failureCode, message: failureMessage });
    logLine(`Setup issue (${failureCode}): ${failureMessage}`);
  }

  const bridge = client ?? unavailableBridge(failureCode);
  let stdioHandle: StdioServerHandle | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLine(`Shutting down (${reason}).`);
    await closeStdio(stdioHandle);
    await client?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.once('end', () => void shutdown('stdio closed'));
  process.stdin.once('close', () => void shutdown('stdio closed'));

  stdioHandle = serveStdio(
    (ctx) =>
      buildMcpServer({
        bridge,
        config,
        setupIssues: issues,
        mode: 'brokered',
        brokerStatus: client === null ? undefined : () => brokerStatus(client!),
        era: ctx.era,
      }),
    serveStdioOptions(),
  );
  logLine('MCP server connected over stdio.');
}

export async function main(): Promise<void> {
  if (process.argv[2] === '__broker') {
    await runBroker(process.argv.slice(3));
    return;
  }

  // `setup`/`doctor` at argv[2] run the guided-installation CLI and exit;
  // every other invocation (including bare startup by MCP clients) serves MCP.
  const subcommand = routeCli(process.argv[2]);
  if (subcommand !== null) {
    const { runSetupCli } = await import('../setup/run.js');
    process.exitCode = await runSetupCli(subcommand, process.argv.slice(3), fileURLToPath(import.meta.url));
    return;
  }

  const argv = process.argv.slice(2);
  const mode = resolveAdapterMode(argv, process.env, process.platform);
  const { config, issues, resolvedConfigPath } = loadAdapterSettings(argv);
  for (const issue of mode.issues) {
    issues.push(issue);
    logLine(`Setup issue (${issue.code}): ${issue.message}`);
  }
  if (mode.mode === 'direct') {
    await serveDirect(config, issues);
    return;
  }
  await serveBrokered(config, issues, resolvedConfigPath, argv);
}

main().catch((error) => {
  logLine(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
