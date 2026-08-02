import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { CONFIG_DEFAULTS, type AdapterConfig } from '../src/adapter/config.js';
import { ADAPTER_VERSION, buildMcpServer, type BrokerStatus, type PluginBridge } from '../src/adapter/mcp-server.js';
import { PROTOCOL_VERSION, type ErrorPayload } from '../src/shared/protocol.js';

interface Envelope {
  summary: string;
  ok: boolean;
  command?: string;
  result?: Record<string, unknown>;
  error?: ErrorPayload;
}

function adapterConfig(port = 42_001): AdapterConfig {
  return { ...CONFIG_DEFAULTS, port };
}

function bridge(overrides: Partial<PluginBridge> = {}): PluginBridge {
  return {
    connected: false,
    listening: false,
    pluginInfo: null,
    request: async () => ({ ok: true, result: { open: false } }),
    ...overrides,
  };
}

async function callTool(
  options: Parameters<typeof buildMcpServer>[0],
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope> {
  const server = buildMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-server-health-test', version: '0.0.0' });
  try {
    await client.connect(clientTransport);
    const response = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    return JSON.parse(response.content[0].text) as Envelope;
  } finally {
    await client.close();
  }
}

test('direct health preserves adapter fields and reports empty broker state', async () => {
  const plugin = {
    plugin_version: '0.1.0',
    blockbench_version: '5.1.4',
    capabilities: ['java_block'],
    scope: null,
  };
  const health = await callTool(
    {
      bridge: bridge({ connected: true, listening: true, pluginInfo: plugin }),
      config: adapterConfig(),
      setupIssues: [],
      mode: 'direct',
    },
    'health',
  );

  assert.deepEqual(health.result, {
    adapter_version: ADAPTER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    port: 42_001,
    ws_listening: true,
    plugin_connected: true,
    setup_errors: [],
    plugin,
    mode: 'direct',
    broker_connected: false,
    controller_state: null,
    controller_owner: null,
    client_count: null,
  });
});

test('brokered health uses the broker status and effective port', async () => {
  const status: BrokerStatus = {
    broker_connected: true,
    controller_state: 'owned',
    controller_owner: 'codex',
    client_count: 3,
    effective_port: 42_002,
  };
  const health = await callTool(
    {
      bridge: bridge({ connected: true, listening: true }),
      config: adapterConfig(42_001),
      setupIssues: [],
      mode: 'brokered',
      brokerStatus: () => status,
    },
    'health',
  );

  assert.equal(health.result?.mode, 'brokered');
  assert.equal(health.result?.port, 42_002);
  assert.equal(health.result?.broker_connected, true);
  assert.equal(health.result?.controller_state, 'owned');
  assert.equal(health.result?.controller_owner, 'codex');
  assert.equal(health.result?.client_count, 3);
});

test('brokered health degrades cleanly when the broker status is unavailable', async () => {
  const health = await callTool(
    {
      bridge: bridge(),
      config: adapterConfig(42_003),
      setupIssues: [],
      mode: 'brokered',
      brokerStatus: () => null,
    },
    'health',
  );

  assert.equal(health.result?.port, 42_003);
  assert.equal(health.result?.broker_connected, false);
  assert.equal(health.result?.controller_state, null);
  assert.equal(health.result?.controller_owner, null);
  assert.equal(health.result?.client_count, null);
});

test('operation tools gate on bridge connection and preserve bridge error payloads', async () => {
  let disconnectedRequests = 0;
  const disconnected = await callTool(
    {
      bridge: bridge({
        request: async () => {
          disconnectedRequests += 1;
          return { ok: false, error: { code: 'E_BROKER_UNAVAILABLE', message: 'not reached' } };
        },
      }),
      config: adapterConfig(),
      setupIssues: [],
      mode: 'direct',
    },
    'get_project_state',
  );
  assert.equal(disconnected.error?.code, 'E_PLUGIN_NOT_CONNECTED');
  assert.equal(disconnectedRequests, 0);

  const error: ErrorPayload = {
    code: 'E_SCOPE_NOT_CONFIRMED',
    message: 'The plugin denied this operation.',
    details: { path: 'model.json' },
  };
  const relayed = await callTool(
    {
      bridge: bridge({ connected: true, request: async () => ({ ok: false, error }) }),
      config: adapterConfig(),
      setupIssues: [],
      mode: 'brokered',
      brokerStatus: () => null,
    },
    'get_project_state',
  );
  assert.deepEqual(relayed.error, error);
});
