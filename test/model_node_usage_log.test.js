import assert from 'node:assert/strict';
import test from 'node:test';

import { buildModelNodeUsageEvent } from '../src/application/model_node_usage_log.js';

test('model node usage stores OpenAI-compatible token usage when available', () => {
  const event = buildModelNodeUsageEvent({
    node: { id: 'api', model: 'm' },
    prompt: 'hello',
    result: { ok: true, stdout: 'world', response_json: { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } },
  });
  assert.equal(event.token_usage.prompt_tokens, 3);
  assert.equal(event.token_usage.completion_tokens, 4);
  assert.equal(event.token_usage.total_tokens, 7);
});

test('model node usage stores Ollama eval counts as token usage', () => {
  const event = buildModelNodeUsageEvent({
    node: { id: 'ollama', model: 'gemma3' },
    prompt: 'hello',
    result: { ok: true, stdout: 'world', response_json: { prompt_eval_count: 11, eval_count: 22 } },
  });
  assert.equal(event.token_usage.prompt_tokens, 11);
  assert.equal(event.token_usage.completion_tokens, 22);
  assert.equal(event.token_usage.total_tokens, 33);
  assert.equal(event.token_usage.source, 'ollama_eval_counts');
});
