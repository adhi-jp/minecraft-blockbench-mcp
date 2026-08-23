import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import { z } from 'zod';

import { makeError } from '../../shared/protocol.js';
import { RequestCancelledError, type RequestCancellationStage } from '../request-cancellation.js';
import type { BridgeRequestResult, PluginInfo } from '../ws-bridge.js';
import {
  IpcLineDecoder,
  brokerToClientMessageSchema,
  encodeIpcMessage,
  type BrokerToClientMessage,
  type ClientHelloMessage,
  type HelloAckMessage,
  type HelloRejectMessage,
  type IpcResponseMessage,
  type StatusEventMessage,
} from './ipc-protocol.js';

export type BrokerClientHello = Omit<ClientHelloMessage, 'type'> | ClientHelloMessage;

export interface BrokerReattachTarget {
  endpoint: string;
  hello: BrokerClientHello;
}

export interface BrokerClientOptions {
  reattach?: (client: BrokerClient) => Promise<unknown> | unknown;
  connectTimeoutMs?: number;
}

interface PendingResponse {
  resolve: (outcome: BridgeRequestResult) => void;
  reject: (error: Error) => void;
  detachSignal: () => void;
}

interface PendingHandshake {
  socket: Socket;
  resolve: (ack: HelloAckMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrokerHandshakeError extends Error {
  constructor(readonly reason: HelloRejectMessage['reason']) {
    super(`Broker rejected the client hello: ${reason}.`);
    this.name = 'BrokerHandshakeError';
  }
}

/**
 * Raised instead of a result when the caller withdrew a request through the
 * `signal` it passed to `request()`. `stage` says how far the request had
 * travelled, which is all this side can honestly know:
 *
 * - `before_send`: nothing was written to the broker, so the request was never
 *   enqueued and the plugin can never see it.
 * - `after_send`: the request reached the broker and a `cancel_request` naming
 *   its internal UUID was written. Whether the broker had already relayed it to
 *   the plugin is deliberately not reported here; a relayed command may have
 *   executed, is never rolled back, and is never replayed.
 */
export class BrokerRequestCancelledError extends RequestCancelledError {
  constructor(requestId: string, stage: RequestCancellationStage) {
    super(requestId, stage, `Broker request ${requestId} was cancelled by the caller (${stage}).`);
    this.name = 'BrokerRequestCancelledError';
  }
}

export class BrokerClient {
  readonly #options: Required<Pick<BrokerClientOptions, 'connectTimeoutMs'>> & BrokerClientOptions;
  readonly #pending = new Map<string, PendingResponse>();
  #socket: Socket | null = null;
  #decoder: IpcLineDecoder<BrokerToClientMessage> | null = null;
  #status: StatusEventMessage | null = null;
  #handshake: PendingHandshake | null = null;
  #reattachPromise: Promise<void> | null = null;

  constructor(options: BrokerClientOptions = {}) {
    this.#options = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
    };
  }

  get connected(): boolean {
    return this.listening && this.#status?.plugin_connected === true;
  }

  get listening(): boolean {
    const socket = this.#socket;
    return socket !== null && !socket.destroyed && socket.readyState === 'open';
  }

  get pluginInfo(): PluginInfo | null {
    return (this.#status?.plugin_info as PluginInfo | null | undefined) ?? null;
  }

  brokerStatus(): StatusEventMessage | null {
    return this.#status;
  }

  async connect(endpoint: string, helloFields: BrokerClientHello): Promise<HelloAckMessage> {
    await this.#closeConnection(new Error('Broker client reconnecting.'));
    const socket = createConnection(endpoint);
    const decoder = new IpcLineDecoder<BrokerToClientMessage>(
      brokerToClientMessageSchema as z.ZodType<BrokerToClientMessage>,
    );
    this.#socket = socket;
    this.#decoder = decoder;

    socket.on('data', (chunk) => {
      if (socket !== this.#socket || decoder !== this.#decoder) return;
      for (const decoded of decoder.push(chunk)) {
        if (decoded.kind === 'reject') {
          socket.destroy();
          return;
        }
        this.#handleBrokerMessage(socket, decoded.message);
      }
    });
    socket.on('close', () => this.#markDisconnected(socket));
    socket.on('error', () => undefined);

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onConnectError);
        resolve();
      };
      const onConnectError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onConnectError);
    }).catch((error) => {
      this.#markDisconnected(socket);
      throw error;
    });

