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
