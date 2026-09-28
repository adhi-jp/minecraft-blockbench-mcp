// Reviewed ledger of the wire differences that MCP `2026-07-28` support is
// allowed to introduce against the frozen pre-migration corpus.
//
// `tests/fixtures/premigration/` records what the executable put on the wire
// before the dependency change, and it is immutable evidence: nothing in this
// repository may edit, regenerate, or weaken it. Some of what it records is no
// longer what a conforming server emits. This file is the only place where
// such a difference may be declared, and every declaration is narrow: it names
// the recorded location, the recorded value, the value that must appear now,
// and the authority for the change.
//
// The parity oracle in `tests/premigration-wire-baseline.test.ts` rewrites the
// frozen expectation through this ledger and then compares. It does not skip
// or relax anything: a ledger entry states the exact post-migration value, so
// a difference the ledger does not describe still fails, and a difference that
// does not match what the ledger says must appear still fails.
//
// The tool catalogue a recorded `tools/list` response carries is not compared
// with the current build at all, so no entry here describes it: adding a tool
// or changing a description or input schema needs no entry.
//
// Two controls in `tests/premigration-wire-baseline.test.ts` guard this file
// against drift. Both drive the ledger over the frozen corpus files directly —
// no replay, no child process — so what they see is which entries still match
// something the recording contains:
//   - every entry must match at least one recorded location, so an entry whose
//     recorded shape has disappeared from the corpus is reported instead of
//     sitting here unread; and
//   - every entry must match exactly the recorded locations it declares, so an
//     entry cannot quietly start covering a new location or lose one.
//
// Being ledger-drift guards, they are not what proves an entry is still needed
// against the current build. That job belongs to the parity assertions in the
// same file: those replay the frozen inputs against `dist/adapter/cli.js` and
// compare with the rewritten expectation, so an entry that declares a change
// the build no longer makes fails there, on the scenario it names. Read the two
// together — the controls say the ledger still describes the corpus, the parity
// assertions say the build still matches the ledger.
//
// Almost every entry is exercised by rewriting a recorded location. One is not:
// a difference in what the server ENFORCES, at a location the corpus never
// recorded a rejection for, changes no recorded byte and so cannot be reached
// by a rewrite. Such an entry declares a live-probe location instead, and the
// same controls hold it to that location: the probe in
// `tests/premigration-wire-baseline.test.ts` sends the call, asserts the
// behaviour the entry says must be observed now, and only then records the
// entry as exercised. An entry of this kind is therefore backed by a live
// observation rather than by prose, and it fails the moment the behaviour it
// declares stops happening.
//
// `authority` separates two kinds of entry:
//   - `adjudicated-in-plan`: the migration plan's `Ambiguities, questions, and
//     decisions` section lists this deviation with target-specification
//     authority, checked against the published `2026-07-28` and `2025-06-18`
//     tool specifications.
//   - `escalated-for-adjudication`: measured while building this matrix and NOT
//     on that list. Each one is recorded here with its evidence and with the
//     measured effect on runtime validation, and each is reported for review.
//     `ESCALATED_DEVIATION_IDS` pins this set so it cannot grow unnoticed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DeviationAuthority = 'adjudicated-in-plan' | 'escalated-for-adjudication';

export interface AcceptedDeviation {
  /** Stable identifier, also the key the appliers use when recording a use. */
  readonly id: string;
  readonly authority: DeviationAuthority;
  /** Which recorded observations this entry may touch. */
  readonly appliesTo: string;
  /** The value or shape the frozen corpus records. */
  readonly was: string;
  /** The value or shape that must be observed now. */
  readonly now: string;
  /** One line naming the authority for the change. */
  readonly reason: string;
  /**
   * Every location this entry must rewrite, and the only ones it may rewrite.
   * Scenario entries use `<scenario> :: <step label> :: message <index>`.
   * An entry that changes
   * enforcement at a location the corpus never recorded uses the live-probe
   * form `live probe :: <what is sent> :: message <index>`, and the probe that
   * observes it is what records the entry as exercised there.
   */
  readonly expectedSites: readonly string[];
}

