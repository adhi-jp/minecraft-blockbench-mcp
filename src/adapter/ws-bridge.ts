// Loopback WebSocket bridge between the MCP adapter and the Blockbench plugin.
// Owns the listener, shared-secret authentication, the single-active-plugin
// lock, heartbeats, and request/response correlation. The plugin connects as
// a WebSocket client; this side never initiates connections.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { WebSocketServer, WebSocket, type RawData } from 'ws';

import {
  PROTOCOL_VERSION,
  COMMAND_SPECS,
  INTERNAL_COMMAND_SPECS,
  isCommandName,
  pluginToAdapterMessageSchema,
  scopeStatusSchema,
  makeError,
  type ErrorPayload,
  type HelloMessage,
  type ScopeStatus,
} from '../shared/protocol.js';
import type { SetupIssue } from './config.js';
import { RequestCancelledError, type RequestCancellationStage } from './request-cancellation.js';

// Application close codes (4000-range is reserved for applications by RFC 6455).
export const CLOSE_CODES = {
  invalidHandshake: 4400,
  authFailed: 4401,
  handshakeTimeout: 4408,
  sessionExists: 4409,
  protocolMismatch: 4426,
} as const;

export interface PluginInfo {
  plugin_version: string;
  blockbench_version: string;
  capabilities: string[];
  scope: ScopeStatus | null;
}

export interface BridgeOptions {
  port: number;
  secret: string | null;
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatMissLimit: number;
  handshakeTimeoutMs: number;
  maxMessageBytes: number;
  /** Receives sanitized log lines only; secrets must never reach this. */
  log: (line: string) => void;
  onSessionChange?: (connected: boolean) => void;
  /** How long one authenticated session waits for its `revoke_scope` answer. */
  scopeRevocationTimeoutMs?: number;
}

export interface BridgeRequestResult {
  ok: boolean;
  result?: unknown;
  error?: ErrorPayload;
}

interface PendingRequest {
  resolve: (value: BridgeRequestResult) => void;
  timer: NodeJS.Timeout;
}

/** Default window for one session's `revoke_scope` answer. */
const DEFAULT_SCOPE_REVOCATION_TIMEOUT_MS = 10_000;

/**
 * The scoped-directory states that still carry a live grant, and therefore can
 * never be an acknowledgement that the scope was cleared.
 *
 * `'confirmed'` is the state that hands out the directory handle. `'proposed'`
 * is a grant that needs nothing but the Blockbench user's confirmation to
 * become one, which is why the plugin's own `revoke()` transitions out of both.
 * The states left over — `'unconfirmed'`, `'revoked'`, `'expired'` — each mean
 * no directory is held.
 *
 * This is a value check on top of the schema check: `scopeStatusSchema` accepts
 * any member of `SCOPE_STATES`, so parsing alone would let a reply of
 * `{ state: 'confirmed' }` stand as proof of revocation. That reply is the one
 * thing between a plugin-side defect and a scoped directory inherited across
 * MCP clients — in brokered operation it would clear the lease taint and grant
 * control to a waiting client while the plugin still held the previous grant.
 */
const SCOPE_STATES_STILL_GRANTING: readonly ScopeStatus['state'][] = Object.freeze(['confirmed', 'proposed']);

/**
 * Raised instead of a result when an MCP client withdrew a request the direct
 * bridge was carrying. `before_send` means the command never reached the
 * Blockbench plugin at all; `after_send` means it was already on the WebSocket,
 * in which case the plugin's own answer (or the request timeout) is still
 * awaited internally and then discarded, so the command is neither recalled nor
 * replayed and this request still ends exactly once.
 */
export class BridgeRequestCancelledError extends RequestCancelledError {
  constructor(requestId: string, stage: RequestCancellationStage) {
    super(requestId, stage, `Direct plugin request ${requestId} was cancelled by the caller (${stage}).`);
    this.name = 'BridgeRequestCancelledError';
  }
}

