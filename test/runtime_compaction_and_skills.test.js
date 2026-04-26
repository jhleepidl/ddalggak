import test from 'node:test';
import assert from 'node:assert/strict';

import { clip } from '../src/textutil.js';
import { buildContextEnvelope } from '../src/runtime_capabilities/context_envelope.js';

test('clip preserves latest tail when truncating', () => {
  const src = `START-${'a'.repeat(500)}-LATEST_USER_FACT`;
  const out = clip(src, 160);
  assert.match(out, /START-/);
  assert.match(out, /LATEST_USER_FACT/);
  assert.match(out, /latest context preserved/);
});

test('context envelope truncation keeps latest section tail', () => {
  const src = `old ${'x'.repeat(800)} latest meal update: 보리비빔밥`;
  const out = buildContextEnvelope([{ key: 'recent_turns', body: src }], { maxChars: 260 }).text;
  assert.match(out, /latest meal update/);
  assert.match(out, /보리비빔밥/);
});
