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

test('GoC sync preserves execution-error classification without raw provider text', () => {
  const payload = buildHarnessEvaluationSyncPayload({
    evaluation_id: 'eval-2', suite: 'live', status: 'completed_with_execution_errors',
    total_run_count: 1, execution_error_run_count: 1, quality_run_count: 0,
    runs: [{
      evaluation_id: 'eval-2', run_id: 'r2', scenario_id: 's2', provider: 'codex', model: 'gpt-5-codex',
      quality_eligible: false, outcome: 'execution_error',
      execution_error: { kind: 'execution_error', category: 'model_access_denied', retryable: false, message: 'safe summary' },
      provider_result: { ok: false, stderr: 'RAW SECRET ERROR' },
    }],
  });
  assert.equal(payload.execution_error_run_count, 1);
  assert.equal(payload.quality_run_count, 0);
  assert.equal(payload.runs[0].quality_eligible, false);
  assert.equal(payload.runs[0].execution_error.category, 'model_access_denied');
  assert.equal(payload.runs[0].provider_result.stderr, undefined);
});
