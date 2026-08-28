// MCP server assembly: registers the health tool plus one tool per protocol
// command. The adapter is an AI-client compatibility shim only — every
// Blockbench operation is relayed to the plugin, which executes or rejects it.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  COMMAND_SPECS,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  makeError,
  type CommandName,
  type CommandSpec,
  type ErrorPayload,
} from '../shared/protocol.js';
import type { AdapterConfig, SetupIssue } from './config.js';
import { isRequestCancelled } from './request-cancellation.js';
import type { BridgeRequestResult, PluginInfo } from './ws-bridge.js';

export const ADAPTER_VERSION = PACKAGE_VERSION;

export interface PluginBridge {
  connected: boolean;
  listening: boolean;
  pluginInfo: PluginInfo | null;
  /**
   * Relay one command to Blockbench.
   *
   * `signal` is the per-request abort signal `@modelcontextprotocol/server`
   * hands a tool handler as `ctx.mcpReq.signal`; it fires when the client sends
   * `notifications/cancelled` for that request. An implementation that honours
   * it must reject with a `RequestCancelledError` rather than resolve, so a
   * withdrawn request can never produce an envelope. Nothing already relayed to
   * the plugin is rolled back or replayed.
   */
  request(
    command: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BridgeRequestResult>;
}

export interface BrokerStatus {
  broker_connected: boolean;
  controller_state: 'idle' | 'owned' | 'releasing' | 'recovering' | null;
  controller_owner: string | null;
  client_count: number | null;
  effective_port: number | null;
}

interface Envelope {
  summary: string;
  ok: boolean;
  command?: string;
  result?: unknown;
  error?: ErrorPayload;
}

function toToolResult(envelope: Envelope): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    ...(envelope.ok ? {} : { isError: true }),
  };
}

/**
 * The wire era the constructed instance will serve, matching the `era` member
 * of the construction context `serveStdio` hands to a server factory:
 * `'legacy'` for a connection that opened with the 2025-era `initialize`
 * handshake, `'modern'` for 2026-07-28 traffic.
 */
export type McpWireEra = 'legacy' | 'modern';

/**
 * The error a withdrawn tool call ends on. Deliberately plain and
 * identifier-free: it exists to stop the handler, not to be read by a client.
 */
function cancelledByClient(command: string): Error {
  return new Error(`${command} was cancelled by the client.`);
}

/**
 * The input schema advertised in `tools/list`, derived from the shared command
 * schema.
 *
 * Two commands (`set_cube_uv` and `validate_geckolib_file`) carry a top-level
 * `.refine()`/`.superRefine()` check that no single field can express. Under
 * zod 4 a refinement no longer wraps its object in a separate node — it is
 * added to the very same `ZodObject` — so advertising the shared schema
 * directly would let `@modelcontextprotocol/server` enforce the refinement
 * before dispatch and answer with the dependency's plain validation text.
 * Rebuilding a plain strict object from `.shape` drops the refinement from the
 * advertised schema only; the handler below still re-validates against the
 * shared refined schema and answers with the `E_INVALID_PARAMS` envelope that
 * carries the failing issues. Both validation layers therefore stay observable
 * exactly as they were.
 */
function advertisedInputSchema(params: z.ZodType): z.ZodType {
  return params instanceof z.ZodObject ? z.object(params.shape).strict() : params;
}

const ADVERTISED_INPUT_SCHEMAS = new Map<CommandName, z.ZodType>(
  (Object.entries(COMMAND_SPECS) as Array<[CommandName, CommandSpec]>).map(([name, spec]) => [
    name,
    advertisedInputSchema(spec.params),
  ]),
);

/**
 * Builds one fully registered MCP server instance. `serveStdio` calls its
 * factory more than once per connection — a discarded `server/discover` probe
 * plus the instance pinned for the connection — so every call must produce a
 * server that shares no mutable state with any other. The bridge, config, and
 * setup-issue list are deliberately borrowed rather than copied: they are the
 * process-wide plugin connectivity and setup state, not per-connection state.
 */
