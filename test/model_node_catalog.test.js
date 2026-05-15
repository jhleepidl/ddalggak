import assert from 'node:assert/strict';
import test from 'node:test';

import { applyModelCatalogToNode, inferModelCatalogEntry, summarizeModelCatalogEntry } from '../src/application/model_node_catalog.js';

test('model catalog estimates Ollama local model properties from parameter size', () => {
  const entry = inferModelCatalogEntry({ model: 'qwen2.5-coder:32b', runtime: 'ollama', details: { parameter_size: '32.8B', quantization_level: 'Q4_K_M' } });
  assert.equal(entry.cost_profile.tier, 'free');
  assert.equal(entry.quality_profile.coding, 'strong');
  assert.equal(entry.latency_profile.tier, 'slow');
  assert.equal(entry.model_catalog, undefined);
});

test('model catalog applies known cloud model defaults without overriding explicit node fields', () => {
  const node = applyModelCatalogToNode({ model: 'gemini-3-flash-preview', runtime: 'gemini_cli', cost_profile: { tier: 'free_quota' }, routing: { prefer_for: ['researcher'] } });
  assert.equal(node.cost_profile.tier, 'free_quota');
  assert.equal(node.latency_profile.tier, 'fast');
  assert.equal(node.quality_profile.tier, 'good');
  assert.match(summarizeModelCatalogEntry(node), /quality=good/);
});
