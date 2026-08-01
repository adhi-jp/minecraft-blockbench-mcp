import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE_REASON_MAX_LENGTH, sanitizeDialogText } from '../src/plugin/dialog-text.js';

test('collapses newlines and C0/C1 control characters into spaces', () => {
  assert.equal(sanitizeDialogText('\u0000alpha\n\t\u0080beta\u001F  gamma', SCOPE_REASON_MAX_LENGTH), 'alpha beta gamma');
});

test('escapes every inline-Markdown character', () => {
  const input = '\\`*_[]';
  const expected = '\\\\' + '\\`' + '\\*' + '\\_' + '\\[' + '\\]';
  assert.equal(sanitizeDialogText(input, SCOPE_REASON_MAX_LENGTH), expected);
});

test('truncates at the requested boundary and appends one ellipsis', () => {
  assert.equal(sanitizeDialogText('abcdef', 3), 'abc…');
  assert.equal(sanitizeDialogText('abc', 3), 'abc');
});

test('passes a short reason through after trimming', () => {
  assert.equal(sanitizeDialogText('  Need to inspect the model  ', SCOPE_REASON_MAX_LENGTH), 'Need to inspect the model');
});

test('keeps empty input empty', () => {
  assert.equal(sanitizeDialogText('', SCOPE_REASON_MAX_LENGTH), '');
});
