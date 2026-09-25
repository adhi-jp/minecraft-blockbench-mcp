// Input programs for the frozen pre-migration wire corpus.
//
// Only `scripts/capture-premigration-baseline.mjs` reads this file. The replay
// oracle deliberately reads its inputs back out of the checked-in fixture JSON
// instead, so a later edit here cannot quietly change what is being replayed.
import type { ScenarioProgram, ScenarioStepProgram, TerminationKind } from './premigration-baseline.ts';

/** Pinned direct mode: POSIX defaults to brokered plugin connectivity. */
const DIRECT_ARGS = ['--direct'];

/** Quiet period used to prove that a step produces no stdout at all. */
const SILENCE_MS = 250;

/**
 * Every behaviour class the corpus must cover. `corpus-index.json` records
 * which file covers which class, and the replay test fails if any class loses
 * its coverage.
 */
export const REQUIRED_FIXTURE_CLASSES: readonly string[] = [
  'legacy-negotiation',
  'method-inventory',
  'tool-inventory',
  'tool-input-schemas',
  'tool-success-envelope',
  'tool-error-envelope',
  'omitted-arguments',
  'invalid-arguments',
  'unknown-method',
  'unknown-tool',
  'plugin-absent',
  'framing',
  'cancellation',
  'shutdown',
];

export const LEGACY_PROTOCOL_REVISIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

export interface ScenarioDefinition {
  name: string;
  proves: string;
  covers: string[];
  program: ScenarioProgram;
}

function initializeRequest(id: number, protocolVersion: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'premigration-wire-recorder', version: '1.0.0' },
    },
  };
}

/**
 * `proveSilence` adds a quiet period after the notification. It is only needed
 * when nothing else follows in the session: when a later request is sent, the
 * message count checked at that step already proves the notification produced
 * no stdout, and the extra wait would only make the suite slower.
 */
function initializedNotification(proveSilence: boolean): ScenarioStepProgram {
  const step: ScenarioStepProgram = {
    label: 'notifications/initialized carries no response',
    send: { jsonrpc: '2.0', method: 'notifications/initialized' },
    awaitStdoutMessages: 0,
  };
  if (proveSilence) step.settleMs = SILENCE_MS;
  return step;
}

function openingSteps(protocolVersion: string, proveSilence = false): ScenarioStepProgram[] {
  return [
    {
      label: `initialize with protocolVersion ${protocolVersion}`,
      send: initializeRequest(1, protocolVersion),
      awaitStdoutMessages: 1,
    },
    initializedNotification(proveSilence),
  ];
}

function toolCall(id: number, name: string, args?: unknown): unknown {
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params.arguments = args;
  return { jsonrpc: '2.0', id, method: 'tools/call', params };
}

function scenario(
  name: string,
  proves: string,
  covers: string[],
  steps: ScenarioStepProgram[],
  termination: TerminationKind = 'stdin-eof',
): ScenarioDefinition {
  return { name, proves, covers, program: { args: DIRECT_ARGS.slice(), steps, termination } };
}

/**
 * Standard MCP methods probed to record which ones this server answers and
 * which ones the dependency reports as absent. The absent ones are the
 * evidence that no prompt, resource, completion, or logging capability is
 * being advertised or served.
 */
const PROBED_METHODS: Array<{ method: string; params?: unknown }> = [
  { method: 'ping', params: {} },
  { method: 'tools/list', params: {} },
  { method: 'prompts/list', params: {} },
  { method: 'prompts/get', params: { name: 'anything' } },
  { method: 'resources/list', params: {} },
  { method: 'resources/templates/list', params: {} },
  { method: 'resources/read', params: { uri: 'file:///anything' } },
  { method: 'resources/subscribe', params: { uri: 'file:///anything' } },
  { method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'anything' }, argument: { name: 'a', value: '' } } },
  { method: 'logging/setLevel', params: { level: 'debug' } },
  { method: 'roots/list', params: {} },
  { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } },
  { method: 'elicitation/create', params: { message: 'anything', requestedSchema: { type: 'object' } } },
  { method: 'tasks/list', params: {} },
];

