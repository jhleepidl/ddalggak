import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRuntimeTelemetryJsonl,
  buildRuntimeTelemetryEvent,
  estimateRuntimeCostUsd,
  normalizeRuntimeUsage,
  validateRuntimeTelemetryEvent,
} from '../src/application/runtime_telemetry.js';

test('runtime telemetry preserves actual OpenAI usage without raw prompts', () => {
  const event = buildRuntimeTelemetryEvent({
    provider: 'openai',
    api: 'responses',
    model: 'fixed-model',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    route: { depth: 'ask', execution_shape: 'single_agent', raw_text: 'secret' },
    room_memory_trials: { treatment_id: 'T3_schema_plus_confirmation', prompt: 'secret prompt' },
    pricing: { input_per_million_usd: 1, cached_input_per_million_usd: 0.1, output_per_million_usd: 2, snapshot: 'test' },
  });
  const encoded = JSON.stringify(event);
  assert.equal(event.tokens.token_source, 'actual_api_response');
  assert.equal(event.tokens.input_tokens, 120);
  assert.equal(event.tokens.cached_input_tokens, 20);
  assert.equal(event.tokens.reasoning_tokens, 5);
  assert.equal(event.cost.estimated_usd, estimateRuntimeCostUsd(event.tokens, { input_per_million_usd: 1, cached_input_per_million_usd: 0.1, output_per_million_usd: 2 }));
  assert.ok(!encoded.includes('secret'));
  assert.deepEqual(validateRuntimeTelemetryEvent(event), { ok: true });
});

test('runtime telemetry falls back to estimated tokens for non-usage providers', () => {
  const usage = normalizeRuntimeUsage({ provider: 'cli', promptChars: 400, outputChars: 80 });
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.token_source, 'estimated_from_chars');
});

test('runtime telemetry writes only when explicitly enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-telemetry-'));
  const event = buildRuntimeTelemetryEvent({ provider: 'openai', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
  const disabled = appendRuntimeTelemetryJsonl(event, { config: { enabled: false, out_dir: dir } });
  assert.equal(disabled.wrote, false);
  const enabled = appendRuntimeTelemetryJsonl(event, { config: { enabled: true, out_dir: dir } });
  assert.equal(enabled.wrote, true);
  assert.ok(fs.existsSync(enabled.file));
});
