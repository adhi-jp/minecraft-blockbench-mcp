// Transport ingress guard for dual-era MCP stdio serving.
//
// What it is: a wrapper around the public `Transport` interface of
// `@modelcontextprotocol/server`, handed to
// `serveStdio(factory, { legacy: 'serve', transport })` through the public
// `ServeStdioOptions.transport` option. It owns two narrow, closed rewrites of
// the inbound stream, described in full below:
//
//   A. it strips the reserved 2026-07-28 claim keys from a hybrid opening
//      `initialize`, so that opening is served as a 2025-era handshake; and
//   B. once the connection is serving 2026-07-28, it refuses a request whose
//      `io.modelcontextprotocol/protocolVersion` claim names a revision this
//      server does not support, with `-32022`.
//
// Why A exists: `@modelcontextprotocol/server` classifies the opening message
// of a stdio connection from the message body alone. An `initialize` request
// is the 2025-era handshake UNLESS its `params._meta` carries a valid
// 2026-07-28 per-request envelope claim, in which case the entry serves the
// connection as 2026-07-28 instead. A client that intends a 2025-era
// handshake but also stamps the reserved 2026-07-28 claims onto `_meta` (a
// "hybrid opening") is therefore classified as 2026-07-28, and that instance
// answers its `initialize` with `-32601`, breaking the client outright. This
// wrapper removes exactly the reserved claim keys from that one opening
// message so the entry sees an ordinary 2025-era handshake.
//
// Why B exists: MCP 2026-07-28 is a stateless protocol. `basic/index`
// (Statelessness) requires that a server process each request independently
// and never infer `_meta` context — capabilities, protocol version, client
// identity — from earlier requests on the same connection, and it lists
// `io.modelcontextprotocol/protocolVersion` as required on every client
// request. `@modelcontextprotocol/server` validates the SHAPE of that envelope
// on every request (a missing or malformed one is its own `-32602`), but it
// compares the claimed revision against the supported set only while it is
// still deciding which era the connection speaks. On a connection already
// serving 2026-07-28 an unsupported revision is therefore accepted and the
// request is served in full. This wrapper restores the per-request comparison
// at the same seam, and nowhere else.
//
// Narrowness contract — the complete behavior of this class:
//   1. The opening rewrite acts on at most ONE message per connection: the
//      first JSON-RPC request whose `method` is `initialize`. Nothing else is
//      rewritten; every other message (including any later `initialize`, and
//      an `initialize`-shaped notification with no `id`) reaches the era
//      tracking below as the very same object reference it arrived as.
//   2. On that one message it deletes ONLY the keys named in
//      `MODERN_RESERVED_OPENING_CLAIM_META_KEYS`, and only from
//      `params._meta`. No other object, key, or value is read or written.
//   3. If none of those keys are present, the message is forwarded as the very
//      same object reference — a non-hybrid opening is untouched.
//   4. When it does strip, it copies only the three containers on the path it
//      edits (the message, `params`, and `params._meta`). Every sibling value
//      is carried over by reference, so nothing below the edited path can be
//      re-serialized, re-ordered, or coerced. The caller's original object is
//      never mutated.
//   5. The outbound and lifecycle paths are straight delegations: `send`,
//      `start`, and `close` never inspect, buffer, reorder, or delay anything.
//      The one message this class writes on its own initiative is the `-32022`
//      refusal in rule 7.
//   6. Era tracking reads the message the dependency will see — the rewritten
//      one — and only ever reads it. See `observeEra` for the exact rule,
//      including why `server/discover` does not settle the era.
//   7. The `-32022` refusal fires ONLY on a request, ONLY once the connection
//      is settled on 2026-07-28, and ONLY when the claim carries a string
//      value outside `SUPPORTED_MODERN_PROTOCOL_REVISIONS`. A refused request
//      is not forwarded, so it produces exactly one response and reaches
//      nothing downstream of this seam.
//
// It deliberately does NOT decide which era `serveStdio` serves, pin an
// instance, validate the envelope's shape, or answer anything else on the
// wire. `serveStdio` still owns all of that.
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  classifyInboundRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/server';

