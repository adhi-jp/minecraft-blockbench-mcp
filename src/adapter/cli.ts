#!/usr/bin/env node
// Stdio MCP adapter entry point, launched by Claude Code (or any MCP client
// that supports local stdio servers). stdout carries MCP JSON-RPC frames;
// all logging goes to stderr and never includes the shared secret.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { WsBridge } from './ws-bridge.js';
import { buildMcpServer } from './mcp-server.js';
import { resolveDefaultConfigPath } from '../shared/config-path.js';
import { routeCli } from '../setup/route.js';

function logLine(line: string): void {
  process.stderr.write(`[minecraft-blockbench-mcp] ${line}\n`);
}

export async function main(): Promise<void> {
  // `setup`/`doctor` at argv[2] run the guided-installation CLI and exit;
  // every other invocation (including bare startup by MCP clients) serves MCP.
  const subcommand = routeCli(process.argv[2]);
  if (subcommand !== null) {
    const { runSetupCli } = await import('../setup/run.js');
    process.exitCode = await runSetupCli(subcommand, process.argv.slice(3), fileURLToPath(import.meta.url));
    return;
  }

  const implicitDefaultPath = resolveDefaultConfigPath({
    platform: process.platform,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME ?? homedir(),
    appData: process.env.APPDATA,
    userProfile: process.env.USERPROFILE ?? homedir(),
  });
  const { config, issues, configSource } = loadConfig(
    process.argv.slice(2),
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

  const server = buildMcpServer({ bridge, config, setupIssues: issues });
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

main().catch((error) => {
  logLine(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
