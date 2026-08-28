// Raw newline-delimited JSON-RPC helpers for driving both MCP wire eras.
//
// These sit on top of `raw-stdio.ts` and add only what the era matrix needs:
// the reserved `_meta` envelope a `2026-07-28` request carries, the five
// locked legacy revisions, and a few predicates the absence assertions read.
//
// They deliberately do not use the MCP client package. The client and the
// server ship as a matched pair, so a client-driven test can only show that
// the two agree with each other; driving the bytes directly is what makes
// these assertions a statement about the wire.
import type { RawStdioSession } from './raw-stdio.ts';

/** The modern revision this executable serves. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * The legacy revisions the executable must keep negotiating, oldest first.
 * The recorded corpus in `tests/fixtures/premigration/` froze this list.
 */
export const LOCKED_LEGACY_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
];

/**
 * The revision a legacy `initialize` naming an unknown version is answered
 * with. Frozen by `tests/fixtures/premigration/scenarios/initialize-unsupported-version.json`.
 */
export const LEGACY_COUNTER_OFFER_VERSION = '2025-11-25';

/** The capability shape every legacy revision has always been answered with. */
export const LEGACY_CAPABILITIES = { tools: { listChanged: true } } as const;

/** The capability shape a `2026-07-28` connection is answered with. */
export const MODERN_CAPABILITIES = { tools: { listChanged: false } } as const;

/** The one server identity both eras report. */
export const CANONICAL_SERVER_INFO = {
  name: 'minecraft-blockbench-mcp',
  version: '0.2.0',
} as const;

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/**
 * The result members that mark a specification-designated cacheable complete
 * result. This server produces them for `server/discover` and `tools/list`
 * only.
 */
export const CACHEABLE_RESULT_MEMBERS: readonly string[] = ['ttlMs', 'cacheScope'];

export interface ModernMetaOptions {
  protocolVersion?: string;
  clientCapabilities?: unknown;
  clientInfo?: unknown;
  /** Extra `_meta` members that are not part of the reserved envelope. */
  extra?: Readonly<Record<string, unknown>>;
}

/** Build the reserved `_meta` envelope a `2026-07-28` request must carry. */
export function modernMeta(options: ModernMetaOptions = {}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [PROTOCOL_VERSION_META_KEY]: options.protocolVersion ?? MODERN_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: options.clientCapabilities ?? {},
    [CLIENT_INFO_META_KEY]: options.clientInfo ?? { name: 'era-matrix-client', version: '1.0.0' },
  };
  if (options.extra !== undefined) Object.assign(meta, options.extra);
  return meta;
}

/** Frame one `2026-07-28` request, carrying the reserved envelope. */
export function modernRequest(
  id: number | string,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  meta: ModernMetaOptions = {},
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: modernMeta(meta) } };
}

/** Frame one legacy request. Legacy requests carry no reserved envelope. */
export function legacyRequest(
  id: number | string,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

export interface LegacyOpeningOptions {
  protocolVersion?: string;
  /** `_meta` members carried on the opening `initialize`. */
  meta?: Readonly<Record<string, unknown>>;
  clientInfo?: Readonly<Record<string, unknown>>;
  capabilities?: Readonly<Record<string, unknown>>;
}

/** Frame one legacy opening `initialize`. */
export function legacyOpening(
  id: number | string,
  options: LegacyOpeningOptions = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    protocolVersion: options.protocolVersion ?? '2025-06-18',
    capabilities: options.capabilities ?? {},
    clientInfo: options.clientInfo ?? { name: 'era-matrix-client', version: '1.0.0' },
  };
  if (options.meta !== undefined) params._meta = { ...options.meta };
  return { jsonrpc: '2.0', id, method: 'initialize', params };
}

/**
 * Send a legacy `initialize`, wait for its answer, and send
 * `notifications/initialized`. Returns the parsed `initialize` result.
 */
export async function openLegacyConnection(
  session: RawStdioSession,
  options: LegacyOpeningOptions & { id?: number | string } = {},
): Promise<Record<string, unknown>> {
  const before = session.stdoutLines().length;
  session.send(legacyOpening(options.id ?? 1, options));
  await session.waitForStdoutLines(before + 1);
  const message = JSON.parse(session.stdoutLines()[before]) as { result?: Record<string, unknown> };
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (message.result === undefined) {
    throw new Error(`the legacy opening was refused: ${session.stdoutLines()[before]}`);
  }
  return message.result;
}

/**
 * Send a `server/discover` as the very first message on the connection, which
 * is what pins it to `2026-07-28`. Returns the parsed result.
 */
export async function openModernConnection(
  session: RawStdioSession,
  options: { id?: number | string } & ModernMetaOptions = {},
): Promise<Record<string, unknown>> {
  const before = session.stdoutLines().length;
  session.send(modernRequest(options.id ?? 1, 'server/discover', {}, options));
  await session.waitForStdoutLines(before + 1);
  const message = JSON.parse(session.stdoutLines()[before]) as { result?: Record<string, unknown> };
  if (message.result === undefined) {
    throw new Error(`the modern opening was refused: ${session.stdoutLines()[before]}`);
  }
  return message.result;
}

/** Send one request and return the single message it produced. */
export async function exchange(
  session: RawStdioSession,
  request: unknown,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const before = session.stdoutLines().length;
  session.send(request);
  await session.waitForStdoutLines(before + 1, timeoutMs);
  return JSON.parse(session.stdoutLines()[before]) as Record<string, unknown>;
}

/**
 * Send one request and prove it produces nothing within a quiet period. The
 * caller supplies the positive control; this only reports the silence.
 */
export async function exchangeExpectingSilence(
  session: RawStdioSession,
  request: unknown,
  quietMs = 400,
): Promise<string[]> {
  const before = session.stdoutLines().length;
  session.send(request);
  await session.settle(quietMs);
  return session.stdoutLines().slice(before);
}

/**
 * Whether a JSON-RPC object is a request rather than a response or a
 * notification. On a `2026-07-28` connection the server must never send one:
 * the revision has no server-to-client request, and a server that issues one
 * would be asking a client to answer a method it never agreed to serve.
 */
export function carriesMethodAndId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return 'method' in record && 'id' in record;
}

/** Whether a JSON-RPC object is an ordinary response to a client request. */
export function isResponse(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return 'id' in record && !('method' in record) && ('result' in record || 'error' in record);
}

/** Whether a JSON-RPC object is a notification. */
export function isNotification(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return 'method' in record && !('id' in record);
}

/** The JSON text envelope a tool result carries, parsed. */
export function envelopeOf(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`this message carries no tool text envelope: ${JSON.stringify(message).slice(0, 400)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** The `E_*` code a failed tool envelope reports, or null for a success. */
export function errorCodeOf(envelope: Record<string, unknown>): string | null {
  const error = envelope.error as { code?: unknown } | undefined;
  return typeof error?.code === 'string' ? error.code : null;
}

/** Every advertised tool in a `tools/list` result, in advertised order. */
export function advertisedTools(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = message.result as { tools?: Array<Record<string, unknown>> } | undefined;
  return result?.tools ?? [];
}