/**
 * The exact, closed list of `params._meta` keys this wrapper removes from a
 * hybrid opening `initialize`. These are the reserved keys that make up the
 * 2026-07-28 per-request envelope. The strings come from the public
 * `@modelcontextprotocol/server` exports so the list cannot drift from the
 * dependency's own spelling:
 *
 *   'io.modelcontextprotocol/protocolVersion'    — the claim itself; its mere
 *        presence is what the entry tests first. Removing this one key is by
 *        itself sufficient to force 2025-era classification.
 *   'io.modelcontextprotocol/clientCapabilities' — the other required member
 *        of the 2026-07-28 envelope.
 *   'io.modelcontextprotocol/clientInfo'         — the optional member of the
 *        2026-07-28 envelope.
 *
 * All three are removed so that no fragment of a 2026-07-28 envelope survives
 * into a connection that has been decided to be 2025-era, and no later layer
 * can re-read a half-envelope and reach a different era verdict.
 *
 * Explicitly NOT in this list, and therefore always preserved: every ordinary
 * `_meta` key, the W3C trace keys ('traceparent', 'tracestate', 'baggage'),
 * other 'io.modelcontextprotocol/*' keys that take no part in the envelope
 * claim (for example 'io.modelcontextprotocol/logLevel' and
 * 'io.modelcontextprotocol/related-task'), any key that merely resembles a
 * reserved one, and any nested occurrence of a reserved key deeper inside a
 * `_meta` value.
 */
export const MODERN_RESERVED_OPENING_CLAIM_META_KEYS: readonly string[] = Object.freeze([
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
]);

/**
 * The complete set of modern protocol revisions this server serves — the only
 * values an `io.modelcontextprotocol/protocolVersion` claim may name on a
 * connection that is already serving 2026-07-28. Any other value is refused
 * with `-32022`, and this list is what such a refusal reports back as
 * `data.supported`.
 *
 * Written out here rather than imported because
 * `@modelcontextprotocol/server` keeps its modern revision list
 * (`SUPPORTED_MODERN_PROTOCOL_VERSIONS`) internal on purpose — its own comment
 * reads "Internal — not part of the public API surface" — and the two lists it
 * does export are the 2025-era ones: `LATEST_PROTOCOL_VERSION` is
 * '2025-11-25' and `SUPPORTED_PROTOCOL_VERSIONS` is the five-revision legacy
 * `initialize` list. Reaching past the package entry point to borrow the
 * internal list is not allowed here, so the value is stated once, in one
 * place, and `tests/mcp-era-negotiation-wire.test.ts` pins it to the
 * dependency's own emission by requiring that a refusal written here and a
 * refusal written by the dependency are byte-identical for the same claim.
 */
export const SUPPORTED_MODERN_PROTOCOL_REVISIONS: readonly string[] = Object.freeze(['2026-07-28']);

export interface HybridOpeningNormalizerOptions {
  /** Observation hook; called only when an opening message was actually rewritten. */
  onNormalize?: (record: { strippedKeys: string[] }) => void;
}

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The revision named by a message's `io.modelcontextprotocol/protocolVersion`
 * claim, or `undefined` when the message carries no claim or the claim's value
 * is not a string.
 *
 * A present-but-non-string claim deliberately reads as "no claim" here: that
 * is an envelope SHAPE fault, which `@modelcontextprotocol/server` already
 * answers with `-32602` on every request. Only the version VALUE check is this
 * wrapper's to make.
 */
function claimedProtocolRevision(params: unknown): string | undefined {
  if (!isPlainObject(params)) return undefined;
  const meta: unknown = params['_meta'];
  if (!isPlainObject(meta)) return undefined;
  const claimed: unknown = meta[PROTOCOL_VERSION_META_KEY];
  return typeof claimed === 'string' ? claimed : undefined;
}

/**
 * Which wire era the connection is serving, as far as this wrapper can tell.
 *
 * `'undecided'` covers both "nothing has arrived yet" and "only `server/discover`
 * has arrived", because `server/discover` does not settle the era.
 */
type ObservedWireEra = 'undecided' | 'legacy' | 'modern';

/**
 * The id stamped onto a copy of a notification so the era classifier can be
 * asked the one question it exposes: `classifyInboundRequest` is documented as
 * the body-primary era predicate, but its notification arm answers a narrower
 * question than `serveStdio` asks of the same bytes — it accepts an envelope
 * whose claim names a revision while some other reserved member is malformed,
 * where the stdio opening classifier calls that envelope invalid and refuses to
 * pin anything on it.
 *
 * `serveStdio` classifies an opening message without regard to whether it
 * carries an id, so classifying the request-shaped copy asks the classifier the
 * same question the dependency asks. The copy exists only to be classified: it
 * is never forwarded, never sent, and never observed by anything else, and the
 * classifier reads no part of it beyond the JSON-RPC shape.
 */
