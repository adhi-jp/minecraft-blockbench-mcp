// The one shape a withdrawn request takes on its way back out of a plugin
// bridge, shared by the direct WebSocket bridge and the broker client so
// `mcp-server.ts` can recognize a cancellation without knowing which of the two
// it is talking to.

/**
 * How far a withdrawn request had travelled when the caller gave up on it.
 * This is the whole of what the adapter can honestly claim:
 *
 * - `before_send`: nothing left the adapter, so the Blockbench plugin can never
 *   observe this command and nothing needs reconciling.
 * - `after_send`: the command was already handed onward. Whether Blockbench ran
 *   it is deliberately not reported, because the adapter does not know. It is
 *   never rolled back and never replayed.
 */
export type RequestCancellationStage = 'before_send' | 'after_send';

/**
 * Raised instead of a `BridgeRequestResult` when an MCP client withdrew the
 * request with `notifications/cancelled`.
 *
 * A cancelled request rejects rather than resolving, so no outcome — not a
 * result, not an error envelope — can reach the tool handler and be turned into
 * a client-facing message. `@modelcontextprotocol/server` drops both the result
 * and the thrown error of a request whose abort signal has fired, which is what
 * keeps a withdrawn request silent on the wire.
 */
export class RequestCancelledError extends Error {
  constructor(
    /**
     * The adapter's own correlation identity for the withdrawn attempt: the
     * internal request UUID where one exists, otherwise the command name. Never
     * the client's JSON-RPC id, which is untrusted and repeats across clients.
     */
    readonly requestId: string,
    readonly stage: RequestCancellationStage,
    message: string,
  ) {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

/** True for a rejection that means "the client withdrew this request". */
export function isRequestCancelled(error: unknown): error is RequestCancelledError {
  return error instanceof RequestCancelledError;
}
