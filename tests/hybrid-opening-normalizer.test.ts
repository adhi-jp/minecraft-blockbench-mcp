// What the transport ingress guard rewrites, refuses, and leaves alone.
//
// The wire tests in `tests/mcp-era-negotiation-wire.test.ts` prove the outcomes
// — a hybrid opening is served as legacy on all five locked revisions, and an
// unsupported `io.modelcontextprotocol/protocolVersion` claim is refused with
// -32022 on every request of a 2026-07-28 connection. Two things are invisible
// from the wire, though: a legacy `initialize` result echoes none of its input
// back, so the wire cannot show what survived the rewrite; and a refusal that
// the server also answered would look the same from outside as one it never
// saw. These tests drive the transport wrapper directly, so they can see both
// the message the server side actually receives and the message the wrapper
// writes back on its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

import {
  HybridOpeningInitializeNormalizer,
  MODERN_RESERVED_OPENING_CLAIM_META_KEYS,
  SUPPORTED_MODERN_PROTOCOL_REVISIONS,
} from '../src/adapter/hybrid-opening-normalizer.js';

/** A transport that does nothing but hand messages to whoever wraps it. */
class RecordingInnerTransport implements Transport {
  readonly sent: JSONRPCMessage[] = [];
  started = 0;
  closed = 0;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  /** Deliver one inbound message as if it had arrived on stdin. */
  deliver(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  start(): Promise<void> {
    this.started += 1;
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

interface Wired {
  inner: RecordingInnerTransport;
  normalizer: HybridOpeningInitializeNormalizer;
  received: JSONRPCMessage[];
  normalizations: Array<{ strippedKeys: string[] }>;
}

function wire(): Wired {
  const inner = new RecordingInnerTransport();
  const normalizations: Array<{ strippedKeys: string[] }> = [];
  const normalizer = new HybridOpeningInitializeNormalizer(inner, {
    onNormalize: (record) => normalizations.push(record),
  });
  const received: JSONRPCMessage[] = [];
  normalizer.onmessage = (message) => received.push(message);
  return { inner, normalizer, received, normalizations };
}

const RESERVED_CLAIMS = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'hybrid-client', version: '4.2.0' },
} as const;

function hybridOpening(id: number | string, extraMeta: Record<string, unknown> = {}): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: 'hybrid-client', version: '4.2.0' },
      _meta: { ...RESERVED_CLAIMS, ...extraMeta },
    },
  } as JSONRPCMessage;
}

test('a hybrid opening loses exactly the three reserved claim keys and keeps every other _meta member', () => {
  const { inner, received, normalizations } = wire();
  const ordinary = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    tracestate: 'vendor=value',
    baggage: 'userId=alice',
    'io.modelcontextprotocol/related-task': { taskId: 'abc' },
    'io.modelcontextprotocol/protocolVersionish': 'look-alike, must survive',
    'com.example/private': { nested: { 'io.modelcontextprotocol/protocolVersion': 'nested, must survive' } },
    progressToken: 'token-1',
  };
  inner.deliver(hybridOpening(1, ordinary));

  assert.equal(received.length, 1);
  const params = (received[0] as { params: Record<string, unknown> }).params;
  const meta = params._meta as Record<string, unknown>;

  for (const key of MODERN_RESERVED_OPENING_CLAIM_META_KEYS) {
    assert.ok(!(key in meta), `the reserved claim ${key} survived normalization`);
  }
  assert.deepEqual(meta, ordinary, 'normalization changed a _meta member that is not a reserved claim');
  assert.deepEqual(normalizations, [{ strippedKeys: [...MODERN_RESERVED_OPENING_CLAIM_META_KEYS] }]);
});

test('a hybrid opening keeps its declared protocol version, capabilities, and client identity', () => {
  const { inner, received } = wire();
  inner.deliver(hybridOpening(1));

  const params = (received[0] as { params: Record<string, unknown> }).params;
  assert.equal(params.protocolVersion, '2025-06-18', 'the revision the client asked for was rewritten');
  assert.deepEqual(params.capabilities, { roots: { listChanged: true }, sampling: {} });
  assert.deepEqual(params.clientInfo, { name: 'hybrid-client', version: '4.2.0' });
  assert.deepEqual(Object.keys(params).sort(), ['_meta', 'capabilities', 'clientInfo', 'protocolVersion']);
});

