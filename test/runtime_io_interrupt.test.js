import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureCommandOk } from '../src/application/telegram_runtime_io.js';

test('ensureCommandOk surfaces aborted provider runs as cancelled instead of generic failure', () => {
  assert.throws(() => ensureCommandOk('Codex', { ok: false, exitCode: -1, stderr: 'OpenAI Codex v0.106.0\n[aborted]' }), (error) => {
    assert.equal(error.code, 'ECANCELLED');
    assert.match(String(error.message || ''), /interrupted/i);
    return true;
  });
});


test('ensureCommandOk detects abort markers even when they appear near the tail of long provider output', () => {
  const longStderr = `${'x'.repeat(2200)}
[aborted]`;
  assert.throws(() => ensureCommandOk('Codex', { ok: false, exitCode: -1, stderr: longStderr }), (error) => {
    assert.equal(error.code, 'ECANCELLED');
    assert.match(String(error.message || ''), /interrupted/i);
    return true;
  });
});
