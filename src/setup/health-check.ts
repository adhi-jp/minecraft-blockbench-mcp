// Spawns the adapter over stdio and reads its `health` tool to classify the
// current end-to-end state. Read-only: the transient adapter is closed after
// the check and nothing on disk is touched.
import type { Readable } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { PACKAGE_VERSION } from '../shared/protocol.js';

export type HealthStateName = 'broken' | 'port-held' | 'waiting' | 'connected';

export interface HealthState {
  state: HealthStateName;
  codes: string[];
}

interface HealthEnvelope {
  ok: boolean;
  result?: {
    plugin_connected?: boolean;
    setup_errors?: Array<{ code: string; message: string }>;
  };
}

function classify(envelope: HealthEnvelope): HealthState {
  const codes = (envelope.result?.setup_errors ?? []).map((issue) => issue.code);
  // Any setup error other than the port being occupied means the adapter
  // cannot serve the plugin — unknown future codes must not read as healthy.
  if (codes.some((code) => code !== 'E_PORT_IN_USE')) return { state: 'broken', codes };
  if (codes.includes('E_PORT_IN_USE')) return { state: 'port-held', codes };
  return { state: envelope.result?.plugin_connected === true ? 'connected' : 'waiting', codes };
}

/**
 * Runs one adapter instance and returns the classified health state. With
 * `waitMs > 0` and an initial `waiting` state, keeps the same adapter alive and
 * re-polls `health` until the plugin connects or the wait window ends, so the
 * plugin can complete its handshake against this very instance.
 */
export async function checkAdapterHealth(
  cliJsPath: string,
  configPath: string,
  options?: { waitMs?: number; pollIntervalMs?: number; timeoutMs?: number },
): Promise<HealthState> {
  const waitMs = options?.waitMs ?? 0;
  const pollIntervalMs = options?.pollIntervalMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BLOCKBENCH_MCP_SECRET;
  delete env.BLOCKBENCH_MCP_PORT;
  env.BLOCKBENCH_MCP_CONFIG = configPath;
  // Doctor probes the direct adapter path; broker-aware diagnostics are a
  // separate, not-yet-built surface and must not change doctor semantics.
  delete env.BLOCKBENCH_MCP_BROKER;
  env.BLOCKBENCH_MCP_DIRECT = '1';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliJsPath],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'minecraft-blockbench-mcp-setup', version: PACKAGE_VERSION });

  const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const readHealth = async (): Promise<HealthState> => {
    const raw = (await withTimeout(client.callTool({ name: 'health', arguments: {} }))) as {
      content?: Array<{ type: string; text: string }>;
    };
    const content = raw.content;
    if (!Array.isArray(content) || content.length === 0 || content[0].type !== 'text') {
      throw new Error('health tool did not return text content');
    }
    return classify(JSON.parse(content[0].text) as HealthEnvelope);
  };

  try {
    await withTimeout(client.connect(transport));
    // Drain the adapter's stderr: an unread pipe would eventually block the
    // child's synchronous log writes during long --wait polls.
    (transport.stderr as Readable | null)?.resume();
    let state = await readHealth();
    if (waitMs > 0 && state.state === 'waiting') {
      const deadline = Date.now() + waitMs;
      while (state.state === 'waiting' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs).unref());
        state = await readHealth();
      }
    }
    return state;
  } finally {
    await client.close().catch(() => {});
  }
}