/** Records which ledger entry rewrote which recorded location. */
export class DeviationUsage {
  private readonly used = new Map<string, Set<string>>();

  note(id: string, site: string): void {
    let sites = this.used.get(id);
    if (sites === undefined) {
      sites = new Set<string>();
      this.used.set(id, sites);
    }
    sites.add(site);
  }

  sitesFor(id: string): string[] {
    return [...(this.used.get(id) ?? [])].sort();
  }

  usedIds(): string[] {
    return [...this.used.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// Values shared by several entries
// ---------------------------------------------------------------------------

const RECORDED_ERROR_TEXT_PREFIX = 'MCP error -32602: ';
const UNKNOWN_TOOL_TEXT = /^MCP error -32602: (Tool .+ not found)$/;
const INVALID_ARGUMENTS_TEXT = /^MCP error -32602: (Input validation error: Invalid arguments for tool ([A-Za-z_]+): )\[/;

const MEMBER_ORDER_ID = 'advertised-schema-member-order-changed';
const UNKNOWN_TOOL_ID = 'unknown-tool-returns-jsonrpc-invalid-params';
const VALIDATION_TEXT_ID = 'dependency-layer-validation-text-restated-by-zod-4';
const OMITTED_ARGUMENTS_ID = 'no-parameter-tool-accepts-omitted-arguments-member';
const ISSUE_ORDER_ID = 'refined-tool-issue-member-order';
/** Exported so the live probe records usage under the entry's own identifier. */
export const HEALTH_STRICT_ID = 'no-parameter-tool-health-now-rejects-unrecognized-arguments';
const PACKAGE_VERSION_ID = 'reported-package-version-is-0-3-0';
const RECORDED_PACKAGE_VERSION = '0.1.0';
const PACKAGE_VERSION_NOW = '0.3.0';

/**
 * Every recorded location that reports the package version: the `initialize`
 * response's `serverInfo.version`, once per scenario, and the `health` tool
 * result's `adapter_version`, in every scenario that calls `health`.
 */
const PACKAGE_VERSION_SITES: readonly string[] = [
  'cancellation-notifications :: initialize with protocolVersion 2025-11-25 :: message 0',
  'cancellation-notifications :: the connection still answers a following request :: message 0',
  'initialize-2024-10-07 :: initialize with protocolVersion 2024-10-07 :: message 0',
  'initialize-2024-11-05 :: initialize with protocolVersion 2024-11-05 :: message 0',
  'initialize-2025-03-26 :: initialize with protocolVersion 2025-03-26 :: message 0',
  'initialize-2025-06-18 :: initialize with protocolVersion 2025-06-18 :: message 0',
  'initialize-2025-11-25 :: initialize with protocolVersion 2025-11-25 :: message 0',
  'initialize-unsupported-version :: initialize with an unsupported protocolVersion :: message 0',
  'malformed-and-unframed-input :: initialize with protocolVersion 2025-11-25 :: message 0',
  'method-inventory :: initialize with protocolVersion 2025-11-25 :: message 0',
  'plugin-absent-health-and-relay :: initialize with protocolVersion 2025-11-25 :: message 0',
  'plugin-absent-health-and-relay :: health without Blockbench :: message 0',
  'shutdown-sigint :: initialize with protocolVersion 2025-11-25 :: message 0',
  'shutdown-sigint :: health before shutdown :: message 0',
  'shutdown-sigterm :: initialize with protocolVersion 2025-11-25 :: message 0',
  'shutdown-sigterm :: health before shutdown :: message 0',
  'shutdown-stdin-eof :: initialize with protocolVersion 2025-11-25 :: message 0',
  'shutdown-stdin-eof :: health before shutdown :: message 0',
  'stdout-framing :: initialize with protocolVersion 2025-11-25 :: message 0',
  'stdout-framing :: successful health tool result :: message 0',
  'tool-arguments-invalid-dependency-layer :: initialize with protocolVersion 2025-11-25 :: message 0',
  'tool-arguments-invalid-handler-layer :: initialize with protocolVersion 2025-11-25 :: message 0',
  'tool-arguments-omitted :: initialize with protocolVersion 2025-11-25 :: message 0',
  'tool-arguments-omitted :: tools/call health with no arguments member :: message 0',
  'tool-call-health-success :: initialize with protocolVersion 2025-11-25 :: message 0',
  'tool-call-health-success :: tools/call health :: message 0',
  'tools-list-inventory :: initialize with protocolVersion 2025-11-25 :: message 0',
  'unknown-method-and-unknown-tool :: initialize with protocolVersion 2025-11-25 :: message 0',
];

/**
 * The one location the `health` strictness entry is exercised at.
 *
 * The frozen corpus never sent `health` an unrecognized argument key, so there
 * is no recorded message to rewrite and no recorded rejection to compare
 * against; the difference is in what the server enforces, not in any byte it
 * recorded. The live probe in `tests/premigration-wire-baseline.test.ts` sends
 * exactly this call against the current build and records the entry as
 * exercised here only if the rejection the entry declares is what came back.
 */
export const HEALTH_STRICT_ARGUMENTS_PROBE_SITE =
  'live probe :: tools/call health with an unrecognized argument key :: message 0';

/** The rejection text the live probe must observe for the `health` entry. */
export const HEALTH_STRICT_ARGUMENTS_REJECTION_TEXT =
  'Input validation error: Invalid arguments for tool health: Unrecognized key: "foo"';

/** The argument key the live probe sends, which the entry says is now refused. */
export const HEALTH_STRICT_ARGUMENTS_PROBE_KEY = 'foo';

/**
 * The exact replacement text for each recorded dependency-layer rejection.
 *
 * The invariant part of the message is asserted structurally by the applier:
 * the `Input validation error: Invalid arguments for tool <name>: ` prefix must
 * still be produced with the same tool name, and only the trailing issue
 * summary is replaced. The `MCP error -32602: ` prefix the recorded build put
 * in front of it is gone because the dependency no longer round-trips its own
 * protocol error through a text result.
 */
const VALIDATION_TEXT_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  [
    'tool-arguments-invalid-dependency-layer :: wrong value type for read_file.path :: message 0',
    'path: Invalid input: expected string, received number',
  ],
  [
    'tool-arguments-invalid-dependency-layer :: unrecognized extra key for read_file :: message 0',
    'Unrecognized key: "bogus"',
  ],
  [
    'tool-arguments-omitted :: tools/call read_file with no arguments member :: message 0',
    'path: Invalid input: expected string, received undefined',
  ],
]);

/**
 * The recorded `E_INVALID_PARAMS` envelopes whose issue members are emitted in
 * a different order now.
 *
 * The order depends on how the refinement was written, so it is declared per
 * location rather than by shape. `validate_geckolib_file` uses `.refine()`,
 * whose issue the dependency builds as `code`, `path`, `message`.
 * `set_cube_uv` uses `.superRefine()` with an explicit `ctx.addIssue({...})`,
 * whose members keep the order the call site wrote them in and therefore still
 * match the recording exactly — that envelope is deliberately not listed here,
 * and it is the positive control showing this entry has not been widened into
 * a blanket rule about issue order.
 */
const ISSUE_ORDER_SITES: ReadonlySet<string> = new Set([
  'tool-arguments-invalid-handler-layer :: validate_geckolib_file with neither optional path, accepted by the advertised schema :: message 0',
]);

/**
 * Where the result for an omitted `arguments` member on a no-parameter tool is
 * taken from: the recorded result for the same call made with `arguments: {}`.
 * Both recorded requests use JSON-RPC id 2 and name the same tool, so the two
 * responses are comparable member for member.
 */
export const OMITTED_ARGUMENTS_REFERENCE = {
  scenario: 'tool-call-health-success',
  stepLabel: 'tools/call health',
  messageIndex: 0,
} as const;

/**
 * The recorded `tools/list` response the ledger reads to learn whether a
 * recorded tool took parameters.
 */
const RECORDED_CATALOG_REFERENCE = {
  scenario: 'tools-list-inventory',
  stepLabel: 'tools/list',
  messageIndex: 0,
} as const;

/**
 * Every recorded message whose bytes this ledger changes. These are exactly
 * the messages the oracle stops holding to their recorded byte identity, and
 * listing them is what keeps that exemption from spreading.
 */
const MEMBER_ORDER_SITES: readonly string[] = [
  'tool-arguments-invalid-dependency-layer :: unrecognized extra key for read_file :: message 0',
  'tool-arguments-invalid-dependency-layer :: wrong value type for read_file.path :: message 0',
  'tool-arguments-invalid-handler-layer :: validate_geckolib_file with neither optional path, accepted by the advertised schema :: message 0',
  'tool-arguments-omitted :: tools/call health with no arguments member :: message 0',
  'tool-arguments-omitted :: tools/call read_file with no arguments member :: message 0',
  'unknown-method-and-unknown-tool :: unknown tool name :: message 0',
];

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export const ACCEPTED_DEVIATIONS: readonly AcceptedDeviation[] = [
  {
    id: UNKNOWN_TOOL_ID,
    authority: 'adjudicated-in-plan',
    appliesTo: 'the `tools/call` response naming a tool that is not registered',
    was: 'a successful result carrying `isError: true` and the text `MCP error -32602: Tool <name> not found`',
    now: 'a JSON-RPC error object `{ "code": -32602, "message": "Tool <name> not found" }` with no `result` member',
    reason:
      'Both the 2026-07-28 and the 2025-06-18 tool specifications list an unknown tool under protocol errors with code -32602, so the recorded build was the non-conformant side. The message text itself is unchanged.',
    expectedSites: ['unknown-method-and-unknown-tool :: unknown tool name :: message 0'],
  },
  {
    id: MEMBER_ORDER_ID,
    authority: 'escalated-for-adjudication',
    appliesTo: 'the byte-level serialization of any recorded message this ledger rewrites',
    was: 'members were serialized in the recorded order, for example `result` before `jsonrpc` and `id`',
    now: 'the same member set is serialized in a different order',
    reason:
      'Member order inside a JSON object carries no protocol meaning. The oracle keeps the recorded byte identity as a required check for every message no ledger entry rewrites.',
    expectedSites: MEMBER_ORDER_SITES,
  },
  {
    id: VALIDATION_TEXT_ID,
    authority: 'adjudicated-in-plan',
    appliesTo: 'the dependency-layer rejection text inside a `tools/call` result',
    was: 'the `MCP error -32602: ` prefix followed by the tool name and a pretty-printed zod 3 issue array',
    now: 'the same `Input validation error: Invalid arguments for tool <name>: ` phrase followed by a one-line zod 4 issue summary',
    reason:
      'Dependency-owned message text. The outcome is still a successful result carrying `isError: true` rather than a JSON-RPC error, so the boundary between the dependency validation layer and the handler validation layer is unchanged.',
    expectedSites: [...VALIDATION_TEXT_REPLACEMENTS.keys()].sort(),
  },
  {
    id: OMITTED_ARGUMENTS_ID,
    authority: 'adjudicated-in-plan',
    appliesTo: 'a `tools/call` that omits the `arguments` member and names a tool that advertises no properties',
    was: 'a result carrying `isError: true` and a dependency-layer rejection naming the missing object',
    now: 'exactly the result recorded for the same call made with `arguments: {}`',
    reason:
      'The target specification recommends `{ "type": "object", "additionalProperties": false }` for a tool with no parameters and describes it as accepting only empty objects, so an omitted `arguments` member is an empty object. A tool with a required parameter is still rejected.',
    expectedSites: ['tool-arguments-omitted :: tools/call health with no arguments member :: message 0'],
  },
  {
    id: HEALTH_STRICT_ID,
    authority: 'escalated-for-adjudication',
    appliesTo: 'a `tools/call` naming `health` and passing an argument key the tool does not declare',
    was: 'the unrecognized key was stripped and the call succeeded, returning the ordinary health envelope',
    now: 'the call is rejected by the dependency validation layer with a result carrying `isError: true` and the text `Input validation error: Invalid arguments for tool health: Unrecognized key: "<key>"`',
    reason:
      'A tightening, not a loosening: `health` advertised `additionalProperties: false` in the recorded build while its schema was a plain `z.object({})`, which strips unknown members instead of rejecting them (`git show 93a203e:src/adapter/mcp-server.ts`). The advertised schema is unchanged and the enforcement now matches it. The recorded build did validate at this layer — the corpus records `read_file`, a genuinely strict schema, rejecting an extra key with `unrecognized_keys`, and records no such rejection for `health` — so this is a real behaviour change for a client that passed an undeclared key, and the migration specification names unknown-field strictness and the tool contract as compatibility surfaces that must be preserved. Declared here because that makes it reviewable; no other entry covers it, and entry `no-parameter-tool-accepts-omitted-arguments-member` covers the OMITTED `arguments` member and loosens.',
    expectedSites: [HEALTH_STRICT_ARGUMENTS_PROBE_SITE],
  },
  {
    id: ISSUE_ORDER_ID,
    authority: 'adjudicated-in-plan',
    appliesTo: 'the `error.details` entries inside a recorded `E_INVALID_PARAMS` envelope',
    was: 'each issue serialized its members in the order `code`, `message`, `path`',
    now: 'each issue serializes the same members and values in the order `code`, `path`, `message`',
    reason:
      'Cosmetic member order inside the preserved envelope, and only where the check is written with `.refine()`. The `E_*` code, the summary, `ok`, `command`, the issue member set, and every issue value are unchanged, and both validation layers still behave as recorded.',
    expectedSites: [...ISSUE_ORDER_SITES],
  },
  {
    id: PACKAGE_VERSION_ID,
    authority: 'escalated-for-adjudication',
    appliesTo: 'the `initialize` response\'s `serverInfo.version` and the `health` tool result\'s `adapter_version`',
    was: RECORDED_PACKAGE_VERSION,
    now: PACKAGE_VERSION_NOW,
    reason:
      'The package version was centralized to one exported constant and bumped to 0.3.0 (0.2.0 was skipped and never published) for four release-blocking fixes and a plugin compatibility correction (docs/plans/2026-08-28-0.2.0-release-blockers-implementation-plan.md); every reported identity now derives from that constant instead of the independently hardcoded 0.1.0 the corpus predates. No wire shape, schema, or enforcement changed.',
    expectedSites: PACKAGE_VERSION_SITES,
  },
];

/**
 * Entries that the migration plan's adjudicated deviation list does not cover.
 *
 * Pinning the set here is what stops the ledger from being widened quietly: an
 * entry added with `escalated-for-adjudication` authority and not listed here
 * fails `tests/premigration-wire-baseline.test.ts`, so a reviewer has to see it.
 */
export const ESCALATED_DEVIATION_IDS: readonly string[] = [HEALTH_STRICT_ID, MEMBER_ORDER_ID, PACKAGE_VERSION_ID].sort();

/**
 * Notes carried alongside the escalated entries, recording what was measured
 * about runtime behaviour rather than about the advertisement.
 */
export const ESCALATED_DEVIATION_NOTES: Readonly<Record<string, string>> = {
  [HEALTH_STRICT_ID]:
    'The escalated entry with a measured runtime effect, and the only entry whose difference the corpus does not record at all: `tools/call health` with an undeclared argument key was accepted by the recorded build and is now rejected. Measured live against the current build by the probe in `tests/premigration-wire-baseline.test.ts`.',
};

// ---------------------------------------------------------------------------
// Applying the ledger
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RecordedMessageContext {
  readonly scenario: string;
  readonly stepLabel: string;
  readonly messageIndex: number;
  /** The recorded request that produced this message, as the fixture framed it. */
  readonly request: unknown;
  /** Directory the corpus is being read from, so cross-fixture lookups follow it. */
  readonly fixtureRoot: string;
}

function siteOf(context: RecordedMessageContext): string {
  return `${context.scenario} :: ${context.stepLabel} :: message ${String(context.messageIndex)}`;
}

interface RecordedMessageReference {
  readonly scenario: string;
  readonly stepLabel: string;
  readonly messageIndex: number;
}

function readRecordedMessage(fixtureRoot: string, reference: RecordedMessageReference): unknown {
  const raw = readFileSync(join(fixtureRoot, 'scenarios', `${reference.scenario}.json`), 'utf8');
  const fixture = JSON.parse(raw) as {
    steps: Array<{ label: string; expect: Array<{ message: unknown }> }>;
  };
  const step = fixture.steps.find((entry) => entry.label === reference.stepLabel);
  if (step === undefined) {
    throw new Error(
      `the ledger expects ${reference.scenario} to record a step labelled ${JSON.stringify(reference.stepLabel)}`,
    );
  }
  const message = step.expect[reference.messageIndex]?.message;
  if (message === undefined) throw new Error(`the referenced recorded message in ${reference.scenario} is missing`);
  return message;
}

/**
 * Whether a tool advertised no parameters when the corpus was recorded, read
 * from the recorded `tools/list` response. That catalogue is no longer compared
 * with the current build, but it is still the record of what each tool
 * accepted at the time the recorded rejection was captured.
 */
function recordedToolTakesNoParameters(fixtureRoot: string, toolName: string): boolean {
  const message = readRecordedMessage(fixtureRoot, RECORDED_CATALOG_REFERENCE) as {
    result?: { tools?: Array<{ name?: unknown; inputSchema?: { properties?: Record<string, unknown> } }> };
  };
  const tool = message.result?.tools?.find((entry) => entry.name === toolName);
  return tool?.inputSchema !== undefined && Object.keys(tool.inputSchema.properties ?? {}).length === 0;
}

function textResultOf(message: unknown): { result: Record<string, unknown>; text: string } | null {
  if (!isPlainObject(message)) return null;
  const result = message.result;
  if (!isPlainObject(result) || result.isError !== true) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const entry = content[0] as unknown;
  if (!isPlainObject(entry) || entry.type !== 'text' || typeof entry.text !== 'string') return null;
  return { result, text: entry.text };
}

function withText(message: Record<string, unknown>, text: string): Record<string, unknown> {
  const rewritten = clone(message);
  const result = rewritten.result as { content: Array<{ type: string; text: string }> };
  result.content[0].text = text;
  return rewritten;
}

/** Rewrite a recorded `initialize` response's `serverInfo.version`, if present and recorded. */
function withRewrittenServerInfoVersion(recordedMessage: unknown): Record<string, unknown> | null {
  if (!isPlainObject(recordedMessage)) return null;
  const result = recordedMessage.result;
  if (!isPlainObject(result)) return null;
  const serverInfo = result.serverInfo;
  if (!isPlainObject(serverInfo) || serverInfo.version !== RECORDED_PACKAGE_VERSION) return null;
  const rewritten = clone(recordedMessage) as Record<string, unknown>;
  const rewrittenResult = rewritten.result as Record<string, unknown>;
  (rewrittenResult.serverInfo as Record<string, unknown>).version = PACKAGE_VERSION_NOW;
  return rewritten;
}

/** Rewrite a recorded `health` tool result's `adapter_version`, if present and recorded. */
function withRewrittenHealthAdapterVersion(recordedMessage: unknown): Record<string, unknown> | null {
  if (!isPlainObject(recordedMessage)) return null;
  const result = recordedMessage.result;
  if (!isPlainObject(result) || result.isError === true) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const entry = content[0] as unknown;
  if (!isPlainObject(entry) || entry.type !== 'text' || typeof entry.text !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const parsedResult = parsed.result;
  if (!isPlainObject(parsedResult) || parsedResult.adapter_version !== RECORDED_PACKAGE_VERSION) return null;
  parsedResult.adapter_version = PACKAGE_VERSION_NOW;
  const rewritten = clone(recordedMessage) as Record<string, unknown>;
  const rewrittenResult = rewritten.result as Record<string, unknown>;
  const rewrittenContent = rewrittenResult.content as Array<Record<string, unknown>>;
  rewrittenContent[0] = { ...rewrittenContent[0], text: JSON.stringify(parsed, null, 2) };
  return rewritten;
}

/**
 * Rewrite one recorded JSON-RPC message into the message that must be observed
 * now. Anything no entry describes is returned unchanged, which is what makes
 * an undocumented difference fail.
 */
export function applyAcceptedDeviationsToRecordedMessage(
  recordedMessage: unknown,
  context: RecordedMessageContext,
  usage: DeviationUsage,
): unknown {
  const site = siteOf(context);

  const serverInfoRewrite = withRewrittenServerInfoVersion(recordedMessage);
  if (serverInfoRewrite !== null) {
    usage.note(PACKAGE_VERSION_ID, site);
    return serverInfoRewrite;
  }

  const healthVersionRewrite = withRewrittenHealthAdapterVersion(recordedMessage);
  if (healthVersionRewrite !== null) {
    usage.note(PACKAGE_VERSION_ID, site);
    return healthVersionRewrite;
  }

  const textResult = textResultOf(recordedMessage);
  if (textResult === null) return recordedMessage;
  const message = recordedMessage as Record<string, unknown>;

  const unknownTool = UNKNOWN_TOOL_TEXT.exec(textResult.text);
  if (unknownTool !== null) {
    usage.note(UNKNOWN_TOOL_ID, site);
    usage.note(MEMBER_ORDER_ID, site);
    return { jsonrpc: message.jsonrpc, id: message.id, error: { code: -32602, message: unknownTool[1] } };
  }

  const invalidArguments = INVALID_ARGUMENTS_TEXT.exec(textResult.text);
  if (invalidArguments !== null) {
    const [, invariantPrefix, toolName] = invalidArguments;
    const request = isPlainObject(context.request) ? context.request : undefined;
    const params = request !== undefined && isPlainObject(request.params) ? request.params : undefined;
    const omittedArguments = params !== undefined && !('arguments' in params);
    if (omittedArguments && recordedToolTakesNoParameters(context.fixtureRoot, toolName)) {
      usage.note(OMITTED_ARGUMENTS_ID, site);
      usage.note(MEMBER_ORDER_ID, site);
      const reference = readRecordedMessage(context.fixtureRoot, OMITTED_ARGUMENTS_REFERENCE);
      const referenceVersionRewrite = withRewrittenHealthAdapterVersion(reference);
      if (referenceVersionRewrite !== null) {
        usage.note(PACKAGE_VERSION_ID, site);
        return referenceVersionRewrite;
      }
      return reference;
    }
    const replacement = VALIDATION_TEXT_REPLACEMENTS.get(site);
    if (replacement === undefined) {
      throw new Error(
        `${site}: the recorded dependency-layer rejection text changed at a location the accepted-deviation ` +
          'ledger does not describe. Add a reviewed entry naming the exact replacement, or treat it as a regression.',
      );
    }
    usage.note(VALIDATION_TEXT_ID, site);
    usage.note(MEMBER_ORDER_ID, site);
    return withText(message, `${invariantPrefix}${replacement}`);
  }

  const envelope = ISSUE_ORDER_SITES.has(site) ? parseEnvelopeWithIssues(textResult.text) : null;
  if (envelope !== null) {
    usage.note(ISSUE_ORDER_ID, site);
    usage.note(MEMBER_ORDER_ID, site);
    return withText(message, envelope);
  }

  return recordedMessage;
}

const ISSUE_MEMBERS_RECORDED = ['code', 'message', 'path'];
const ISSUE_MEMBERS_NOW = ['code', 'path', 'message'] as const;

/**
 * Re-serialize a recorded `E_INVALID_PARAMS` envelope with its issue members in
 * the order they are emitted now. Every member and value is carried over
 * untouched, and an issue carrying any other member set is left alone so it
 * still fails.
 */
function parseEnvelopeWithIssues(text: string): string | null {
  if (!text.startsWith('{')) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(envelope)) return null;
  const error = envelope.error;
  if (!isPlainObject(error) || !Array.isArray(error.details)) return null;
  const details = error.details as unknown[];
  if (details.length === 0) return null;
  const reordered: unknown[] = [];
  for (const issue of details) {
    if (!isPlainObject(issue)) return null;
    if (JSON.stringify(Object.keys(issue).sort()) !== JSON.stringify(ISSUE_MEMBERS_RECORDED)) return null;
    if (JSON.stringify(Object.keys(issue)) === JSON.stringify(ISSUE_MEMBERS_NOW)) return null;
    reordered.push({ code: issue.code, path: issue.path, message: issue.message });
  }
  error.details = reordered;
  return JSON.stringify(envelope, null, 2);
}