function secretsMatch(expected: string, provided: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function listenerSetupIssue(error: NodeJS.ErrnoException, port: number): SetupIssue {
  return error.code === 'EADDRINUSE'
    ? { code: 'E_PORT_IN_USE', message: `WebSocket port 127.0.0.1:${port} is already in use.` }
    : {
        code: 'E_LISTENER_FAILED',
        message: `WebSocket listener failed to start on 127.0.0.1:${port} (${error.code ?? 'unknown error'}).`,
      };
}

export class WsBridge {
  readonly #options: BridgeOptions;
  #server: WebSocketServer | null = null;
  #active: WebSocket | null = null;
  #pluginInfo: PluginInfo | null = null;
  #pending = new Map<string, PendingRequest>();
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #heartbeatMisses = 0;
  #listening = false;
  #sockets = new Set<WebSocket>();
  #handshakeTimers = new Map<WebSocket, NodeJS.Timeout>();
  // A Blockbench plugin keeps a confirmed scoped directory across WebSocket
  // reconnects, so an adapter that has just authenticated a session may be
  // facing a directory some earlier adapter process was granted. Each newly
  // authenticated session therefore starts with its scope state unknown and
  // must clear it with an acknowledged `revoke_scope` before any public command
  // is relayed. #scopeSession increments on every authentication and detach so
  // an answer that arrives for a session that has already ended is discarded.
  #scopeSession = 0;
  #scopeCleared = false;
  #scopeClearedStatus: ScopeStatus = { state: 'revoked' };
  #scopeResetInFlight: Promise<BridgeRequestResult> | null = null;

  constructor(options: BridgeOptions) {
    this.#options = options;
  }

  get listening(): boolean {
    return this.#listening;
  }

  get connected(): boolean {
    return this.#active !== null && this.#active.readyState === WebSocket.OPEN;
  }

  get pluginInfo(): PluginInfo | null {
    return this.#pluginInfo;
  }

  /** Start the loopback listener. Resolves with a setup issue instead of throwing. */
  start(): Promise<{ ok: true } | { ok: false; issue: SetupIssue }> {
    if (this.#options.secret === null) {
      return Promise.resolve({
        ok: false,
        issue: {
          code: 'E_SECRET_MISSING',
          message:
            'No shared secret is configured; the plugin listener was not started. Set --secret, BLOCKBENCH_MCP_SECRET, or the config file secret.',
        },
      });
    }
    return new Promise((resolve) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: this.#options.port,
        maxPayload: this.#options.maxMessageBytes,
      });
      const onListenError = (error: NodeJS.ErrnoException) => {
        const issue = listenerSetupIssue(error, this.#options.port);
        resolve({ ok: false, issue });
      };
      server.once('error', onListenError);
      server.once('listening', () => {
        server.off('error', onListenError);
        server.on('error', (error) => this.#options.log(`WebSocket server error: ${String(error)}`));
        this.#server = server;
        this.#listening = true;
        this.#options.log(`Plugin WebSocket listener bound to 127.0.0.1:${this.#options.port}`);
        server.on('connection', (socket) => this.#handleConnection(socket));
        resolve({ ok: true });
      });
    });
  }

  async stop(): Promise<void> {
    this.#detachActive('adapter shutdown');
    const server = this.#server;
    this.#server = null;
    this.#listening = false;
    if (server !== null) {
      for (const timer of this.#handshakeTimers.values()) clearTimeout(timer);
      this.#handshakeTimers.clear();
      for (const socket of this.#sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * Relay one typed operation request to the authenticated plugin session.
   *
   * Public commands (every name in `COMMAND_SPECS`) are held until this session's
   * scoped-directory state has been cleared by an acknowledged `revoke_scope`.
   * If that acknowledgement cannot be obtained the command is refused with the
   * revocation's own failure rather than relayed, so a failure never widens
   * filesystem access. Internal control commands bypass the gate; they are how
   * the gate itself is opened.
   *
   * `signal` withdraws the request. Every point at which this method can wait --
   * on entry, and again after the scoped-directory gate, which is the one place
   * a public command can sit for a while before anything is sent -- is a point
   * at which a withdrawal still prevents the plugin from ever seeing the
   * command. A withdrawn request rejects with `BridgeRequestCancelledError`
   * instead of resolving, so no outcome can reach the caller.
   */
  async request(
    command: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BridgeRequestResult> {
    const withdrawn = (): boolean => signal !== undefined && signal.aborted;
    if (withdrawn()) throw new BridgeRequestCancelledError(command, 'before_send');
    if (!isCommandName(command)) return this.#relayCancellable(command, params, timeoutMs, signal);

    const cleared = await this.#clearInheritedScope();
    if (!cleared.ok) return cleared;
    // Clearing the inherited scope awaits a round trip to the plugin. A request
    // withdrawn during that wait must still never be relayed.
    if (withdrawn()) throw new BridgeRequestCancelledError(command, 'before_send');
    return this.#relayCancellable(command, params, timeoutMs, signal);
  }

  /**
   * Relay, and stop reporting the outcome the moment `signal` fires.
   *
   * The underlying relay is deliberately left running: its pending entry stays
   * until the plugin answers or the request times out, which clears the timer
   * and consumes the response. That outcome is then dropped on the floor. The
   * command is never recalled and never re-sent, and the caller sees exactly one
   * ending -- the cancellation.
   */
  #relayCancellable(
    command: string,
    params: unknown,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BridgeRequestResult> {
    const relayId = randomUUID();
    const relayed = this.#relay(command, params, timeoutMs, relayId);
    if (signal === undefined) return relayed;
    return new Promise<BridgeRequestResult>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new BridgeRequestCancelledError(relayId, 'after_send'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const detach = (): void => signal.removeEventListener('abort', onAbort);
      relayed.then(
        (outcome) => {
          detach();
          resolve(outcome);
        },
        (error: unknown) => {
          detach();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * Revoke the plugin's scoped directory now and report the acknowledgement.
   *
   * Always reaches the plugin unless one revocation for this session is already
   * in flight, in which case the caller joins it rather than queueing a second.
   * Callers that need a guarantee the previous holder's access is gone -- the
   * controller handoff in `broker-server.ts` -- use this; the per-session gate
   * below uses it once and then stands down, so a directory the Blockbench user
   * confirms afterwards stays usable for the rest of the session.
   */
  async revokeScope(): Promise<BridgeRequestResult> {
    if (!this.connected) {
      return {
        ok: false,
        error: makeError('E_PLUGIN_NOT_CONNECTED', 'Blockbench plugin is not connected.'),
      };
    }
    const existing = this.#scopeResetInFlight;
    if (existing !== null) return existing;

    const session = this.#scopeSession;
    const running = this.#runScopeRevocation(session);
    this.#scopeResetInFlight = running;
    try {
      return await running;
    } finally {
      if (this.#scopeResetInFlight === running) this.#scopeResetInFlight = null;
    }
  }

  /** True once this session's inherited scoped-directory state has been cleared. */
  get scopeCleared(): boolean {
    return this.#scopeCleared;
  }

  /**
   * Hold the caller until this session's inherited scoped-directory state has
   * been cleared exactly once. A failed attempt is never recorded as cleared,
   * so the next caller retries instead of inheriting a stale verdict, and no
   * caller is ever released by a failure.
   */
  async #clearInheritedScope(): Promise<BridgeRequestResult> {
    if (this.#scopeCleared) return { ok: true, result: this.#scopeClearedStatus };
    return this.revokeScope();
  }

  async #runScopeRevocation(session: number): Promise<BridgeRequestResult> {
    const outcome = await this.#relay(
      'revoke_scope',
      {},
      this.#options.scopeRevocationTimeoutMs ?? DEFAULT_SCOPE_REVOCATION_TIMEOUT_MS,
    );
    if (!outcome.ok) return outcome;
    const validated = INTERNAL_COMMAND_SPECS.revoke_scope.result.safeParse(outcome.result);
    if (!validated.success) {
      return {
        ok: false,
        error: makeError(
          'E_PROTOCOL_MISMATCH',
          'revoke_scope plugin result did not match the protocol result schema.',
          validated.error.issues,
        ),
      };
    }
    if (SCOPE_STATES_STILL_GRANTING.includes(validated.data.state)) {
      return {
        ok: false,
        error: makeError(
          'E_PROTOCOL_MISMATCH',
          `revoke_scope was acknowledged with scope state "${validated.data.state}", which still grants access.`,
          { state: validated.data.state },
        ),
      };
    }
    // A late answer belonging to a session that has already ended clears
    // nothing: the session that replaced it has its own unknown scope state.
    if (session !== this.#scopeSession) {
      return {
        ok: false,
        error: makeError(
          'E_PLUGIN_NOT_CONNECTED',
          'The plugin session ended before its scoped-directory revocation was acknowledged.',
        ),
      };
    }
    this.#scopeCleared = true;
    // Recorded here rather than on #pluginInfo, which mirrors what the plugin
    // reports through scope_changed events and must not be overwritten.
    this.#scopeClearedStatus = validated.data;
    return outcome;
  }

  #relay(command: string, params: unknown, timeoutMs?: number, requestId?: string): Promise<BridgeRequestResult> {
    const active = this.#active;
    if (active === null || active.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        error: makeError('E_PLUGIN_NOT_CONNECTED', 'Blockbench plugin is not connected.'),
      });
    }
    const id = requestId ?? randomUUID();
    const timeout = timeoutMs ?? this.#options.requestTimeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const spec = command in COMMAND_SPECS ? COMMAND_SPECS[command as keyof typeof COMMAND_SPECS] : undefined;
        const details = spec?.mutates
          ? {
              execution_state: 'unknown',
              retry: 'Do not retry automatically; the plugin may have completed the command.',
              reconciliation: this.#reconciliationFor(command),
            }
          : undefined;
        resolve({
          ok: false,
          error: makeError('E_TIMEOUT', `The plugin did not answer within ${timeout} ms (command ${command}).`, details),
        });
      }, timeout);
      this.#pending.set(id, { resolve, timer });
      try {
        active.send(JSON.stringify({ type: 'request', id, command, params }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve({ ok: false, error: makeError('E_PLUGIN_NOT_CONNECTED', 'Plugin disconnected before the request could be sent.') });
        this.#detachActive('request send failed');
      }
    });
  }

  #handleConnection(socket: WebSocket): void {
    this.#sockets.add(socket);
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        socket.close(CLOSE_CODES.handshakeTimeout, 'handshake_timeout');
      }
    }, this.#options.handshakeTimeoutMs);
    this.#handshakeTimers.set(socket, handshakeTimer);

    socket.on('message', (data: RawData) => {
      if (!authenticated) {
        const hello = this.#parseHello(data);
        if (hello === null) {
          clearTimeout(handshakeTimer);
          socket.close(CLOSE_CODES.invalidHandshake, 'invalid_handshake');
          return;
        }
        if (hello.protocol_version !== PROTOCOL_VERSION) {
          clearTimeout(handshakeTimer);
          socket.close(CLOSE_CODES.protocolMismatch, 'protocol_mismatch');
          return;
        }
        if (!secretsMatch(this.#options.secret!, hello.secret)) {
          clearTimeout(handshakeTimer);
          this.#options.log('Rejected a plugin connection: shared secret mismatch.');
          socket.close(CLOSE_CODES.authFailed, 'auth_failed');
          return;
        }
        if (this.#active !== null) {
          clearTimeout(handshakeTimer);
          this.#options.log('Rejected an additional plugin connection: a session is already active.');
          socket.close(CLOSE_CODES.sessionExists, 'session_exists');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          // A queued hello can arrive after this socket was already closed
          // (handshake timeout or an earlier rejection); it must not take the lock.
          clearTimeout(handshakeTimer);
          return;
        }
        // Authentication succeeded: this connection becomes the active session.
        authenticated = true;
        clearTimeout(handshakeTimer);
        this.#active = socket;
        this.#pluginInfo = {
          plugin_version: hello.plugin_version,
          blockbench_version: hello.blockbench_version,
          capabilities: hello.capabilities,
          scope: null,
        };
        if (!this.#send(socket,
          JSON.stringify({
            type: 'hello_ack',
            protocol_version: PROTOCOL_VERSION,
            heartbeat_interval_ms: this.#options.heartbeatIntervalMs,
            capabilities: ['java_block', 'geckolib_model'],
          }),
        )) return;
        this.#scopeSession += 1;
        this.#scopeCleared = false;
        this.#scopeResetInFlight = null;
        this.#startHeartbeat(socket);
        // Start clearing immediately rather than waiting for the first command,
        // so an idle adapter does not sit attached to a directory it inherited.
        void this.revokeScope().catch(() => undefined);
        this.#options.onSessionChange?.(true);
        this.#options.log(
          `Plugin session authenticated (plugin ${hello.plugin_version}, Blockbench ${hello.blockbench_version}).`,
        );
        return;
      }
      this.#handleSessionMessage(socket, data);
    });

    socket.on('pong', () => {
      if (socket === this.#active) this.#heartbeatMisses = 0;
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.#handshakeTimers.delete(socket);
      this.#sockets.delete(socket);
      if (socket === this.#active) {
        this.#detachActive('connection closed');
      }
    });

    socket.on('error', (error) => {
      this.#options.log(`Plugin socket error: ${String(error)}`);
    });
  }

  #parseHello(data: RawData): HelloMessage | null {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return null;
    }
    const parsed = pluginToAdapterMessageSchema.safeParse(json);
    if (!parsed.success || parsed.data.type !== 'hello') return null;
    return parsed.data;
  }

  #handleSessionMessage(socket: WebSocket, data: RawData): void {
    if (socket !== this.#active) return;
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.#options.log('Dropping a malformed frame from the plugin session.');
      return;
    }
    const parsed = pluginToAdapterMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.#options.log('Dropping a frame from the plugin session that does not match the protocol.');
      return;
    }
    const message = parsed.data;
    if (message.type === 'response') {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return; // stale or unknown correlation id
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve({ ok: true, result: message.result });
      } else {
        pending.resolve({ ok: false, error: message.error });
      }
      return;
    }
    if (message.type === 'event') {
      if (message.event === 'scope_changed' && this.#pluginInfo !== null) {
        const scope = scopeStatusSchema.safeParse(message.data);
        if (scope.success) this.#pluginInfo.scope = scope.data;
      }
      return;
    }
    // A second hello on an authenticated session is a protocol violation.
    socket.close(CLOSE_CODES.invalidHandshake, 'unexpected_hello');
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#heartbeatMisses = 0;
    this.#heartbeatTimer = setInterval(() => {
      if (socket !== this.#active || socket.readyState !== WebSocket.OPEN) return;
      if (this.#heartbeatMisses >= this.#options.heartbeatMissLimit) {
        this.#options.log('Plugin session became stale (missed heartbeats); releasing the session lock.');
        socket.terminate();
        // 'close' fires asynchronously; detach immediately so tools report
        // not-connected without waiting for the TCP teardown.
        this.#detachActive('heartbeat timeout');
        return;
      }
      this.#heartbeatMisses += 1;
      socket.ping();
    }, this.#options.heartbeatIntervalMs);
  }

  #detachActive(reason: string): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    const active = this.#active;
    this.#active = null;
    this.#pluginInfo = null;
    this.#scopeSession += 1;
    this.#scopeCleared = false;
    this.#scopeResetInFlight = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: makeError('E_PLUGIN_NOT_CONNECTED', `Plugin disconnected before answering (${reason}).`),
      });
      this.#pending.delete(id);
    }
    if (active !== null && active.readyState === WebSocket.OPEN) {
      active.close(1001, 'going_away');
    }
    if (active !== null) {
      this.#options.log(`Plugin session ended (${reason}).`);
      this.#options.onSessionChange?.(false);
    }
  }

  #send(socket: WebSocket, data: string): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      socket.terminate();
      if (socket === this.#active) this.#detachActive('socket send failed');
      return false;
    }
  }

  #reconciliationFor(command: string): { command?: string; manual_check?: string } {
    if (command === 'propose_scoped_directory') return { command: 'get_plugin_status' };
    if (new Set([
      'write_files',
      'save_project',
      'open_model',
      'open_geckolib_model',
      'export_model',
      'export_geckolib_model',
      'export_geckolib_animations',
    ]).has(command)) {
      return { command: 'read_file', manual_check: 'Inspect the target path in Blockbench or on disk before retrying.' };
    }
    return { command: 'get_project_state', manual_check: 'Read back the affected objects before retrying the mutation.' };
  }
}
