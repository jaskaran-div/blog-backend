import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail, normalizeEmail } from '../src/validation.js';
import { isValidVerificationToken } from '../src/tokens.js';

test('normalizes email addresses before storage', () => {
  assert.equal(normalizeEmail('  Reader@Example.COM  '), 'reader@example.com');
});

test('accepts valid email addresses and rejects malformed or oversized values', () => {
  assert.equal(isValidEmail('reader@example.com'), true);
  assert.equal(isValidEmail('reader+weekly@example.co.in'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('reader @example.com'), false);
  assert.equal(isValidEmail(`reader@${'a'.repeat(250)}.com`), false);
});

test('only accepts URL-safe verification tokens of the expected length', () => {
  assert.equal(isValidVerificationToken('a'.repeat(43)), true);
  assert.equal(isValidVerificationToken('not-a-token'), false);
});