export function buildMcpServer(options: {
  bridge: PluginBridge;
  config: AdapterConfig;
  setupIssues: SetupIssue[];
  mode: 'direct' | 'brokered';
  brokerStatus?: () => BrokerStatus | null;
  era?: McpWireEra;
}): McpServer {
  const { bridge, config, setupIssues, mode, brokerStatus } = options;
  const era: McpWireEra = options.era ?? 'legacy';

  const server = new McpServer(
    {
      name: 'minecraft-blockbench-mcp',
      version: ADAPTER_VERSION,
    },
    {
      // The tool catalog is static and never changes while the process runs.
      // A 2026-07-28 connection advertises that honestly with
      // `listChanged: false`; a 2025-era connection keeps advertising
      // `{ tools: { listChanged: true } }`, which is the capability shape every
      // supported legacy revision has always been answered with.
      capabilities: { tools: { listChanged: era === 'legacy' } },
    },
  );

  server.registerTool(
    'health',
    {
      description:
        'Report adapter status: WebSocket listener state, plugin connection, plugin versions/capabilities, scoped-directory status, and machine-readable setup errors. Read-only; works while Blockbench is closed.',
      // Strict so the enforced schema matches the `additionalProperties: false`
      // that `tools/list` has always advertised for this no-argument tool.
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const connected = bridge.connected;
      const broker = mode === 'brokered' ? brokerStatus?.() ?? null : null;
      const envelope: Envelope = {
        summary: connected
          ? 'Adapter is running and the Blockbench plugin is connected.'
          : 'Adapter is running; the Blockbench plugin is not connected.',
        ok: true,
        result: {
          adapter_version: ADAPTER_VERSION,
          protocol_version: PROTOCOL_VERSION,
          port: mode === 'brokered' ? broker?.effective_port ?? config.port : config.port,
          ws_listening: bridge.listening,
          plugin_connected: connected,
          setup_errors: setupIssues,
          plugin: bridge.pluginInfo,
          mode,
          broker_connected: broker?.broker_connected ?? false,
          controller_state: broker?.controller_state ?? null,
          controller_owner: broker?.controller_owner ?? null,
          client_count: broker?.client_count ?? null,
        },
      };
      return toToolResult(envelope);
    },
  );

  for (const [name, spec] of Object.entries(COMMAND_SPECS) as Array<[CommandName, CommandSpec]>) {
    const command = name;
    const advertisedSchema = ADVERTISED_INPUT_SCHEMAS.get(command) ?? spec.params;
    server.registerTool(
      command,
      {
        description: spec.description,
        inputSchema: advertisedSchema,
      },
      async (args: unknown, ctx) => {
        // `notifications/cancelled` for this request fires this signal. It is
        // read once, here, and carried all the way to the bridge so a
        // withdrawal reaches the direct WebSocket relay and the broker queue
        // rather than stopping at the MCP layer.
        //
        // Known dependency limitation, upstream-owned and unchanged by this
        // adapter: `@modelcontextprotocol/server@2.0.0` discards a
        // `notifications/cancelled` whose `requestId` is falsy -- `0`, `""`, or
        // `-0` -- because it tests the id for truthiness rather than presence.
        // This signal therefore simply never fires for a request carrying one of
        // those ids, and such a request runs to completion. See the falsy-id
        // matrix in tests/mcp-cancellation-wire.test.ts.
        const signal: AbortSignal = ctx.mcpReq.signal;
        // Withdrawn before this handler even ran: relay nothing.
        if (signal.aborted) throw cancelledByClient(command);
        // Re-validate with the strict shared schema so extra fields and shape
        // drift are rejected here, before anything is relayed to the plugin.
        const parsed = spec.params.safeParse(args ?? {});
        if (!parsed.success) {
          return toToolResult({
            summary: `Rejected ${command}: parameters failed validation.`,
            ok: false,
            command,
            error: makeError('E_INVALID_PARAMS', 'Parameters failed schema validation.', parsed.error.issues),
          });
        }
        // Only direct mode may short-circuit on the connection flag: a broker
        // shim must forward even while disconnected so its request path can
        // re-elect or restart a broker on demand.
        if (mode === 'direct' && !bridge.connected) {
          return toToolResult({
            summary: `Cannot run ${command}: the Blockbench plugin is not connected.`,
            ok: false,
            command,
            error: makeError(
              'E_PLUGIN_NOT_CONNECTED',
              'Blockbench or its MCP plugin is not running or not connected. Start Blockbench, load the plugin, and match its port/secret settings.',
              setupIssues.length > 0 ? { setup_errors: setupIssues } : undefined,
            ),
          });
        }
        let outcome: BridgeRequestResult;
        try {
          outcome = await bridge.request(command, parsed.data, spec.timeoutMs, signal);
        } catch (error) {
          if (!isRequestCancelled(error)) throw error;
          // The client withdrew this request, so there is no outcome to report
          // and none is invented. Throwing rather than returning an envelope is
          // what keeps the wire silent: `@modelcontextprotocol/server` drops
          // both the result and the error of a request whose abort signal has
          // fired. The replacement carries no internal request identity, so
          // nothing correlating adapter state could reach a client even if a
          // future dependency release stopped suppressing it. No rollback is
          // claimed and nothing is replayed.
          throw cancelledByClient(command);
        }
        if (outcome.ok) {
          const result = spec.result.safeParse(outcome.result);
          if (!result.success) {
            return toToolResult({
              summary: `${command} failed: E_PROTOCOL_MISMATCH.`,
              ok: false,
              command,
              error: makeError(
                'E_PROTOCOL_MISMATCH',
                `${command} plugin result did not match the protocol result schema.`,
                result.error.issues,
              ),
            });
          }
          return toToolResult({
            summary: `${command} succeeded.`,
            ok: true,
            command,
            result: outcome.result,
          });
        }
        const error = outcome.error ?? makeError('E_BLOCKBENCH_ERROR', 'The plugin returned an unspecified error.');
        return toToolResult({
          summary: `${command} failed: ${error.code}.`,
          ok: false,
          command,
          error,
        });
      },
    );
  }

  return server;
}
