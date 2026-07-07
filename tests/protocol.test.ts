import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

test('protocol version constant is a positive integer', () => {
  assert.equal(Number.isInteger(PROTOCOL_VERSION), true);
  assert.ok(PROTOCOL_VERSION >= 1);
});