test('an opening with no reserved claim is forwarded as the identical object', () => {
  const { inner, received, normalizations } = wire();
  const plain = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'plain-client', version: '1.0.0' },
      _meta: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    },
  } as JSONRPCMessage;
  inner.deliver(plain);

  assert.equal(received[0], plain, 'a non-hybrid opening was copied instead of forwarded unchanged');
  assert.deepEqual(normalizations, [], 'the normalize hook fired for an opening that carried no reserved claim');
});

test('the caller original message object is never mutated by normalization', () => {
  const { inner, received } = wire();
  const original = hybridOpening(1, { traceparent: 'keep-me' });
  const before = structuredClone(original);
  inner.deliver(original);

  assert.deepEqual(original, before, 'normalization mutated the object it was handed');
  assert.notEqual(received[0], original, 'a hybrid opening must be forwarded as a rewritten copy');
});

test('only the first initialize request of a connection is normalized', () => {
  const { inner, received, normalizations } = wire();
  inner.deliver(hybridOpening('first'));
  inner.deliver(hybridOpening('second'));

  assert.deepEqual(normalizations.length, 1, 'a later initialize was normalized as well');
  const secondMeta = ((received[1] as { params: Record<string, unknown> }).params._meta) as Record<string, unknown>;
  for (const key of MODERN_RESERVED_OPENING_CLAIM_META_KEYS) {
    assert.ok(key in secondMeta, `the reserved claim ${key} was stripped from a later initialize`);
  }
});

test('an initialize-shaped notification and every non-initialize message pass through untouched', () => {
  const { inner, received, normalizations } = wire();
  const notification = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: { _meta: { ...RESERVED_CLAIMS } },
  } as JSONRPCMessage;
  const toolsCall = {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'health', arguments: {}, _meta: { ...RESERVED_CLAIMS } },
  } as JSONRPCMessage;
  inner.deliver(notification);
  inner.deliver(toolsCall);

  assert.equal(received[0], notification, 'an initialize-shaped notification was rewritten');
  assert.equal(received[1], toolsCall, 'a non-initialize request was rewritten');
  assert.deepEqual(normalizations, []);

  // Positive control: the same wrapper does rewrite a real hybrid opening, so
  // the pass-through above is a decision and not an inert wrapper.
  inner.deliver(hybridOpening(10));
  assert.deepEqual(normalizations, [{ strippedKeys: [...MODERN_RESERVED_OPENING_CLAIM_META_KEYS] }]);
});

test('a hybrid opening carrying only one reserved claim loses only that claim', () => {
  const { inner, received, normalizations } = wire();
  inner.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'partial-client', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', traceparent: 'keep-me' },
    },
  } as JSONRPCMessage);

  const meta = ((received[0] as { params: Record<string, unknown> }).params._meta) as Record<string, unknown>;
  assert.deepEqual(meta, { traceparent: 'keep-me' });
  assert.deepEqual(normalizations, [{ strippedKeys: ['io.modelcontextprotocol/protocolVersion'] }]);
});

test('start, send, and close are handed straight to the wrapped transport', async () => {
  const { inner, normalizer } = wire();
  await normalizer.start();
  const outbound = { jsonrpc: '2.0', id: 1, result: {} } as JSONRPCMessage;
  await normalizer.send(outbound);
  await normalizer.close();

  assert.equal(inner.started, 1);
  assert.equal(inner.closed, 1);
  assert.deepEqual(inner.sent, [outbound]);
  assert.equal(inner.sent[0], outbound, 'an outbound message was copied on its way out');
});

/** Frame one request carrying the reserved 2026-07-28 envelope. */
function modernRequest(
  id: number | string,
  method: string,
  claimedRevision = '2026-07-28',
  clientCapabilities: unknown = {},
): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': claimedRevision,
        'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
        'io.modelcontextprotocol/clientInfo': { name: 'unit-client', version: '1.0.0' },
      },
    },
  } as JSONRPCMessage;
}

/**
 * One `2026-07-28` notification: the same reserved envelope a modern request
 * carries, with no `id`. `serveStdio` pins a connection on one of these from
 * its opening phase, so this wrapper has to settle the era on one too.
 */
function modernNotification(
  method = 'notifications/progress',
  claimedRevision = '2026-07-28',
  clientCapabilities: unknown = {},
): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    method,
    params: {
      progressToken: 'era-probe',
      progress: 1,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': claimedRevision,
        'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
        'io.modelcontextprotocol/clientInfo': { name: 'unit-client', version: '1.0.0' },
      },
    },
  } as JSONRPCMessage;
}

