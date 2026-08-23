import { z } from 'zod';

import { errorPayloadSchema } from '../../shared/protocol.js';

// Broker IPC version. Bumped from 1 to 2 by the `cancel_request` message below.
// The hello check in broker-server.ts compares this value exactly, so a broker
// and a stdio shim built from different versions refuse each other's handshake
// and surface E_BROKER_VERSION_MISMATCH instead of speaking a mixed dialect.
export const IPC_PROTOCOL_VERSION = 2;
export const MAX_IPC_LINE_BYTES = 64 * 1024;

const requiredUnknownSchema = z.unknown().refine((value) => value !== undefined, {
  message: 'Required',
});

export const clientHelloMessageSchema = z
  .object({
    type: z.literal('client_hello'),
    ipc_protocol_version: z.number().int(),
    package_version: z.string(),
    config_identity: z.string(),
    session_id: z.string(),
    client_label: z.string(),
    effective_port: z.number().int(),
  })
  .strict();

export const helloAckMessageSchema = z
  .object({
    type: z.literal('hello_ack'),
    ipc_protocol_version: z.number().int(),
    package_version: z.string(),
    broker_instance_id: z.string(),
    broker_pid: z.number().int(),
    effective_port: z.number().int(),
  })
  .strict();

// `session_in_use` refuses a hello whose `session_id` a still-connected client
// already holds. It names a live-state conflict on an unchanged message shape,
// not a dialect difference, so it does not move IPC_PROTOCOL_VERSION: the two
// version-bearing reasons above stay the only ones that mean "we cannot speak
// to each other".
export const helloRejectMessageSchema = z
  .object({
    type: z.literal('hello_reject'),
    reason: z.enum(['version_mismatch', 'identity_mismatch', 'session_in_use']),
    ipc_protocol_version: z.number().int(),
    package_version: z.string(),
  })
  .strict();

export const ipcRequestMessageSchema = z
  .object({
    type: z.literal('request'),
    id: z.string(),
    command: z.string(),
    params: requiredUnknownSchema,
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export const requestMessageSchema = ipcRequestMessageSchema;

// Withdraws one still-unfinished request. `id` is the internal request UUID the
// broker client allocated for that request; it is never a client-supplied
// JSON-RPC id, which is untrusted and can repeat across stdio shims. The broker
// answers nothing: a cancelled request produces no response message at all.
export const ipcCancelRequestMessageSchema = z
  .object({
    type: z.literal('cancel_request'),
    id: z.string(),
  })
  .strict();

export const ipcResponseMessageSchema = z
  .object({
    type: z.literal('response'),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: errorPayloadSchema.strict().optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.ok && message.error !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A successful response must not carry an error payload.' });
    }
    if (!message.ok && message.error === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A failed response must carry an error payload.' });
    }
  });

export const responseMessageSchema = ipcResponseMessageSchema;

export const statusEventMessageSchema = z
  .object({
    type: z.literal('status_event'),
    plugin_connected: z.boolean(),
    plugin_info: requiredUnknownSchema.nullable(),
    controller_state: z.enum(['idle', 'owned', 'releasing', 'recovering']),
    controller_owner: z.string().nullable(),
    client_count: z.number().int(),
    effective_port: z.number().int(),
  })
  .strict();

export const pingMessageSchema = z.object({ type: z.literal('ping'), id: z.string() }).strict();
export const pongMessageSchema = z.object({ type: z.literal('pong'), id: z.string() }).strict();
export const byeMessageSchema = z.object({ type: z.literal('bye') }).strict();

export const clientToBrokerMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  ipcRequestMessageSchema,
  ipcCancelRequestMessageSchema,
  pongMessageSchema,
  byeMessageSchema,
]);

// The refined response schema cannot participate in a discriminated union in zod v3.
export const brokerToClientMessageSchema = z.union([
  helloAckMessageSchema,
  helloRejectMessageSchema,
  ipcResponseMessageSchema,
  statusEventMessageSchema,
  pingMessageSchema,
  byeMessageSchema,
]);

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;
export type HelloAckMessage = z.infer<typeof helloAckMessageSchema>;
export type HelloRejectMessage = z.infer<typeof helloRejectMessageSchema>;
export type IpcRequestMessage = z.infer<typeof ipcRequestMessageSchema>;
export type IpcCancelRequestMessage = z.infer<typeof ipcCancelRequestMessageSchema>;
export type IpcResponseMessage = z.infer<typeof ipcResponseMessageSchema>;
export type StatusEventMessage = z.infer<typeof statusEventMessageSchema>;
export type PingMessage = z.infer<typeof pingMessageSchema>;
export type PongMessage = z.infer<typeof pongMessageSchema>;
export type ByeMessage = z.infer<typeof byeMessageSchema>;
export type ClientToBrokerMessage = z.infer<typeof clientToBrokerMessageSchema>;
export type BrokerToClientMessage = z.infer<typeof brokerToClientMessageSchema>;
export type IpcMessage = ClientToBrokerMessage | BrokerToClientMessage;

export type IpcDecodeRejectReason = 'line_too_long' | 'invalid_json' | 'invalid_message';

export type IpcDecodeResult<T> =
  | { kind: 'message'; message: T }
  | { kind: 'reject'; reason: IpcDecodeRejectReason; error: string };

export function encodeIpcMessage(message: IpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Incrementally decodes one direction of an NDJSON IPC stream. */
export class IpcLineDecoder<T> {
  private buffered = Buffer.alloc(0);
  private discardingOversizeLine = false;

  constructor(
    private readonly schema: z.ZodType<T>,
    private readonly maxLineBytes = MAX_IPC_LINE_BYTES,
  ) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError('maxLineBytes must be a positive integer.');
    }
  }

  push(chunk: string | Uint8Array): IpcDecodeResult<T>[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const results: IpcDecodeResult<T>[] = [];
    let offset = 0;

    while (offset < bytes.length) {
      const newlineIndex = bytes.indexOf(0x0a, offset);
      const partEnd = newlineIndex === -1 ? bytes.length : newlineIndex;

      if (this.discardingOversizeLine) {
        if (newlineIndex === -1) return results;
        this.discardingOversizeLine = false;
        offset = newlineIndex + 1;
        continue;
      }

      const part = bytes.subarray(offset, partEnd);
      if (this.buffered.length + part.length > this.maxLineBytes) {
        this.buffered = Buffer.alloc(0);
        results.push({
          kind: 'reject',
          reason: 'line_too_long',
          error: `IPC line exceeds ${this.maxLineBytes} bytes.`,
        });
        if (newlineIndex === -1) {
          this.discardingOversizeLine = true;
          return results;
        }
        offset = newlineIndex + 1;
        continue;
      }

      if (part.length > 0) {
        this.buffered = Buffer.concat([this.buffered, part]);
      }
      if (newlineIndex === -1) return results;

      results.push(this.decodeLine(this.buffered));
      this.buffered = Buffer.alloc(0);
      offset = newlineIndex + 1;
    }

    return results;
  }

  private decodeLine(lineBytes: Buffer): IpcDecodeResult<T> {
    const withoutCarriageReturn =
      lineBytes.at(-1) === 0x0d ? lineBytes.subarray(0, lineBytes.length - 1) : lineBytes;
    let value: unknown;
    try {
      value = JSON.parse(withoutCarriageReturn.toString('utf8'));
    } catch (error) {
      return {
        kind: 'reject',
        reason: 'invalid_json',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      return {
        kind: 'reject',
        reason: 'invalid_message',
        error: parsed.error.issues.map((issue) => issue.message).join('; '),
      };
    }
    return { kind: 'message', message: parsed.data };
  }
}
