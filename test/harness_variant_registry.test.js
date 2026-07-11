import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessPrompt, loadHarnessVariantRegistry, resolveHarnessVariant } from '../src/evaluation/harness_variant_registry.js';

test('harness prompt layers canonical contract, provider dialect, reasoning, and delegation policy', () => {
  const registry = loadHarnessVariantRegistry({ cwd: process.cwd() });
  const variant = resolveHarnessVariant({ registry, provider: 'codex', role: 'code_executor', reasoningEffort: 'high' });
  const built = buildHarnessPrompt({
    scenario: { id: 's1', goal: 'Fix the bug', acceptance_criteria: ['tests pass'], expectations: { files: { forbidden_changed: ['.env'] } } },
    variant,
    capabilityProfile: { capabilities: { native_subagents: true } },
    workspaceRoot: '/tmp/workspace',
  });
  assert.match(built.prompt, /Canonical task contract/);
  assert.match(built.prompt, /Provider guidance: Codex/);
  assert.match(built.prompt, /Reasoning profile: high/);
  assert.match(built.prompt, /Provider-native subagents are allowed/);
  assert.equal(built.prompt_hash.length, 64);
});

test('runtime prompt adaptation is opt-in unless runtime variants are globally enabled', async () => {
  const { applyHarnessVariantToPrompt } = await import('../src/evaluation/harness_variant_registry.js');
  const untouched = applyHarnessVariantToPrompt({ basePrompt: 'original task', provider: 'codex' });
  assert.equal(untouched.applied, false);
  assert.equal(untouched.prompt, 'original task');
  const adapted = applyHarnessVariantToPrompt({ basePrompt: 'original task', provider: 'codex', role: 'code_executor', variantId: 'code_executor.codex.default.high.v1' });
  assert.equal(adapted.applied, true);
  assert.match(adapted.prompt, /AI Rooms runtime harness variant/);
  assert.match(adapted.prompt, /original task/);
});