const NOTIFICATION_CLASSIFICATION_PROBE_ID = 0;

export class HybridOpeningInitializeNormalizer implements Transport {
  private readonly inner: Transport;
  private readonly onNormalizeHook: HybridOpeningNormalizerOptions['onNormalize'];
  private openingInitializeSeen = false;
  private observedEra: ObservedWireEra = 'undecided';
  /**
   * Whether a modern `server/discover` request has opened the dependency's
   * discardable probe instance and nothing has closed it yet. This is the one
   * state in which `serveStdio` accepts a modern-classified notification
   * without pinning the connection, so it is the one state in which this
   * wrapper must keep ignoring one.
   */
  private modernProbeOpen = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(inner: Transport, options: HybridOpeningNormalizerOptions = {}) {
    this.inner = inner;
    this.onNormalizeHook = options.onNormalize;

    this.inner.onmessage = (message, extra) => {
      // The era is read from the message the dependency will actually see, so
      // a hybrid opening that this wrapper has just rewritten is classified
      // the way the rewrite made it: 2025-era.
      const forwarded = this.normalizeOpening(message);
      this.observeEra(forwarded);
      if (this.refuseUnsupportedProtocolRevision(forwarded)) return;
      this.onmessage?.(forwarded, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
  }

  private normalizeOpening(message: JSONRPCMessage): JSONRPCMessage {
    // Rule 1: only the first `initialize` REQUEST of the connection. The public
    // `isJSONRPCRequest` guard is what distinguishes the handshake request from
    // an `initialize`-shaped notification that carries no `id`.
    if (this.openingInitializeSeen) return message;
    if (!isJSONRPCRequest(message)) return message;
    if (message.method !== 'initialize') return message;
    this.openingInitializeSeen = true;

    const params: unknown = message.params;
    if (!isPlainObject(params)) return message;
    const meta: unknown = params['_meta'];
    if (!isPlainObject(meta)) return message;

    const present = MODERN_RESERVED_OPENING_CLAIM_META_KEYS.filter((key) => key in meta);
    // Rule 3: a non-hybrid opening is forwarded as the identical object.
    if (present.length === 0) return message;

    // Rule 4: copy only the three containers on the edited path.
    const nextMeta: UnknownRecord = { ...meta };
    for (const key of present) delete nextMeta[key];
    const nextParams: UnknownRecord = { ...params, _meta: nextMeta };
    const normalized = { ...message, params: nextParams } as JSONRPCMessage;

    this.onNormalizeHook?.({ strippedKeys: present });
    return normalized;
  }

  /**
   * Tracks which era the connection has settled on, mirroring the rule
   * `serveStdio` applies to its own opening exchange.
   *
   * THE EXACT RULE, and why each arm is what it is:
   *
   *  - A JSON-RPC REQUEST and a JSON-RPC NOTIFICATION both settle the era, on
   *    the same terms, because that is what the dependency does with them.
   *    `serveStdio` classifies an opening message from its body alone and
   *    pins the connection on the verdict; its one carve-out for notifications
   *    lives in the `server/discover` probe branch, not in the general one
   *    (see `modernProbeOpen` below). Ignoring notifications here is therefore not
   *    the safe direction it looks like: it leaves this wrapper `'undecided'`
   *    on a connection the dependency has already pinned to 2026-07-28, and on
   *    such a connection declining to act IS the failure — the unsupported
   *    revision the guard exists to refuse reaches the tool instead. It is
   *    also what let a later legacy-shaped `initialize` latch `'legacy'` onto
   *    a connection pinned modern, disabling the guard for good.
   *
   *  - Anything that is neither a request nor a notification settles nothing.
   *    A response arriving before the era is negotiated is discarded by the
   *    dependency without pinning, and the era classifier would call that body
   *    `'legacy'`, so it must never be asked about one.
   *
   *  - The verdict itself comes from the dependency's own public
   *    `classifyInboundRequest`, not from a second copy of its rules written
   *    here. `serveStdio` documents its opening classifier as applying "the
   *    same body-primary rules the HTTP entry applies per request", and
   *    `classifyInboundRequest` is the exported form of those rules; called
   *    with no headers it is a pure body-primary router. So the envelope-shape
   *    question — is this `_meta` a well-formed 2026-07-28 envelope at all? —
   *    is answered once, by the dependency, and never re-implemented here.
   *
   *  - `'legacy'`: the request is a 2025-era `initialize`, or it carries no
   *    `io.modelcontextprotocol/protocolVersion` claim. Either settles the
   *    connection on the 2025 era for its whole lifetime. From here on the
   *    wrapper never inspects a claim again, which is what keeps `_meta`
   *    opaque to a 2025-era client: such a client may carry a stray or even
   *    unsupported reserved claim and must still be served, exactly as it was
   *    before this wrapper existed.
   *
   *  - `'modern'`: the dependency classified the message onto the 2026-07-28
   *    path AND the claim names a revision in
   *    `SUPPORTED_MODERN_PROTOCOL_REVISIONS` AND the message is not one the
   *    dependency serves from its discardable probe instance. All three
   *    conditions are required:
   *      * a classification the dependency rejected (a malformed envelope,
   *        answered `-32602`) settles nothing — the connection is still open
   *        to either era, so the wrapper stays `'undecided'`;
   *      * a claim naming a revision outside the supported set settles nothing
   *        either — the dependency answers that itself with `-32022` while the
   *        era is still being decided, which is the one case that already
   *        worked;
   *      * a `server/discover` REQUEST does NOT settle the era, and opens the
   *        probe instead. It is the one method a 2026-07-28 client may call
   *        before committing, and `serveStdio` serves it from a discardable
   *        instance that a following 2025-era `initialize` is still free to
   *        replace. While that probe is open a modern-classified NOTIFICATION
   *        is delivered to the probe instance and still settles nothing — the
   *        dependency returns from its probe branch before pinning. Every
   *        other modern-classified message settles the era, closing the probe.
   *
   * Once `'legacy'` or `'modern'` is reached the connection cannot change era,
   * so the classifier is never consulted again — which is also what stops a
   * legacy-shaped message that arrives after a modern one from re-opening a
   * decision the dependency has already made.
   */
  private observeEra(message: JSONRPCMessage): void {
    if (this.observedEra !== 'undecided') return;
    const notification = !isJSONRPCRequest(message);
    if (notification && !isJSONRPCNotification(message)) return;

    const outcome = classifyInboundRequest({
      httpMethod: 'POST',
      body: notification ? { ...message, id: NOTIFICATION_CLASSIFICATION_PROBE_ID } : message,
    });
    if (outcome.kind === 'legacy') {
      this.observedEra = 'legacy';
      this.modernProbeOpen = false;
      return;
    }
    if (outcome.kind !== 'modern') return;

    const claimed = claimedProtocolRevision(message.params);
    if (claimed === undefined || !SUPPORTED_MODERN_PROTOCOL_REVISIONS.includes(claimed)) return;
    if (!notification && message.method === 'server/discover') {
      this.modernProbeOpen = true;
      return;
    }
    if (notification && this.modernProbeOpen) return;
    this.observedEra = 'modern';
  }

  /**
   * Refuses one request on a connection already serving 2026-07-28 whose
   * `io.modelcontextprotocol/protocolVersion` claim names a revision outside
   * `SUPPORTED_MODERN_PROTOCOL_REVISIONS`, and reports whether it did.
   *
   * A refused request is answered here and NOT forwarded, so the dependency
   * never sees it: exactly one terminal response is written for that request
   * id, and nothing downstream of this seam — no broker lease, no scope
   * operation, no command relayed to Blockbench — is reached.
   *
   * The refusal is built from the dependency's own
   * `UnsupportedProtocolVersionError`, so its code, its message text and its
   * `data` shape are the dependency's, identical to the refusal `serveStdio`
   * writes for the same claim while it is still deciding the era.
   *
   * Deliberately out of scope, each because the dependency already covers it:
   * a missing or malformed `_meta` envelope (its `-32602`), any request on a
   * 2025-era connection, and any notification — a notification carries no id
   * to answer and the specification requires the claim on requests.
   */
  private refuseUnsupportedProtocolRevision(message: JSONRPCMessage): boolean {
    if (this.observedEra !== 'modern') return false;
    if (!isJSONRPCRequest(message)) return false;

    const requested = claimedProtocolRevision(message.params);
    if (requested === undefined) return false;
    if (SUPPORTED_MODERN_PROTOCOL_REVISIONS.includes(requested)) return false;

    const refusal = new UnsupportedProtocolVersionError({
      supported: [...SUPPORTED_MODERN_PROTOCOL_REVISIONS],
      requested,
    });
    this.inner
      .send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: refusal.code, message: refusal.message, data: refusal.data },
      })
      .catch((cause: unknown) => {
        this.onerror?.(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return true;
  }

  // Rule 5: outbound and lifecycle are straight delegations.
  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }
}
