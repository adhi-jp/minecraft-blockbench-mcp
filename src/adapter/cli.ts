#!/usr/bin/env node
// Stdio MCP adapter entry point. The WebSocket bridge, tool registration, and
// config loading are not wired up yet; this skeleton exercises the SDK surface
// the adapter depends on.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { PROTOCOL_VERSION } from '../shared/protocol.js';

export function createServerSkeleton(): { server: McpServer; transport: StdioServerTransport } {
  const server = new McpServer({
    name: 'minecraft-blockbench-mcp',
    version: '0.1.0',
  });
  const transport = new StdioServerTransport();
  return { server, transport };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');

if (invokedDirectly) {
  createServerSkeleton();
  console.error(`minecraft-blockbench-mcp adapter skeleton (protocol v${PROTOCOL_VERSION})`);
}
