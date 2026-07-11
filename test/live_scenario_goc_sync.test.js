import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarnessEvaluationSyncPayload } from '../src/evaluation/live_scenario_goc_sync.js';

test('GoC harness evaluation sync strips raw provider stdout and stderr while preserving evaluation metadata', () => {
  const payload = buildHarnessEvaluationSyncPayload({
    evaluation_id: 'eval-1', suite: 'live', status: 'passed',
    variant_results: [{ runtime_signature: 'v|codex|m|high|cli', harness_variant_id: 'v', provider: 'codex' }],
    runs: [{
      evaluation_id: 'eval-1', run_id: 'r1', scenario_id: 's1', harness_variant_id: 'v',
      runtime_signature: 'v|codex|m|high|cli', provider: 'codex', model: 'm', reasoning_effort: 'high', cli_version: 'cli',
      passed: true, score: 1, provider_result: { ok: true, stdout: 'SECRET OUTPUT', stderr: 'SECRET ERROR', usage: { input_tokens: 10 } },
    }],
  });
  assert.equal(payload.runs.length, 1);
  assert.equal(payload.runs[0].provider_result.stdout, undefined);
  assert.equal(payload.runs[0].provider_result.stderr, undefined);
  assert.equal(payload.runs[0].runtime_signature, 'v|codex|m|high|cli');
  assert.equal(payload.runs[0].provider_result.usage.input_tokens, 10);
});
