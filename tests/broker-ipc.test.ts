import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorPayloadSchema } from '../src/shared/protocol.js';
import {
  IPC_PROTOCOL_VERSION,
  MAX_IPC_LINE_BYTES,
  IpcLineDecoder,
  brokerToClientMessageSchema,
  byeMessageSchema,
  clientHelloMessageSchema,
  clientToBrokerMessageSchema,
  encodeIpcMessage,
  helloAckMessageSchema,
  helloRejectMessageSchema,
  ipcRequestMessageSchema,
  ipcResponseMessageSchema,
  pingMessageSchema,
  pongMessageSchema,
  statusEventMessageSchema,
  type BrokerToClientMessage,
  type ClientToBrokerMessage,
} from '../src/adapter/broker/ipc-protocol.js';

const clientMessages: ClientToBrokerMessage[] = [
  {
    type: 'client_hello',
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: '0.1.0',
    config_identity: '0123456789abcdef',
    session_id: 'session-a',
    client_label: 'Codex',
    effective_port: 41201,
  },
  { type: 'request', id: 'request-1', command: 'get_project_state', params: {}, timeout_ms: 2_000 },
  { type: 'pong', id: 'heartbeat-1' },
  { type: 'bye' },
];

const brokerMessages: BrokerToClientMessage[] = [
  {
    type: 'hello_ack',
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: '0.1.0',
    broker_instance_id: 'broker-a',
    broker_pid: 1234,
    effective_port: 41201,
  },
  {
    type: 'hello_reject',
    reason: 'version_mismatch',
    ipc_protocol_version: IPC_PROTOCOL_VERSION,
    package_version: '0.1.0',
  },
  { type: 'response', id: 'request-1', ok: true, result: { open: false } },
  {
    type: 'response',
    id: 'request-2',
    ok: false,
    error: { code: 'E_BROKER_UNAVAILABLE', message: 'broker stopped' },
  },
  {
    type: 'status_event',
    plugin_connected: true,
    plugin_info: { plugin_version: '0.1.0' },
    controller_state: 'owned',
    controller_owner: 'Codex',
    client_count: 2,
    effective_port: 41201,
  },
  { type: 'ping', id: 'heartbeat-1' },
  { type: 'bye' },
];

test('every client-to-broker message survives NDJSON encoding and decoding', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  for (const message of clientMessages) {
    const encoded = encodeIpcMessage(message);
    assert.ok(encoded.endsWith('\n'));
    assert.deepEqual(decoder.push(encoded), [{ kind: 'message', message }]);
  }
});

test('every broker-to-client message survives NDJSON encoding and decoding', () => {
  const decoder = new IpcLineDecoder(brokerToClientMessageSchema);
  for (const message of brokerMessages) {
    assert.deepEqual(decoder.push(encodeIpcMessage(message)), [{ kind: 'message', message }]);
  }
});

test('unknown message types and extra envelope keys are rejected', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  const unknown = decoder.push(`${JSON.stringify({ type: 'mystery' })}\n`);
  const extra = decoder.push(`${JSON.stringify({ ...clientMessages[0], extra: true })}\n`);
  assert.equal(unknown[0]?.kind, 'reject');
  assert.equal(unknown[0]?.kind === 'reject' && unknown[0].reason, 'invalid_message');
  assert.equal(extra[0]?.kind, 'reject');
  assert.equal(extra[0]?.kind === 'reject' && extra[0].reason, 'invalid_message');
});

test('malformed JSON yields a structured rejection without poisoning the next frame', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  const results = decoder.push(`{not json\n${encodeIpcMessage({ type: 'bye' })}`);
  assert.equal(results[0]?.kind, 'reject');
  assert.equal(results[0]?.kind === 'reject' && results[0].reason, 'invalid_json');
  assert.deepEqual(results[1], { kind: 'message', message: { type: 'bye' } });
});

test('an oversized line yields one structured rejection and decoding resumes at the next line', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  const first = decoder.push('x'.repeat(MAX_IPC_LINE_BYTES + 1));
  assert.deepEqual(first, [
    {
      kind: 'reject',
      reason: 'line_too_long',
      error: `IPC line exceeds ${MAX_IPC_LINE_BYTES} bytes.`,
    },
  ]);
  assert.deepEqual(decoder.push(`discarded\n${encodeIpcMessage({ type: 'bye' })}`), [
    { kind: 'message', message: { type: 'bye' } },
  ]);
});

