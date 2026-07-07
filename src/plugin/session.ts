// Plugin-side WebSocket session core. Browser-safe (no Node builtins): the
// WebSocket implementation is injected so this module runs unchanged inside
// the Blockbench renderer and inside Node tests.
import {
  PROTOCOL_VERSION,
  adapterToPluginMessageSchema,
  makeError,
  type ErrorCode,
  type ErrorPayload,
} from '../shared/protocol.js';

/** Browser-style WebSocket surface (the `ws` package implements it too).
 * Handler parameters are typed loosely because DOM and `ws` event object
 * types differ; the session only reads `event.data` and `event.code`. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'auth_failed'
  | 'waiting_retry'
  | 'stopped';

/** Thrown by command handlers to produce a structured plugin rejection. */
export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return makeError(this.code, this.message, this.details);
  }
}

export type CommandHandler = (params: unknown) => Promise<unknown> | unknown;

export interface SessionOptions {
  createWebSocket: WebSocketFactory;
  url: () => string;
  secret: () => string;
  pluginVersion: string;
  blockbenchVersion: () => string;
  capabilities: string[];
  /** Reconnect backoff bounds; the delay doubles per attempt up to max. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  onStatusChange?: (status: SessionStatus, detail?: string) => void;
  onLog?: (line: string) => void;
}

const AUTH_CLOSE_CODES = new Set([4401, 4426]);

export class PluginSession {
  readonly #options: SessionOptions;
  readonly #handlers = new Map<string, CommandHandler>();
  #socket: WebSocketLike | null = null;
  #status: SessionStatus = 'idle';
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs: number;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#backoffMs = options.backoffInitialMs ?? 1_000;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  registerHandler(command: string, handler: CommandHandler): void {
    this.#handlers.set(command, handler);
  }

  start(): void {
    if (this.#socket !== null || this.#retryTimer !== null) return; // already running
    this.#stopped = false;
    this.#connect();
  }

  /** Clean shutdown: closes the socket and disables reconnection. */
  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState === WS_OPEN) {
      socket.close(1000, 'plugin_unload');
    }
    this.#setStatus('stopped');
  }

  /** Send a fire-and-forget event to the adapter (e.g. scope_changed). */
  sendEvent(event: string, data?: unknown): void {
    const socket = this.#socket;
    if (this.#status === 'connected' && socket !== null && socket.readyState === WS_OPEN) {
      socket.send(JSON.stringify({ type: 'event', event, data }));
    }
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    this.#status = status;
    this.#options.onStatusChange?.(status, detail);
  }

  #log(line: string): void {
    this.#options.onLog?.(line);
  }

  #connect(): void {
    if (this.#stopped) return;
    const secret = this.#options.secret();
    if (secret === '') {
      this.#setStatus('auth_failed', 'secret_not_configured');
      this.#log('No shared secret configured in the plugin settings; not connecting.');
      this.#scheduleRetry(true);
      return;
    }
    this.#setStatus('connecting');
    let socket: WebSocketLike;
    try {
      socket = this.#options.createWebSocket(this.#options.url());
    } catch (error) {
      this.#log(`WebSocket creation failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#scheduleRetry(false);
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#setStatus('authenticating');
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol_version: PROTOCOL_VERSION,
          secret: this.#options.secret(),
          plugin_version: this.#options.pluginVersion,
          blockbench_version: this.#options.blockbenchVersion(),
          capabilities: this.#options.capabilities,
        }),
      );
    };

    socket.onmessage = (event: { data: unknown }) => {
      void this.#handleMessage(socket, String(event.data));
    };

    socket.onclose = (event: { code: number }) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      const authFailure = AUTH_CLOSE_CODES.has(event.code);
      if (authFailure) {
        this.#setStatus('auth_failed', `close_${event.code}`);
        this.#log(`The adapter rejected this session (close code ${event.code}). Check the port and secret settings.`);
      }
      this.#scheduleRetry(authFailure);
    };

    socket.onerror = () => {
      // The close handler drives retry; onerror alone is informational.
      this.#log('WebSocket error.');
    };
  }

  #scheduleRetry(useMaxBackoff: boolean): void {
    if (this.#stopped) return;
    const max = this.#options.backoffMaxMs ?? 30_000;
    const delay = useMaxBackoff ? max : this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, max);
    if (this.#status !== 'auth_failed') this.#setStatus('waiting_retry', `${delay}ms`);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
  }

  async #handleMessage(socket: WebSocketLike, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.#log('Dropping a malformed frame from the adapter.');
      return;
    }
    const parsed = adapterToPluginMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.#log('Dropping a frame from the adapter that does not match the protocol.');
      return;
    }
    const message = parsed.data;

    if (message.type === 'hello_ack') {
      this.#backoffMs = this.#options.backoffInitialMs ?? 1_000;
      this.#setStatus('connected');
      this.#log('Authenticated with the MCP adapter.');
      return;
    }

    // request
    let response: { type: 'response'; id: string; ok: boolean; result?: unknown; error?: ErrorPayload };
    const handler = this.#handlers.get(message.command);
    if (handler === undefined) {
      response = {
        type: 'response',
        id: message.id,
        ok: false,
        error: makeError('E_UNSUPPORTED_COMMAND', `This plugin does not support the command "${message.command}".`),
      };
    } else {
      try {
        const result = await handler(message.params);
        response = { type: 'response', id: message.id, ok: true, result };
      } catch (error) {
        const payload =
          error instanceof CommandError
            ? error.toPayload()
            : makeError(
                'E_BLOCKBENCH_ERROR',
                `Command "${message.command}" failed inside Blockbench: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
        response = { type: 'response', id: message.id, ok: false, error: payload };
      }
    }
    if (socket.readyState === WS_OPEN) {
      socket.send(JSON.stringify(response));
    }
  }
}
