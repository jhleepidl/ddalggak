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

import { compactWithPinnedContext } from '../src/textutil.js';

test('compactWithPinnedContext preserves upload and correction evidence from the middle of long context', () => {
  const text = [
    'head '.repeat(300),
    'workspace_path: uploads/moff9gea_2691_photo_moff9e3l_2691.jpg',
    '정정: 된장찌개가 아니라 햄버거와 땅콩 사진으로 확인됨',
    'tail '.repeat(300),
  ].join('\n');
  const compacted = compactWithPinnedContext(text, 900);
  assert.ok(compacted.length <= 900);
  assert.match(compacted, /PINNED EXCERPTS/);
  assert.match(compacted, /uploads\/moff9gea_2691_photo_moff9e3l_2691\.jpg/);
  assert.match(compacted, /햄버거와 땅콩/);
});
