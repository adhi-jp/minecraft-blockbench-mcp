import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { z } from 'zod';

import {
  COMMAND_SPECS,
  INTERNAL_COMMAND_SPECS,
  isCommandName,
  makeError,
  type CommandSpec,
  type ErrorPayload,
} from '../../shared/protocol.js';
import { WsBridge, type BridgeOptions, type BridgeRequestResult } from '../ws-bridge.js';
import {
  IPC_PROTOCOL_VERSION,
  IpcLineDecoder,
  clientToBrokerMessageSchema,
  encodeIpcMessage,
  type BrokerToClientMessage,
  type ClientHelloMessage,
  type ClientToBrokerMessage,
  type IpcRequestMessage,
  type IpcResponseMessage,
  type StatusEventMessage,
} from './ipc-protocol.js';
import { ControllerLease } from './lease.js';
import { removeBrokerRecordIfInstance } from './rendezvous.js';

type TimerHandle = unknown;

export interface BrokerServerOptions extends Omit<BridgeOptions, 'onSessionChange'> {
  endpoint: string;
  configIdentity: string;
  recordPath: string;
  instanceId?: string;
  packageVersion?: string;
  brokerPid?: number;
  leaseIdleTimeoutMs?: number;
  brokerIdleTimeoutMs?: number;
  clientHeartbeatIntervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  setInterval?: (callback: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

interface ClientConnection {
  socket: Socket;
  decoder: IpcLineDecoder<ClientToBrokerMessage>;
  registered: boolean;
  sessionId: string | null;
  clientLabel: string | null;
  heartbeatTimer: TimerHandle | null;
  missedPongs: number;
  pendingPingId: string | null;
}

function fallbackBridgeError(): ErrorPayload {
  return makeError('E_BLOCKBENCH_ERROR', 'The plugin returned an unspecified error.');
}

export class BrokerServer {
  readonly #options: Required<
    Pick<
      BrokerServerOptions,
      | 'instanceId'
      | 'packageVersion'
      | 'brokerPid'
      | 'leaseIdleTimeoutMs'
      | 'brokerIdleTimeoutMs'
      | 'clientHeartbeatIntervalMs'
    >
  > &
    BrokerServerOptions;
  readonly #bridge: WsBridge;
  readonly #lease: ControllerLease<TimerHandle>;
  readonly #ipcServer: Server;
  readonly #clients = new Set<ClientConnection>();
  readonly #sessionLabels = new Map<string, string>();
  readonly #setTimer: (callback: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  readonly #setInterval: (callback: () => void, ms: number) => TimerHandle;
  readonly #clearInterval: (handle: TimerHandle) => void;
  #laneTail: Promise<void> = Promise.resolve();
  #revocationPromise: Promise<BridgeRequestResult> | null = null;
  #idleTimer: TimerHandle | null = null;
  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  constructor(options: BrokerServerOptions) {
    this.#options = {
      ...options,
      instanceId: options.instanceId ?? randomUUID(),
      packageVersion: options.packageVersion ?? '0.1.0',
      brokerPid: options.brokerPid ?? process.pid,
      leaseIdleTimeoutMs: options.leaseIdleTimeoutMs ?? 60_000,
      brokerIdleTimeoutMs: options.brokerIdleTimeoutMs ?? 30_000,
      clientHeartbeatIntervalMs: options.clientHeartbeatIntervalMs ?? 15_000,
    };
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.#setInterval = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.#clearInterval = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

    this.#lease = new ControllerLease<TimerHandle>({
      idleTimeoutMs: this.#options.leaseIdleTimeoutMs,
      setTimer: (callback, ms) =>
        this.#setTimer(() => {
          const before = this.#lease.state;
          callback();
          if (this.#lease.state !== before) this.#broadcastStatus();
        }, ms),
      clearTimer: this.#clearTimer,
    });
    this.#bridge = new WsBridge({
      port: options.port,
      secret: options.secret,
      requestTimeoutMs: options.requestTimeoutMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      heartbeatMissLimit: options.heartbeatMissLimit,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      maxMessageBytes: options.maxMessageBytes,
      log: options.log,
      onSessionChange: (connected) => {
        try {
          void this.#handlePluginSessionChange(connected).catch(() => {
            this.#options.log('Broker could not finish a plugin session transition.');
          });
        } catch {
          this.#options.log('Broker could not start a plugin session transition.');
        }
      },
    });
    this.#ipcServer = createServer((socket) => this.#handleConnection(socket));
  }

  get listening(): boolean {
    return this.#ipcServer.listening;
  }

  get instanceId(): string {
    return this.#options.instanceId;
  }

  async start(): Promise<Awaited<ReturnType<WsBridge['start']>>> {
    if (this.#started) return { ok: true };
    if (this.#stopping) throw new Error('BrokerServer cannot be started after stop().');

    const bridgeResult = await this.#bridge.start();
    if (!bridgeResult.ok) return bridgeResult;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.#ipcServer.once('error', onError);
        this.#ipcServer.listen(this.#options.endpoint, () => {
          this.#ipcServer.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      await this.#bridge.stop();
      throw error;
    }

    this.#ipcServer.on('error', () => this.#options.log('Broker IPC listener reported an error.'));
    this.#started = true;
    this.#scheduleIdleShutdown();
    return { ok: true };
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    this.#cancelIdleShutdown();
    const ipcClosed = this.#closeIpcListener();

    await this.#laneTail;
    if (this.#lease.state === 'owned' && this.#lease.ownerSessionId !== null) {
      this.#lease.ownerDisconnected(this.#lease.ownerSessionId);
    }
    if (this.#bridge.connected) {
      await this.#enqueueLane(() => this.#bridge.request('revoke_scope', {}, 5_000)).catch(() => undefined);
    }
    await this.#bridge.stop();

    const bye = encodeIpcMessage({ type: 'bye' });
    for (const client of this.#clients) {
      this.#clearClientHeartbeat(client);
      client.registered = false;
      if (!client.socket.destroyed) {
        client.socket.end(bye, () => client.socket.destroy());
      }
    }
    this.#clients.clear();

    await removeBrokerRecordIfInstance(this.#options.recordPath, this.#options.instanceId);
    await ipcClosed;
    this.#started = false;
  }

  #closeIpcListener(): Promise<void> {
    if (!this.#ipcServer.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ipcServer.close(() => resolve());
    });
  }

  #handleConnection(socket: Socket): void {
    if (this.#stopping) {
      socket.destroy();
      return;
    }

    const client: ClientConnection = {
      socket,
      decoder: new IpcLineDecoder<ClientToBrokerMessage>(
        clientToBrokerMessageSchema as z.ZodType<ClientToBrokerMessage>,
      ),
      registered: false,
      sessionId: null,
      clientLabel: null,
      heartbeatTimer: null,
      missedPongs: 0,
      pendingPingId: null,
    };
    this.#clients.add(client);

    socket.on('data', (chunk) => {
      for (const decoded of client.decoder.push(chunk)) {
        if (decoded.kind === 'reject') {
          socket.destroy();
          return;
        }
        this.#handleClientMessage(client, decoded.message);
      }
    });
    socket.on('close', () => this.#deregisterClient(client, 'disconnect'));
    socket.on('error', () => undefined);
  }

  #handleClientMessage(client: ClientConnection, message: ClientToBrokerMessage): void {
    if (!client.registered) {
      if (message.type !== 'client_hello') {
        client.socket.destroy();
        return;
      }
      this.#registerClient(client, message);
      return;
    }

    if (message.type === 'pong') {
      if (message.id === client.pendingPingId) {
        client.pendingPingId = null;
        client.missedPongs = 0;
      }
      return;
    }
    if (message.type === 'bye') {
      this.#deregisterClient(client, 'disconnect');
      client.socket.end();
      return;
    }
    if (message.type === 'request') {
      if (this.#stopping) {
        this.#sendResponse(client, {
          type: 'response',
          id: message.id,
          ok: false,
          error: makeError('E_BROKER_UNAVAILABLE', 'Broker is shutting down.'),
        });
        return;
      }
      void this.#handleRequest(client, message).catch(() => {
        this.#sendResponse(client, {
          type: 'response',
          id: message.id,
          ok: false,
          error: makeError('E_BROKER_UNAVAILABLE', 'Broker could not complete the request.'),
        });
      });
      return;
    }

    client.socket.destroy();
  }

  #registerClient(client: ClientConnection, hello: ClientHelloMessage): void {
    if (hello.ipc_protocol_version !== IPC_PROTOCOL_VERSION) {
      this.#rejectHello(client, 'version_mismatch');
      return;
    }
    if (hello.config_identity !== this.#options.configIdentity) {
      this.#rejectHello(client, 'identity_mismatch');
      return;
    }

    client.registered = true;
    client.sessionId = hello.session_id;
    client.clientLabel = hello.client_label;
    this.#sessionLabels.set(hello.session_id, hello.client_label);
    this.#cancelIdleShutdown();
    this.#startClientHeartbeat(client);
    this.#send(client, {
      type: 'hello_ack',
      ipc_protocol_version: IPC_PROTOCOL_VERSION,
      package_version: this.#options.packageVersion,
      broker_instance_id: this.#options.instanceId,
      broker_pid: this.#options.brokerPid,
      effective_port: this.#options.port,
    });
    this.#broadcastStatus();
  }

  #rejectHello(client: ClientConnection, reason: 'version_mismatch' | 'identity_mismatch'): void {
    this.#send(client, {
      type: 'hello_reject',
      reason,
      ipc_protocol_version: IPC_PROTOCOL_VERSION,
      package_version: this.#options.packageVersion,
    });
    client.socket.end();
  }

  async #handleRequest(client: ClientConnection, request: IpcRequestMessage): Promise<void> {
    const sessionId = client.sessionId;
    if (!client.registered || sessionId === null) return;
    const command = request.command;
    if (!isCommandName(command)) {
      this.#sendResponse(client, {
        type: 'response',
        id: request.id,
        ok: false,
        error: makeError('E_UNSUPPORTED_COMMAND', `Unsupported command: ${command}.`),
      });
      return;
    }
    const commandSpec = COMMAND_SPECS[command] as CommandSpec;

    const beforeAcquire = this.#lease.state;
    const acquisition = this.#lease.acquire(sessionId);
    if (this.#lease.state !== beforeAcquire) this.#broadcastStatus();
    if (acquisition.outcome === 'busy') {
      const owner = this.#sessionLabels.get(acquisition.owner) ?? 'another client';
      this.#sendResponse(client, {
        type: 'response',
        id: request.id,
        ok: false,
        error: makeError('E_CLIENT_BUSY', 'Another client currently controls the plugin session.', { owner }),
      });
      return;
    }
    if (acquisition.outcome === 'revocation_required') {
      const revocation = await this.#runRevocation();
      if (!revocation.ok) {
        this.#sendResponse(client, {
          type: 'response',
          id: request.id,
          ok: false,
          error: revocation.error ?? fallbackBridgeError(),
        });
        return;
      }
    }

    const outcome = await this.#enqueueLane(async () => {
      if (!client.registered || !this.#clients.has(client)) {
        const beforeRelease = this.#lease.state;
        if (
          this.#lease.state === 'owned' &&
          this.#lease.ownerSessionId === sessionId &&
          !this.#lease.inFlightRequest
        ) {
          this.#lease.ownerDisconnected(sessionId);
        }
        if (this.#lease.state !== beforeRelease) this.#broadcastStatus();
        return {
          ok: false,
          error: makeError('E_BROKER_UNAVAILABLE', 'The client disconnected before execution.'),
        } satisfies BridgeRequestResult;
      }
      if (this.#lease.state !== 'owned' || this.#lease.ownerSessionId !== sessionId) {
        return {
          ok: false,
          error: makeError('E_BROKER_UNAVAILABLE', 'The client lost controller ownership before execution.'),
        } satisfies BridgeRequestResult;
      }
      this.#lease.requestStarted(sessionId);
      try {
        return await this.#bridge.request(
          command,
          request.params,
          commandSpec.timeoutMs,
        );
      } finally {
        const beforeFinish = this.#lease.state;
        if (
          this.#lease.ownerSessionId === sessionId &&
          this.#lease.inFlightRequest &&
          (this.#lease.state === 'owned' || this.#lease.state === 'releasing')
        ) {
          this.#lease.requestFinished(sessionId);
        }
        if (this.#lease.state !== beforeFinish) this.#broadcastStatus();
      }
    });

    this.#sendResponse(client, {
      type: 'response',
      id: request.id,
      ok: outcome.ok,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.error ?? fallbackBridgeError() }),
    });
  }

  async #runRevocation(): Promise<BridgeRequestResult> {
    if (this.#revocationPromise !== null) return this.#revocationPromise;
    if (!this.#bridge.connected) {
      if (this.#lease.state === 'recovering') this.#lease.revocationResolved(false);
      return {
        ok: false,
        error: makeError('E_PLUGIN_NOT_CONNECTED', 'Blockbench plugin is not connected.'),
      };
    }

    const running = this.#enqueueLane(() => this.#bridge.request('revoke_scope', {}, 10_000)).then((outcome) => {
      let resolved = outcome;
      if (outcome.ok) {
        const validated = INTERNAL_COMMAND_SPECS.revoke_scope.result.safeParse(outcome.result);
        if (!validated.success) {
          resolved = {
            ok: false,
            error: makeError(
              'E_PROTOCOL_MISMATCH',
              'revoke_scope plugin result did not match the protocol result schema.',
              validated.error.issues,
            ),
          };
        }
      }
      if (this.#lease.state === 'recovering') {
        const before = this.#lease.state;
        this.#lease.revocationResolved(resolved.ok);
        if (this.#lease.state !== before) this.#broadcastStatus();
      }
      return resolved;
    });
    this.#revocationPromise = running;
    try {
      return await running;
    } finally {
      if (this.#revocationPromise === running) this.#revocationPromise = null;
    }
  }

  async #handlePluginSessionChange(connected: boolean): Promise<void> {
    if (connected) {
      this.#lease.pluginAuthenticated();
    } else {
      this.#lease.pluginDisconnected();
    }
    this.#broadcastStatus();

    if (connected && this.#lease.tainted && !this.#stopping) {
      await this.#runRevocation();
    }
  }

  #enqueueLane<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.#laneTail.then(operation, operation);
    this.#laneTail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  #startClientHeartbeat(client: ClientConnection): void {
    client.heartbeatTimer = this.#setInterval(() => {
      if (!client.registered || client.socket.destroyed) return;
      if (client.missedPongs >= 2) {
        this.#deregisterClient(client, 'heartbeat');
        client.socket.destroy();
        return;
      }
      const id = randomUUID();
      client.pendingPingId = id;
      client.missedPongs += 1;
      this.#send(client, { type: 'ping', id });
    }, this.#options.clientHeartbeatIntervalMs);
  }

  #clearClientHeartbeat(client: ClientConnection): void {
    if (client.heartbeatTimer !== null) {
      this.#clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
  }

  #deregisterClient(client: ClientConnection, reason: 'disconnect' | 'heartbeat'): void {
    if (!this.#clients.has(client)) return;
    this.#clients.delete(client);
    this.#clearClientHeartbeat(client);
    const wasRegistered = client.registered;
    const sessionId = client.sessionId;
    client.registered = false;

    if (
      wasRegistered &&
      sessionId !== null &&
      this.#lease.state === 'recovering' &&
      this.#lease.snapshot().pendingAcquirerSessionId === sessionId
    ) {
      this.#lease.acquirerDisconnected(sessionId);
    }
    if (
      wasRegistered &&
      sessionId !== null &&
      this.#lease.state === 'owned' &&
      this.#lease.ownerSessionId === sessionId
    ) {
      if (reason === 'heartbeat') this.#lease.heartbeatExpired(sessionId);
      else this.#lease.ownerDisconnected(sessionId);
    }
    if (wasRegistered) {
      this.#broadcastStatus();
      if (this.#registeredClientCount() === 0) this.#scheduleIdleShutdown();
    }
  }

  #scheduleIdleShutdown(): void {
    if (this.#stopping || this.#idleTimer !== null) return;
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = null;
      void this.stop().catch(() => this.#options.log('Broker idle shutdown did not finish cleanly.'));
    }, this.#options.brokerIdleTimeoutMs);
  }

  #cancelIdleShutdown(): void {
    if (this.#idleTimer !== null) {
      this.#clearTimer(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #registeredClientCount(): number {
    let count = 0;
    for (const client of this.#clients) {
      if (client.registered) count += 1;
    }
    return count;
  }

  #status(): StatusEventMessage {
    const ownerSessionId = this.#lease.ownerSessionId;
    return {
      type: 'status_event',
      plugin_connected: this.#bridge.connected,
      plugin_info: this.#bridge.pluginInfo,
      controller_state: this.#lease.state,
      controller_owner: ownerSessionId === null ? null : (this.#sessionLabels.get(ownerSessionId) ?? null),
      client_count: this.#registeredClientCount(),
      effective_port: this.#options.port,
    };
  }

  #broadcastStatus(): void {
    const status = this.#status();
    for (const client of this.#clients) {
      if (client.registered) this.#send(client, status);
    }
  }

  #sendResponse(client: ClientConnection, response: IpcResponseMessage): void {
    if (client.registered) this.#send(client, response);
  }

  #send(client: ClientConnection, message: BrokerToClientMessage): void {
    if (client.socket.destroyed) return;
    try {
      client.socket.write(encodeIpcMessage(message));
    } catch {
      client.socket.destroy();
    }
  }
}