export function scenarioDefinitions(): ScenarioDefinition[] {
  const definitions: ScenarioDefinition[] = [];

  for (const revision of LEGACY_PROTOCOL_REVISIONS) {
    definitions.push(
      scenario(
        `initialize-${revision}`,
        `An opening initialize naming MCP revision ${revision} is accepted, echoes that same revision back, ` +
          'and advertises the server capability object and server identity recorded here.',
        ['legacy-negotiation'],
        openingSteps(revision, true),
      ),
    );
  }

  definitions.push(
    scenario(
      'initialize-unsupported-version',
      'An opening initialize naming a protocol revision the server does not support is answered with a ' +
        'successful result carrying the latest supported revision instead of a JSON-RPC error.',
      ['legacy-negotiation'],
      [
        {
          label: 'initialize with an unsupported protocolVersion',
          send: initializeRequest(1, '1999-01-01'),
          awaitStdoutMessages: 1,
        },
        initializedNotification(true),
      ],
    ),
    scenario(
      'initialize-missing-params',
      'An initialize request with no params object is answered with a JSON-RPC error, and the connection ' +
        'stays usable afterwards.',
      ['legacy-negotiation', 'invalid-arguments'],
      [
        {
          label: 'initialize without params',
          send: { jsonrpc: '2.0', id: 1, method: 'initialize' },
          awaitStdoutMessages: 1,
        },
        {
          label: 'the connection still answers a following request',
          send: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
          awaitStdoutMessages: 1,
        },
      ],
    ),
    scenario(
      'tools-list-inventory',
      'tools/list returns the complete advertised tool inventory: names, order, descriptions, every input ' +
        'schema, and the per-tool execution metadata the recorded build emits.',
      ['tool-inventory', 'tool-input-schemas'],
      [...openingSteps('2025-11-25'), { label: 'tools/list', send: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, awaitStdoutMessages: 1 }],
    ),
    scenario(
      'tools-list-before-initialize',
      'tools/list is answered on a connection that never sent initialize, which records that the recorded ' +
        'build does not gate tool discovery behind the initialize lifecycle.',
      ['tool-inventory', 'method-inventory'],
      [{ label: 'tools/list as the very first request', send: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, awaitStdoutMessages: 1 }],
    ),
    scenario(
      'method-inventory',
      'Records which standard MCP methods this server answers and which the dependency reports as absent, ' +
        'so an added or removed method surface is visible.',
      ['method-inventory'],
      [
        ...openingSteps('2025-11-25'),
        ...PROBED_METHODS.map((probe, index) => ({
          label: `method ${probe.method}`,
          send: { jsonrpc: '2.0', id: index + 2, method: probe.method, params: probe.params },
          awaitStdoutMessages: 1,
        })),
      ],
    ),
    scenario(
      'tool-call-health-success',
      'A health tool call returns a successful text envelope with no isError flag: the pretty-printed JSON ' +
        'envelope, its summary sentence, and the adapter/protocol/port/setup fields it reports.',
      ['tool-success-envelope', 'plugin-absent'],
      [...openingSteps('2025-11-25'), { label: 'tools/call health', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 }],
    ),
    scenario(
      'tool-arguments-omitted',
      'Omitting the tools/call arguments member entirely is rejected by the dependency validation layer for ' +
        'both a no-parameter tool and a tool with required parameters, and surfaces as an isError text result ' +
        'rather than a JSON-RPC error.',
      ['omitted-arguments'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'tools/call health with no arguments member', send: toolCall(2, 'health'), awaitStdoutMessages: 1 },
        { label: 'tools/call read_file with no arguments member', send: toolCall(3, 'read_file'), awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'tool-arguments-invalid-dependency-layer',
      'Arguments that fail the advertised input schema are rejected before the handler runs: a wrong value ' +
        'type and an unrecognized extra key both return the dependency validation text with isError true.',
      ['invalid-arguments'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'wrong value type for read_file.path', send: toolCall(2, 'read_file', { path: 123 }), awaitStdoutMessages: 1 },
        { label: 'unrecognized extra key for read_file', send: toolCall(3, 'read_file', { path: 'model.json', bogus: 1 }), awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'tool-arguments-invalid-handler-layer',
      'Two tools whose shared schema carries a top-level refinement advertise the unwrapped inner object, so ' +
        'arguments that satisfy the advertised schema still reach the handler and are rejected there with an ' +
        'E_INVALID_PARAMS envelope. This is the dual-layer validation contract.',
      ['invalid-arguments', 'tool-error-envelope'],
      [
        ...openingSteps('2025-11-25'),
        {
          label: 'validate_geckolib_file with neither optional path, accepted by the advertised schema',
          send: toolCall(2, 'validate_geckolib_file', {}),
          awaitStdoutMessages: 1,
        },
        {
          label: 'set_cube_uv with only uuid, accepted by the advertised schema',
          send: toolCall(3, 'set_cube_uv', { uuid: 'cube-uuid' }),
          awaitStdoutMessages: 1,
        },
      ],
    ),
    scenario(
      'unknown-method-and-unknown-tool',
      'An unknown JSON-RPC method returns error -32601 while an unknown tool name returns a successful ' +
        'response carrying an isError text result. The two failure shapes are different and both are frozen.',
      ['unknown-method', 'unknown-tool'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'unknown JSON-RPC method', send: { jsonrpc: '2.0', id: 2, method: 'blockbench/not-a-method', params: {} }, awaitStdoutMessages: 1 },
        { label: 'unknown tool name', send: toolCall(3, 'not_a_registered_tool', {}), awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'plugin-absent-health-and-relay',
      'With Blockbench not running, health still succeeds and reports the setup state, while a relayed ' +
        'command fails with an E_PLUGIN_NOT_CONNECTED envelope and isError true. Discovery and status stay ' +
        'usable without the plugin.',
      ['plugin-absent', 'tool-error-envelope'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'health without Blockbench', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 },
        { label: 'relayed get_plugin_status without Blockbench', send: toolCall(3, 'get_plugin_status', {}), awaitStdoutMessages: 1 },
        { label: 'relayed read_file without Blockbench', send: toolCall(4, 'read_file', { path: 'model.json' }), awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'malformed-and-unframed-input',
      'A line that is not JSON, a JSON-RPC batch array, and a frame missing the jsonrpc member are each ' +
        'dropped without any stdout output, and the connection keeps answering afterwards.',
      ['framing', 'unknown-method'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'a line that is not JSON', sendRawLine: '{not json', awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        {
          label: 'a JSON-RPC batch array',
          send: [
            { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
            { jsonrpc: '2.0', id: 3, method: 'ping', params: {} },
          ],
          awaitStdoutMessages: 0,
          settleMs: SILENCE_MS,
        },
        { label: 'a frame missing the jsonrpc member', send: { id: 4, method: 'ping', params: {} }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'an empty line', sendRawLine: '', awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'the connection still answers a following request', send: { jsonrpc: '2.0', id: 5, method: 'ping', params: {} }, awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'stdout-framing',
      'A mixed session of results, an error response, an isError tool result, and notifications produces ' +
        'exactly one newline-delimited JSON-RPC object per stdout line, while every adapter log line goes to ' +
        'stderr. The recorded stderr lines are the positive control that logging happens and is not on stdout.',
      ['framing'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'ping', send: { jsonrpc: '2.0', id: 2, method: 'ping', params: {} }, awaitStdoutMessages: 1 },
        { label: 'unknown method error response', send: { jsonrpc: '2.0', id: 3, method: 'blockbench/not-a-method', params: {} }, awaitStdoutMessages: 1 },
        { label: 'successful health tool result', send: toolCall(4, 'health', {}), awaitStdoutMessages: 1 },
        { label: 'isError tool result', send: toolCall(5, 'get_plugin_status', {}), awaitStdoutMessages: 1 },
        { label: 'a client notification produces no stdout', send: { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 1 } }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
      ],
    ),
    scenario(
      'cancellation-notifications',
      'notifications/cancelled for request ids 0, the empty string, a nonzero number, and a nonempty string ' +
        'each produce no stdout and no error, and the connection keeps serving requests afterwards.',
      ['cancellation'],
      [
        ...openingSteps('2025-11-25'),
        { label: 'cancel request id 0', send: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0, reason: 'recorded baseline' } }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'cancel request id ""', send: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '', reason: 'recorded baseline' } }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'cancel request id 1', send: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'recorded baseline' } }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'cancel request id "never-issued"', send: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'never-issued', reason: 'recorded baseline' } }, awaitStdoutMessages: 0, settleMs: SILENCE_MS },
        { label: 'the connection still answers a following request', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 },
      ],
    ),
    scenario(
      'shutdown-stdin-eof',
      'Closing stdin ends the adapter process with exit code 0 and produces no further stdout.',
      ['shutdown'],
      [...openingSteps('2025-11-25'), { label: 'health before shutdown', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 }],
      'stdin-eof',
    ),
    scenario(
      'shutdown-sigterm',
      'SIGTERM ends the adapter process with exit code 0 and produces no further stdout.',
      ['shutdown'],
      [...openingSteps('2025-11-25'), { label: 'health before shutdown', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 }],
      'sigterm',
    ),
    scenario(
      'shutdown-sigint',
      'SIGINT ends the adapter process with exit code 0 and produces no further stdout.',
      ['shutdown'],
      [...openingSteps('2025-11-25'), { label: 'health before shutdown', send: toolCall(2, 'health', {}), awaitStdoutMessages: 1 }],
      'sigint',
    ),
  );

  return definitions;
}
