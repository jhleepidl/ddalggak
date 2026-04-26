import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/textutil.js';

test('chunk prefers line boundaries for readable Telegram messages', () => {
  const text = ['a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120)].join('\n');
  const parts = chunk(text, 220);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((part) => part.length <= 220));
  assert.equal(parts[0].includes('c'.repeat(20)), false);
});
