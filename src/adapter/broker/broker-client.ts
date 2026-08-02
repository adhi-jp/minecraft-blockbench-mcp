import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import { z } from 'zod';

import { makeError } from '../../shared/protocol.js';
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
    await this.close();
    this.#status = null;
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

  async request(command: string, params: unknown, timeoutMs?: number): Promise<BridgeRequestResult> {
    if (!this.listening) await this.#attemptReattach();
    const socket = this.#socket;
    if (!this.listening || socket === null) return this.#brokerUnavailable();

    const id = randomUUID();
    const response = new Promise<BridgeRequestResult>((resolve) => {
      this.#pending.set(id, { resolve });
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
      this.#pending.delete(id);
      socket.destroy();
      return this.#brokerUnavailable();
    }
    return response;
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === null) {
      this.#rejectHandshake(new Error('Broker client closed.'));
      this.#resolvePendingUnavailable();
      return;
    }

    this.#socket = null;
    this.#decoder = null;
    this.#rejectHandshake(new Error('Broker client closed.'));
    this.#resolvePendingUnavailable();
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.end(encodeIpcMessage({ type: 'bye' }), () => socket.destroy());
    });
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
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    pending.resolve(
      message.ok
        ? { ok: true, result: message.result }
        : { ok: false, error: message.error ?? makeError('E_BROKER_UNAVAILABLE', 'Broker response was incomplete.') },
    );
  }

  #markDisconnected(socket: Socket): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#decoder = null;
    this.#rejectHandshake(new Error('Broker disconnected during the hello handshake.'));
    this.#resolvePendingUnavailable();
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
