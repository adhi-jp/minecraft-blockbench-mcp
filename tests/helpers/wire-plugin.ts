// A Blockbench plugin stand-in for tests that drive the built stdio executable
// over raw newline-delimited JSON-RPC.
//
// The adapter owns the WebSocket listener, so this connects to it the way the
// shipped plugin does: `hello`, then answer `request` frames. What makes it
// useful for cancellation and finality work is that it can *hold* a command --
// record that the adapter relayed it and then deliberately never answer -- so a
// test can put a request in a known state and act on it while it sits there.
//
// Every answer carries a caller-chosen marker in `counts.cubes`, which is how a
// test proves that a particular plugin answer reached a particular MCP request
// rather than merely that some answer arrived.
import WebSocket from 'ws';

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';

/** One `request` frame the adapter relayed to this plugin. */
export interface RelayedFrame {
  /** The adapter's internal request UUID. Never a client's JSON-RPC id. */
  id: string;
  command: string;
  params: unknown;
  /** Arrival order across every connection this plugin has made. */
  sequence: number;
  /** Which connection carried it; 1 for the first, incrementing on reconnect. */
  connection: number;
}

export interface WireFakePluginOptions {
  port: number;
  secret: string;
  /**
   * Commands recorded but deliberately left unanswered until
   * `release(command)` runs. `revoke_scope` may be held too, which is the one
   * dependable window in which a public command is inside the adapter but has
   * not been relayed to Blockbench yet.
   */
  hold?: readonly string[];
}

interface HeldFrame {
  socket: WebSocket;
  frame: RelayedFrame;
}

const PROJECT_STATE_FORMAT = 'java_block';

/** A `get_project_state` result carrying `marker` where a test can see it. */
export function projectStateResult(marker: number): Record<string, unknown> {
  return {
    open: true,
    format: PROJECT_STATE_FORMAT,
    counts: { cubes: marker, groups: 0, textures: 0 },
  };
}

export class WireFakePlugin {
  readonly frames: RelayedFrame[] = [];
  #socket: WebSocket | null = null;
  #sockets = new Set<WebSocket>();
  #held: HeldFrame[] = [];
  #hold: Set<string>;
  #sequence = 0;
  #connection = 0;
  #nextMarker = 1;
  #closing = false;

  constructor(private readonly options: WireFakePluginOptions) {
    this.#hold = new Set(options.hold ?? []);
  }

  /** Commands this plugin currently records without answering. */
  hold(command: string): void {
    this.#hold.add(command);
  }

  /** Stop holding `command`; every frame already held for it is answered now. */
  release(command: string): void {
    this.#hold.delete(command);
    const releasable = this.#held.filter((entry) => entry.frame.command === command);
    this.#held = this.#held.filter((entry) => entry.frame.command !== command);
    for (const entry of releasable) this.#answerDefault(entry.socket, entry.frame);
  }

  /** Frames recorded for `command`, in arrival order. */
  requests(command: string): RelayedFrame[] {
    return this.frames.filter((frame) => frame.command === command);
  }

  /** Frames recorded for `command` that are still unanswered. */
  heldRequests(command: string): RelayedFrame[] {
    return this.#held.filter((entry) => entry.frame.command === command).map((entry) => entry.frame);
  }

  /**
   * Answer one recorded frame explicitly, on the connection that carried it.
   * Used to send an answer late, or to send a second answer for a frame that
   * was already answered, which is how "a late or duplicate plugin response
   * cannot satisfy another request" gets its proof.
   */
  answer(frame: RelayedFrame, payload: { ok: true; result: unknown } | { ok: false; error: unknown }): void {
    const entry = this.#held.find((held) => held.frame.id === frame.id);
    const socket = entry?.socket ?? this.#socket;
    if (socket === null || socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`No open plugin connection to answer request ${frame.id} on.`);
    }
    this.#held = this.#held.filter((held) => held.frame.id !== frame.id);
    socket.send(JSON.stringify({ type: 'response', id: frame.id, ...payload }));
  }

  /** The marker the next default answer will carry. */
  peekNextMarker(): number {
    return this.#nextMarker;
  }

  async connect(): Promise<void> {
    const connection = ++this.#connection;
    const socket = new WebSocket(`ws://127.0.0.1:${this.options.port}`);
    this.#socket = socket;
    this.#sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      if (this.#socket === socket) this.#socket = null;
      this.#held = this.#held.filter((entry) => entry.socket !== socket);
    });

    let acknowledged: () => void;
    const helloAck = new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type === 'hello_ack') {
        acknowledged();
        return;
      }
      if (message.type !== 'request') return;
      const frame: RelayedFrame = {
        id: String(message.id),
        command: String(message.command),
        params: message.params,
        sequence: ++this.#sequence,
        connection,
      };
      this.frames.push(frame);
      if (this.#hold.has(frame.command)) {
        this.#held.push({ socket, frame });
        return;
      }
      this.#answerDefault(socket, frame);
    });

    await new Promise<void>((resolve, reject) => {
      const failed = (error: unknown): void =>
        reject(error instanceof Error ? error : new Error(String(error)));
      socket.once('open', () => resolve());
      socket.once('error', failed);
      socket.once('close', () => failed(new Error('Plugin socket closed before it opened.')));
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        secret: this.options.secret,
        plugin_version: '0.1.0',
        blockbench_version: '5.1.4',
        capabilities: ['java_block'],
      }),
    );
    await helloAck;
  }

  /**
   * Drop the current connection the way a Blockbench window closing would, and
   * resolve once it is fully closed.
   */
  async disconnect(): Promise<void> {
    const socket = this.#socket;
    if (socket === null) return;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    await closed;
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(
      [...this.#sockets].map(async (socket) => {
        if (socket.readyState === WebSocket.CLOSED) return;
        // Tearing down a socket that is still mid-handshake makes `ws` emit an
        // 'error' first; waiting on 'close' alone keeps that expected teardown
        // noise from failing a test that already finished.
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.terminate();
        await closed;
      }),
    );
  }

  get closing(): boolean {
    return this.#closing;
  }

  #answerDefault(socket: WebSocket, frame: RelayedFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (frame.command === 'revoke_scope') {
      socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { state: 'revoked' } }));
      return;
    }
    if (frame.command === 'get_project_state') {
      const marker = this.#nextMarker++;
      socket.send(
        JSON.stringify({ type: 'response', id: frame.id, ok: true, result: projectStateResult(marker) }),
      );
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'response',
        id: frame.id,
        ok: false,
        error: { code: 'E_SCOPE_NOT_CONFIRMED', message: 'No scoped directory has been confirmed.' },
      }),
    );
  }
}

/** Poll `predicate` until it holds, or fail with `description` in the message. */
export async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