test('the line limit counts UTF-8 bytes rather than JavaScript characters', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  const line = JSON.stringify({
    ...clientMessages[0],
    client_label: '界'.repeat(Math.floor(MAX_IPC_LINE_BYTES / 2)),
  });
  assert.ok(line.length < MAX_IPC_LINE_BYTES);
  assert.ok(Buffer.byteLength(line, 'utf8') > MAX_IPC_LINE_BYTES);

  assert.deepEqual(decoder.push(`${line}\n`), [
    {
      kind: 'reject',
      reason: 'line_too_long',
      error: `IPC line exceeds ${MAX_IPC_LINE_BYTES} bytes.`,
    },
  ]);
});

test('partial lines and multiple frames are reassembled across arbitrary chunks', () => {
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  const first = encodeIpcMessage(clientMessages[0]);
  const second = encodeIpcMessage(clientMessages[1]);
  assert.deepEqual(decoder.push(first.slice(0, 7)), []);
  assert.deepEqual(decoder.push(first.slice(7, -1)), []);
  assert.deepEqual(decoder.push(`\n${second.slice(0, 13)}`), [{ kind: 'message', message: clientMessages[0] }]);
  assert.deepEqual(decoder.push(second.slice(13)), [{ kind: 'message', message: clientMessages[1] }]);
});

test('an 8 MiB IPC line fragmented at 64 KiB copies only a linear amount of data', (t) => {
  const message: BrokerToClientMessage = {
    type: 'response',
    id: 'large-fragmented-result',
    ok: true,
    result: 'x'.repeat(8 * 1024 * 1024),
  };
  const wire = Buffer.from(encodeIpcMessage(message));
  const decoder = new IpcLineDecoder(brokerToClientMessageSchema, wire.length - 1);
  const decoded: ReturnType<typeof decoder.push> = [];
  const concatDescriptor = Object.getOwnPropertyDescriptor(Buffer, 'concat')!;
  const fromDescriptor = Object.getOwnPropertyDescriptor(Buffer, 'from')!;
  const originalConcat = Buffer.concat;
  const originalFrom = Buffer.from;
  let concatCalls = 0;
  let copiedBytes = 0;

  // Keep instrumentation synchronous and local to decoding; always restore it
  // before assertions, diagnostics, or other tests can run.
  try {
    Buffer.concat = (...args: Parameters<typeof Buffer.concat>) => {
      const result = originalConcat(...args);
      concatCalls += 1;
      copiedBytes += result.length;
      return result;
    };
    Buffer.from = ((...args: unknown[]) => {
      const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
      copiedBytes += result.length;
      return result;
    }) as typeof Buffer.from;
    for (let offset = 0; offset < wire.length; offset += 64 * 1024) {
      decoded.push(...decoder.push(wire.subarray(offset, offset + 64 * 1024)));
    }
  } finally {
    Object.defineProperty(Buffer, 'concat', concatDescriptor);
    Object.defineProperty(Buffer, 'from', fromDescriptor);
  }

  t.diagnostic(`wire_bytes=${wire.length} concat_calls=${concatCalls} copied_bytes=${copiedBytes}`);
  assert.deepEqual(decoded, [{ kind: 'message', message }]);
  assert.ok(copiedBytes <= 4 * wire.length, `${copiedBytes} copied bytes exceeded 4x ${wire.length} wire bytes`);
});

test('split UTF-8 code points survive fragmented IPC followed by multiple lines', () => {
  const first: BrokerToClientMessage = { type: 'response', id: 'utf8', ok: true, result: '界🌱' };
  const last: BrokerToClientMessage = { type: 'response', id: 'last', ok: true, result: 'complete' };
  const wire = Buffer.from(`${JSON.stringify(first)}\r\n${encodeIpcMessage({ type: 'bye' })}${encodeIpcMessage(last)}`);
  const characterStart = wire.indexOf(Buffer.from('界'));
  assert.ok(characterStart >= 0);
  const decoder = new IpcLineDecoder(brokerToClientMessageSchema);
  assert.deepEqual(decoder.push(wire.subarray(0, characterStart + 1)), []);
  assert.deepEqual(decoder.push(wire.subarray(characterStart + 1, characterStart + 4)), []);
  assert.deepEqual(decoder.push(wire.subarray(characterStart + 4, characterStart + 6)), []);
  assert.deepEqual(decoder.push(wire.subarray(characterStart + 6)), [
    { kind: 'message', message: first },
    { kind: 'message', message: { type: 'bye' } },
    { kind: 'message', message: last },
  ]);
});