/** One plain 2025-era handshake, carrying no reserved claim at all. */
function legacyOpeningRequest(id: number | string): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit-client', version: '1.0.0' } },
  } as JSONRPCMessage;
}

/** The single JSON-RPC error object the wrapper wrote on the wire, if any. */
function refusalOn(inner: RecordingInnerTransport): { code?: number; message?: string; data?: Record<string, unknown> } | undefined {
  const written = inner.sent as Array<{ error?: { code?: number; message?: string; data?: Record<string, unknown> } }>;
  return written[0]?.error;
}

test('an unsupported reserved claim on a 2026-07-28 connection is answered on the wire and never forwarded', () => {
  const { inner, received } = wire();
  // A request that is not `server/discover` settles the connection on
  // 2026-07-28.
  inner.deliver(modernRequest(1, 'tools/list'));
  assert.equal(received.length, 1, 'the request that settles the era must be forwarded untouched');

  inner.deliver(modernRequest(2, 'tools/call', '1999-01-01'));

  assert.equal(received.length, 1, 'a request claiming an unsupported revision was forwarded to the server');
  assert.equal(inner.sent.length, 1, 'the refusal was not written exactly once');
  const refusal = refusalOn(inner);
  assert.equal(refusal?.code, -32022);
  assert.equal(refusal?.message, 'Unsupported protocol version: 1999-01-01');
  assert.deepEqual(refusal?.data, { supported: [...SUPPORTED_MODERN_PROTOCOL_REVISIONS], requested: '1999-01-01' });
  assert.equal((inner.sent[0] as { id?: unknown }).id, 2, 'the refusal answered a different request id');
});

test('server/discover does not settle the era, so an unsupported claim after it is left to the server', () => {
  const { inner, received } = wire();
  inner.deliver(modernRequest(1, 'server/discover'));
  inner.deliver(modernRequest(2, 'server/discover'));
  inner.deliver(modernRequest(3, 'tools/list', '1999-01-01'));

  assert.equal(received.length, 3, 'a request was withheld while the era was still open');
  assert.deepEqual(inner.sent, [], 'the wrapper answered a request while the era was still open');
});

test('a connection settled on the 2025 era forwards a reserved claim naming an unsupported revision', () => {
  const { inner, received } = wire();
  // A plain 2025-era handshake carries no reserved claim, so it settles the
  // connection on the 2025 era.
  inner.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit-client', version: '1.0.0' } },
  } as JSONRPCMessage);
  inner.deliver(modernRequest(2, 'tools/list', '1999-01-01'));

  assert.equal(received.length, 2, 'a 2025-era connection had one of its requests withheld');
  assert.deepEqual(inner.sent, [], 'a 2025-era connection was refused for an unrecognised _meta member');
});

test('a malformed reserved envelope does not settle the era, so the server still answers it', () => {
  const { inner, received } = wire();
  // The revision named here is supported, but the envelope around it is not a
  // valid one — that is the server's -32602 to answer, and it settles nothing.
  inner.deliver(modernRequest(1, 'tools/list', '2026-07-28', 'not-an-object'));
  inner.deliver(modernRequest(2, 'tools/list', '1999-01-01'));

  assert.equal(received.length, 2, 'a request was withheld after a malformed envelope');
  assert.deepEqual(inner.sent, [], 'the wrapper answered a request the server had not yet settled an era for');
});

test('a notification claiming an unsupported revision is forwarded, because there is no id to answer', () => {
  const { inner, received } = wire();
  inner.deliver(modernRequest(1, 'tools/list'));
  inner.deliver({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: {
      requestId: 1,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '1999-01-01',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'unit-client', version: '1.0.0' },
      },
    },
  } as JSONRPCMessage);

  assert.equal(received.length, 2, 'a notification was withheld from the server');
  assert.deepEqual(inner.sent, [], 'the wrapper tried to answer a notification');
});

test('a supported reserved claim is forwarded as the identical object on a 2026-07-28 connection', () => {
  const { inner, received } = wire();
  inner.deliver(modernRequest(1, 'tools/list'));
  const later = modernRequest(2, 'tools/call');
  inner.deliver(later);

  assert.equal(received.length, 2);
  assert.equal(received[1], later, 'a supported request was copied on its way in');
  assert.deepEqual(inner.sent, [], 'a supported revision was refused');
});