    const hello: ClientHelloMessage = {
      ...helloFields,
      type: 'client_hello',
    };
    const acknowledgement = new Promise<HelloAckMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#handshake?.socket === socket) this.#handshake = null;
        socket.destroy();
        reject(new Error('Timed out waiting for broker hello_ack.'));
      }, this.#options.connectTimeoutMs);
      this.#handshake = { socket, resolve, reject, timer };
    });
    socket.write(encodeIpcMessage(hello));
    return acknowledgement;
  }

  /**
   * Relay one command through the broker.
   *
   * `signal` withdraws the request. The internal UUID allocated here is the only
   * identity the broker ever sees for it, so cancellation cannot be aimed at
   * another shim's request even when two shims reuse the same outer JSON-RPC id.
   * A withdrawn request rejects with `BrokerRequestCancelledError` and never
   * resolves to a result, so no late outcome can reach the caller.
   */
  async request(
    command: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BridgeRequestResult> {
    const id = randomUUID();
    const cancelled = (): boolean => signal !== undefined && signal.aborted;
    if (cancelled()) throw new BrokerRequestCancelledError(id, 'before_send');

    if (!this.listening) await this.#attemptReattach();
    const socket = this.#socket;
    if (!this.listening || socket === null) return this.#brokerUnavailable();
    // Reattaching can await; re-check before writing so a request cancelled
    // during that wait is still never enqueued.
    if (cancelled()) throw new BrokerRequestCancelledError(id, 'before_send');

    let detachSignal = (): void => undefined;
    const response = new Promise<BridgeRequestResult>((resolve, reject) => {
      if (signal !== undefined) {
        const onAbort = () => {
          if (!this.#pending.delete(id)) return;
          this.#sendCancel(id);
          reject(new BrokerRequestCancelledError(id, 'after_send'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detachSignal = () => signal.removeEventListener('abort', onAbort);
      }
      this.#pending.set(id, { resolve, reject, detachSignal });
    });
    try {
      socket.write(
        encodeIpcMessage(
          {
            type: 'request',
            id,
            command,
            params,
            ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
          } as Parameters<typeof encodeIpcMessage>[0],
        ),
      );
    } catch {
      this.#discardPending(id);
      socket.destroy();
      return this.#brokerUnavailable();
    }
    return response;
  }

  #sendCancel(id: string): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return;
    try {
      socket.write(encodeIpcMessage({ type: 'cancel_request', id }));
    } catch {
      // A broker that cannot receive the withdrawal is already gone; its queue
      // dies with it, so there is nothing left to tombstone.
    }
  }

  #discardPending(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.detachSignal();
  }

  async close(): Promise<void> {
    await this.#closeConnection(new Error('Broker client closed.'));
  }

  #handleBrokerMessage(socket: Socket, message: BrokerToClientMessage): void {
    if (message.type === 'hello_ack') {
      const handshake = this.#handshake;
      if (handshake?.socket !== socket) return;
      this.#handshake = null;
      clearTimeout(handshake.timer);
      handshake.resolve(message);
      return;
    }
    if (message.type === 'hello_reject') {
      const handshake = this.#handshake;
      if (handshake?.socket === socket) {
        this.#handshake = null;
        clearTimeout(handshake.timer);
        handshake.reject(new BrokerHandshakeError(message.reason));
      }
      socket.end();
      return;
    }
    if (message.type === 'status_event') {
      this.#status = message;
      return;
    }
    if (message.type === 'response') {
      this.#resolveResponse(message);
      return;
    }
    if (message.type === 'ping') {
      if (!socket.destroyed) socket.write(encodeIpcMessage({ type: 'pong', id: message.id }));
      return;
    }
    if (message.type === 'bye') {
      socket.end();
    }
  }

  #resolveResponse(message: IpcResponseMessage): void {
    const pending = this.#pending.get(message.id);
    // A response for an unknown id is late, withdrawn, or already terminal.
    // Dropping it keeps one request to exactly one outcome.
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    pending.detachSignal();
    pending.resolve(
      message.ok
        ? { ok: true, result: message.result }
        : { ok: false, error: message.error ?? makeError('E_BROKER_UNAVAILABLE', 'Broker response was incomplete.') },
    );
  }

  #markDisconnected(socket: Socket): void {
    if (socket !== this.#socket) return;
    this.#resetConnection(new Error('Broker disconnected during the hello handshake.'));
  }

  async #closeConnection(error: Error): Promise<void> {
    const socket = this.#resetConnection(error);
    if (socket === null || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.end(encodeIpcMessage({ type: 'bye' }), () => socket.destroy());
    });
  }

  #resetConnection(error: Error): Socket | null {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#status = null;
    this.#rejectHandshake(error);
    this.#resolvePendingUnavailable();
    return socket;
  }

  #rejectHandshake(error: Error): void {
    const handshake = this.#handshake;
    if (handshake === null) return;
    this.#handshake = null;
    clearTimeout(handshake.timer);
    handshake.reject(error);
  }

  #resolvePendingUnavailable(): void {
    const unavailable = this.#brokerUnavailable();
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.detachSignal();
      pending.resolve(unavailable);
    }
  }

  async #attemptReattach(): Promise<void> {
    if (this.listening || this.#options.reattach === undefined) return;
    if (this.#reattachPromise !== null) return this.#reattachPromise;

    const running = (async () => {
      try {
        const target = await this.#options.reattach!(this);
        if (this.listening) return;
        if (this.#isReattachTarget(target)) await this.connect(target.endpoint, target.hello);
      } catch {
        // request() returns the stable broker-unavailable outcome below.
      }
    })();
    this.#reattachPromise = running;
    try {
      await running;
    } finally {
      if (this.#reattachPromise === running) this.#reattachPromise = null;
    }
  }

  #isReattachTarget(value: unknown): value is BrokerReattachTarget {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { endpoint?: unknown }).endpoint === 'string' &&
      typeof (value as { hello?: unknown }).hello === 'object' &&
      (value as { hello?: unknown }).hello !== null
    );
  }

  #brokerUnavailable(): BridgeRequestResult {
    return {
      ok: false,
      error: makeError('E_BROKER_UNAVAILABLE', 'Broker IPC connection is unavailable.'),
    };
  }
}
