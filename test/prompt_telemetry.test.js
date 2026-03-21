import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendPromptTelemetry, buildPromptBaselines } from '../src/application/prompt_telemetry.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-prompt-telemetry-'));
}

test('appendPromptTelemetry records prompt sizes and baseline savings', () => {
  const dir = makeTmpDir();
  const sharedDir = path.join(dir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), [
    JSON.stringify({ role: 'user', text: 'first request' }),
    JSON.stringify({ role: 'assistant', text: 'first reply' }),
    JSON.stringify({ role: 'user', text: 'second request with more details' }),
  ].join('\n'));
  fs.writeFileSync(path.join(sharedDir, 'mission_brief.md'), '# brief\nhello world');
  const rec = appendPromptTelemetry({
    jobDir: dir,
    sharedDir,
    row: {
      provider: 'codex',
      agent_id: 'builder',
      role_id: 'builder',
      prompt_text: 'short prompt',
      components: {
        local_context: 'ctx',
        task_instruction: 'do the thing',
      },
      prepared_context_tokens: 42,
    },
  });
  assert.equal(rec.actual_prompt_tokens, Math.ceil('short prompt'.length / 4));
  assert.ok(rec.baseline.conversation_only_tokens > 0);
  assert.ok(Array.isArray(rec.components));
  const lines = fs.readFileSync(path.join(dir, 'prompt_metrics.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.agent_id, 'builder');
  assert.ok(parsed.savings_vs_conversation_tokens < parsed.baseline.conversation_only_tokens);
});

test('buildPromptBaselines includes conversation plus shared docs snapshot', () => {
  const dir = makeTmpDir();
  const sharedDir = path.join(dir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), JSON.stringify({ role: 'user', text: 'hello baseline' }) + '\n');
  fs.writeFileSync(path.join(sharedDir, 'mission_brief.md'), 'mission body');
  const out = buildPromptBaselines({ jobDir: dir, sharedDir });
  assert.ok(out.conversation_only_tokens > 0);
  assert.ok(out.shared_docs_tokens > 0);
  assert.ok(out.conversation_plus_shared_tokens >= out.conversation_only_tokens);
});