test('a 2026-07-28 notification settles the era, so an unsupported claim after it is refused with -32022', () => {
  const { inner, received } = wire();
  // `serveStdio` pins the connection to 2026-07-28 on this notification: its
  // early return for a notification lives in the `server/discover` probe
  // branch, and no probe is open here.
  inner.deliver(modernNotification());
  assert.equal(received.length, 1, 'the notification that settles the era must still be forwarded');

  inner.deliver(modernRequest(2, 'tools/call', '2099-01-01'));

  assert.equal(received.length, 1, 'a request claiming an unsupported revision was forwarded to the server');
  assert.equal(inner.sent.length, 1, 'the refusal was not written exactly once');
  const refusal = refusalOn(inner);
  assert.equal(refusal?.code, -32022);
  assert.deepEqual(refusal?.data, { supported: [...SUPPORTED_MODERN_PROTOCOL_REVISIONS], requested: '2099-01-01' });
});

test('a legacy initialize arriving after a 2026-07-28 notification leaves the connection on the modern era', () => {
  const { inner, received } = wire();
  inner.deliver(modernNotification());
  // The dependency has already pinned this connection modern, so it answers
  // this handshake with its own refusal rather than serving it. The era it
  // settled cannot be talked back down, and neither can this wrapper's.
  inner.deliver(legacyOpeningRequest(1));
  inner.deliver(modernRequest(2, 'tools/call', '2099-01-01'));

  assert.equal(received.length, 2, 'a request claiming an unsupported revision was forwarded to the server');
  assert.equal(refusalOn(inner)?.code, -32022, 'a legacy initialize disarmed the guard on a modern connection');
});

test('a 2026-07-28 notification delivered while the server/discover probe is open settles nothing', () => {
  const { inner, received } = wire();
  // `serveStdio` hands a notification to the discardable probe instance and
  // returns without pinning, so the connection is still free to become 2025-era
  // and this wrapper must not start refusing on its behalf.
  inner.deliver(modernRequest(1, 'server/discover'));
  inner.deliver(modernNotification());
  inner.deliver(modernRequest(2, 'tools/list', '2099-01-01'));

  assert.equal(received.length, 3, 'a request was withheld while the era was still open');
  assert.deepEqual(inner.sent, [], 'the wrapper answered a request while the era was still open');
});

test('a notification whose reserved envelope is malformed settles nothing', () => {
  const { inner, received } = wire();
  // The revision named here is supported, but the envelope around it is not
  // valid. `serveStdio` calls that envelope invalid, discards the notification,
  // and pins nothing.
  inner.deliver(modernNotification('notifications/progress', '2026-07-28', 'not-an-object'));
  inner.deliver(modernRequest(1, 'tools/list', '2099-01-01'));

  assert.equal(received.length, 2, 'a request was withheld after a malformed notification envelope');
  assert.deepEqual(inner.sent, [], 'the wrapper answered a request the server had not yet settled an era for');
});

test('a claim-less notification settles the 2025 era, so a later reserved claim stays opaque', () => {
  const { inner, received } = wire();
  // A notification carrying no reserved claim is 2025-era traffic, and
  // `serveStdio` pins the connection legacy on it. A 2025-era client may then
  // carry any reserved claim it likes without being refused for it.
  inner.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  inner.deliver(modernRequest(1, 'tools/list', '2099-01-01'));

  assert.equal(received.length, 2, 'a 2025-era connection had one of its requests withheld');
  assert.deepEqual(inner.sent, [], 'a 2025-era connection was refused for a reserved claim it never negotiated');
});

test('a response arriving before either era is settled leaves the era open', () => {
  const { inner, received } = wire();
  // `serveStdio` discards a response received before the era is negotiated
  // without pinning anything. Its era classifier would call that same body
  // 2025-era, so a response must never be allowed to settle the era here.
  inner.deliver({ jsonrpc: '2.0', id: 99, result: {} } as JSONRPCMessage);
  inner.deliver(modernRequest(1, 'tools/list'));
  inner.deliver(modernRequest(2, 'tools/call', '2099-01-01'));

  // The response and the request that settles the era are both forwarded; the
  // unsupported one is refused here and is not.
  assert.equal(received.length, 2, 'the unsupported request was forwarded, so a response had settled the era');
  assert.equal(refusalOn(inner)?.code, -32022, 'a stray response disarmed the guard for the connection');
});
