#!/usr/bin/env node
// Stdio MCP adapter entry point, launched by Claude Code (or any MCP client
// that supports local stdio servers). stdout carries MCP JSON-RPC frames;
// all logging goes to stderr and never includes the shared secret.
import { readFileSync } from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { WsBridge } from './ws-bridge.js';
import { buildMcpServer } from './mcp-server.js';

function logLine(line: string): void {
  process.stderr.write(`[minecraft-blockbench-mcp] ${line}\n`);
}

export async function main(): Promise<void> {
  const { config, issues } = loadConfig(process.argv.slice(2), process.env, (path) =>
    readFileSync(path, 'utf8'),
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