test('IPC lines at the exact byte limit decode whole or fragmented', () => {
  const message: BrokerToClientMessage = { type: 'response', id: 'exact', ok: true, result: '界' };
  const line = Buffer.from(JSON.stringify(message));
  for (const fragmented of [false, true]) {
    const decoder = new IpcLineDecoder(brokerToClientMessageSchema, line.length);
    if (fragmented) {
      assert.deepEqual(decoder.push(line.subarray(0, 7)), []);
      assert.deepEqual(decoder.push(line.subarray(7)), []);
      assert.deepEqual(decoder.push('\n'), [{ kind: 'message', message }]);
    } else {
      assert.deepEqual(decoder.push(`${line.toString()}\n`), [{ kind: 'message', message }]);
    }
  }
});

test('IPC lines one byte over the limit reject once and discard fragments until recovery', () => {
  const message: BrokerToClientMessage = { type: 'response', id: 'over', ok: true, result: '界' };
  const line = Buffer.from(JSON.stringify(message));
  const rejection = {
    kind: 'reject',
    reason: 'line_too_long',
    error: `IPC line exceeds ${line.length} bytes.`,
  };
  const fragmented = new IpcLineDecoder(brokerToClientMessageSchema, line.length);
  assert.deepEqual(fragmented.push(line.subarray(0, 7)), []);
  assert.deepEqual(fragmented.push(line.subarray(7)), []);
  assert.deepEqual(fragmented.push(' '), [rejection]);
  assert.deepEqual(fragmented.push('discarded'), []);
  assert.deepEqual(fragmented.push(`\n${encodeIpcMessage({ type: 'bye' })}`), [
    { kind: 'message', message: { type: 'bye' } },
  ]);

  const whole = new IpcLineDecoder(brokerToClientMessageSchema, line.length);
  assert.deepEqual(whole.push(`${line.toString()} \n${encodeIpcMessage({ type: 'bye' })}`), [
    rejection,
    { kind: 'message', message: { type: 'bye' } },
  ]);
});

test('response envelopes require errors exactly when ok is false', () => {
  assert.equal(ipcResponseMessageSchema.safeParse({ type: 'response', id: '1', ok: false }).success, false);
  assert.equal(
    ipcResponseMessageSchema.safeParse({
      type: 'response',
      id: '1',
      ok: true,
      error: { code: 'E_TIMEOUT', message: 'late' },
    }).success,
    false,
  );
  assert.equal(ipcResponseMessageSchema.safeParse({ type: 'response', id: '1', ok: true }).success, true);
  assert.equal(
    ipcResponseMessageSchema.safeParse({
      type: 'response',
      id: '1',
      ok: false,
      error: { code: 'E_TIMEOUT', message: 'late' },
    }).success,
    true,
  );
});

test('response error payloads reject extra keys', () => {
  assert.equal(
    ipcResponseMessageSchema.safeParse({
      type: 'response',
      id: '1',
      ok: false,
      error: { code: 'E_TIMEOUT', message: 'late', secret: 'must not cross IPC' },
    }).success,
    false,
  );
});

test('message schemas expose no secret field while opaque payloads remain content-agnostic', () => {
  const envelopeShapes = [
    clientHelloMessageSchema.shape,
    helloAckMessageSchema.shape,
    helloRejectMessageSchema.shape,
    ipcRequestMessageSchema.shape,
    ipcResponseMessageSchema.shape,
    statusEventMessageSchema.shape,
    pingMessageSchema.shape,
    pongMessageSchema.shape,
    byeMessageSchema.shape,
    errorPayloadSchema.shape,
  ];
  for (const shape of envelopeShapes) {
    assert.equal(Object.hasOwn(shape, 'secret'), false);
  }

  const message: ClientToBrokerMessage = {
    type: 'request',
    id: 'content-check',
    command: 'opaque',
    params: { note: 'this secret-like string is ordinary payload data' },
  };
  const decoder = new IpcLineDecoder(clientToBrokerMessageSchema);
  assert.deepEqual(decoder.push(encodeIpcMessage(message)), [{ kind: 'message', message }]);
});
