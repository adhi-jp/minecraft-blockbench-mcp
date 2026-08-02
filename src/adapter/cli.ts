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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { makeError } from '../shared/protocol.js';
import { resolveDefaultConfigPath } from '../shared/config-path.js';
import { routeCli } from '../setup/route.js';
import { BrokerClient, BrokerHandshakeError, type BrokerClientHello } from './broker/broker-client.js';
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
      // This callback runs while holding the startup lock and only after the
      // endpoint probe failed, so a leftover socket file from a dead broker is
      // provably stale and must be removed or the new broker cannot bind.
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
      return null;
    }
  }

  return electBroker();
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

  const server = buildMcpServer({ bridge, config, setupIssues: issues, mode: 'direct' });
  const transport = new StdioServerTransport();

  const shutdown = async (reason: string) => {
    logLine(`Shutting down (${reason}).`);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // When the MCP client disappears without a signal, stdin reaches EOF. Exit
  // instead of squatting the WebSocket port as an orphan process.
  process.stdin.once('end', () => void shutdown('stdio closed'));
  process.stdin.once('close', () => void shutdown('stdio closed'));

  await server.connect(transport);
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
  try {
    if (resolvedConfigPath === null) {
      throw new Error('No configuration path could be resolved for the broker runtime.');
    }
    const location = await resolveBrokerLocation(resolvedConfigPath);
    client = await attachBroker(config, resolvedConfigPath, location, clientLabel(argv));
  } catch (error) {
    if (error instanceof BrokerVersionMismatchError) failureCode = 'E_BROKER_VERSION_MISMATCH';
  }

  if (client === null) {
    issues.push({
      code: failureCode,
      message:
        failureCode === 'E_BROKER_VERSION_MISMATCH'
          ? 'The running broker is incompatible with this adapter version.'
          : 'No healthy broker could be reached or started.',
    });
    logLine(`Setup issue (${failureCode}): ${issues.at(-1)!.message}`);
  }

  const bridge = client ?? unavailableBridge(failureCode);
  const server = buildMcpServer({
    bridge,
    config,
    setupIssues: issues,
    mode: 'brokered',
    brokerStatus: client === null ? undefined : () => brokerStatus(client!),
  });
  const transport = new StdioServerTransport();

  const shutdown = async (reason: string) => {
    logLine(`Shutting down (${reason}).`);
    await client?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.once('end', () => void shutdown('stdio closed'));
  process.stdin.once('close', () => void shutdown('stdio closed'));

  await server.connect(transport);
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
