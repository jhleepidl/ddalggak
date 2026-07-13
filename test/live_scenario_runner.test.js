import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileStoredLiveScenarioSummary, runLiveScenarioSuite } from '../src/evaluation/live_scenario_runner.js';

test('live scenario runner uses a real workspace contract and deterministic command evaluation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src', 'value.txt'), 'old\n');
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    id: 'scenario_test', goal: 'Change the value', fixture: { path: './fixture' },
    matrix: [{ provider: 'codex', repetitions: 1 }],
    expectations: { files: { patch_required: true, allowed_changed: ['src/**'] }, commands: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
  }));
  const summary = await runLiveScenarioSuite({
    scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
    capabilityProbe: async () => ({ provider: 'codex', cli_available: true, cli_version: 'test', capabilities: { native_subagents: true } }),
    providerExecutor: async ({ workspaceRoot }) => { fs.writeFileSync(path.join(workspaceRoot, 'src', 'value.txt'), 'new\n'); return { ok: true, exitCode: 0, stdout: 'done', stderr: '', used_model: 'test-model' }; },
  });
  assert.equal(summary.total_run_count, 1);
  assert.equal(summary.passed_run_count, 1);
  assert.equal(summary.variant_results[0].success_rate, 1);
  assert.ok(fs.existsSync(path.join(summary.output_dir, 'summary.json')));
});

test('live scenario runner fails when provider changes a forbidden path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-forbidden-'));
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture, { recursive: true }); fs.writeFileSync(path.join(fixture, '.env'), 'SAFE=1\n');
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({ id: 'bad_change', goal: 'Do work', fixture: { path: './fixture' }, matrix: [{ provider: 'claude' }], expectations: { files: { patch_required: true, forbidden_changed: ['.env'] } } }));
  const summary = await runLiveScenarioSuite({
    scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
    capabilityProbe: async () => ({ provider: 'claude', cli_available: true, cli_version: 'test', capabilities: { native_subagents: true } }),
    providerExecutor: async ({ workspaceRoot }) => { fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SAFE=0\n'); return { ok: true, exitCode: 0, stdout: 'done', stderr: '' }; },
  });
  assert.equal(summary.failed_run_count, 1);
  assert.equal(summary.runs[0].deterministic_evaluation.checks.find((row) => row.name === 'forbidden_changed').passed, false);
});


test('live scenario aggregation keeps CLI/model runtime signatures separate for the same harness variant', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-signature-'));
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture, { recursive: true }); fs.writeFileSync(path.join(fixture, 'README.md'), 'x\n');
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    id: 'signature_split', goal: 'Inspect only', fixture: { path: './fixture' },
    matrix: [
      { provider: 'codex', model: 'model-a', reasoning_effort: 'high', repetitions: 1 },
      { provider: 'codex', model: 'model-b', reasoning_effort: 'high', repetitions: 1 },
    ],
    expectations: { provider_ok: true },
  }));
  const summary = await runLiveScenarioSuite({
    scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
    capabilityProbe: async ({ model }) => ({ provider: 'codex', model, cli_available: true, cli_version: model === 'model-a' ? 'cli-1' : 'cli-2', capabilities: {} }),
    providerExecutor: async ({ variant }) => ({ ok: true, exitCode: 0, stdout: 'ok', stderr: '', used_model: variant.model }),
  });
  assert.equal(summary.variant_results.length, 2);
  assert.notEqual(summary.variant_results[0].runtime_signature, summary.variant_results[1].runtime_signature);
});

test('live scenario runner can use an isolated semantic judge and combine its score without auto-promoting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-judge-'));
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(path.join(fixture, 'src'), { recursive: true }); fs.writeFileSync(path.join(fixture, 'src', 'value.txt'), 'old\n');
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    id: 'semantic_case', goal: 'Change the value correctly', fixture: { path: './fixture' },
    matrix: [{ provider: 'codex' }], expectations: { files: { patch_required: true, allowed_changed: ['src/**'] } },
    semantic_judge: { enabled: true, provider: 'claude', required: true, weight: 0.5, rubric: ['The change must match the goal'] },
  }));
  const calls = [];
  const summary = await runLiveScenarioSuite({
    scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
    capabilityProbe: async ({ provider }) => ({ provider, cli_available: true, cli_version: `${provider}-cli`, capabilities: { native_subagents: true } }),
    providerExecutor: async ({ provider, workspaceRoot, variant }) => {
      calls.push({ provider, workspaceRoot, role: variant.role });
      if (variant.role === 'reviewer') return { ok: true, exitCode: 0, stdout: '{"passed":true,"score":0.8,"summary":"meets goal","findings":[]}', stderr: '', used_model: 'judge-model' };
      fs.writeFileSync(path.join(workspaceRoot, 'src', 'value.txt'), 'new\n');
      return { ok: true, exitCode: 0, stdout: 'implemented', stderr: '', used_model: 'builder-model' };
    },
  });
  assert.equal(summary.passed_run_count, 1);
  assert.equal(summary.runs[0].semantic_evaluation.passed, true);
  assert.equal(summary.runs[0].score, 0.9);
  assert.equal(summary.recommendation.kind, 'evaluation_only_no_auto_promotion');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].workspaceRoot, calls[1].workspaceRoot);
});

test('provider override drops a scenario provider-specific variant and auto-selects a compatible one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-provider-override-'));
  const scenarioFile = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify({
    id: 'provider_override', goal: 'No-op', role: 'task_worker',
    fixture: { files: { 'input.txt': 'x' } },
    matrix: [{ provider: 'codex', role: 'task_worker', harness_variant_id: 'task_worker.codex.default.medium.v1' }],
    expectations: { provider_ok: true },
  }));
  try {
    let selected = null;
    const summary = await runLiveScenarioSuite({
      scenarioFiles: [scenarioFile], outputDir: path.join(root, 'out'), provider: 'claude', model: 'sonnet-test',
      capabilityProbe: async ({ provider }) => ({ provider, cli_available: true, cli_version: 'test' }),
      providerExecutor: async ({ variant }) => { selected = variant; return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, used_model: 'sonnet-test' }; },
    });
    assert.equal(summary.passed_run_count, 1);
    assert.equal(selected.provider, 'claude');
    assert.equal(selected.id, 'task_worker.claude.default.medium.v1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live scenario runner separates model access denial from model quality and skips downstream checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-access-denied-'));
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    id: 'access_denied', goal: 'Create output',
    fixture: { files: { 'input.txt': 'x' } },
    matrix: [{ provider: 'codex', model: 'gpt-5-codex' }],
    expectations: { provider_ok: true, commands: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
  }));
  let commandCalls = 0;
  try {
    const summary = await runLiveScenarioSuite({
      scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
      capabilityProbe: async () => ({ provider: 'codex', cli_available: true, cli_version: 'codex-cli 0.144.1', capabilities: {} }),
      providerExecutor: async () => ({
        ok: false, exitCode: 1, stdout: '',
        stderr: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
        used_model: 'gpt-5-codex', requested_model: 'gpt-5-codex', resolved_model: 'gpt-5-codex',
      }),
      commandRunner: async () => { commandCalls += 1; return { ok: true, exitCode: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(commandCalls, 0);
    assert.equal(summary.status, 'completed_with_execution_errors');
    assert.equal(summary.quality_run_count, 0);
    assert.equal(summary.failed_run_count, 0);
    assert.equal(summary.execution_error_run_count, 1);
    assert.equal(summary.recommendation, null);
    assert.equal(summary.runs[0].quality_eligible, false);
    assert.equal(summary.runs[0].execution_error.category, 'model_access_denied');
    assert.equal(summary.variant_results[0].average_score, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('live scenario runner treats an unrecognized non-zero CLI exit as operational, not quality evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scenario-generic-cli-failure-'));
  const scenarioPath = path.join(root, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify({
    id: 'generic_cli_failure', goal: 'Create output',
    fixture: { files: { 'input.txt': 'x' } },
    matrix: [{ provider: 'codex', model: 'gpt-test' }],
    expectations: { provider_ok: true, commands: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
  }));
  let commandCalls = 0;
  try {
    const summary = await runLiveScenarioSuite({
      scenarioFiles: [scenarioPath], outputDir: path.join(root, 'out'),
      capabilityProbe: async () => ({ provider: 'codex', cli_available: true, cli_version: 'codex-cli 1.0.0', capabilities: {} }),
      providerExecutor: async () => ({ ok: false, exitCode: 7, stdout: '', stderr: 'unexpected provider subprocess failure', used_model: 'gpt-test' }),
      commandRunner: async () => { commandCalls += 1; return { ok: true, exitCode: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(commandCalls, 0);
    assert.equal(summary.status, 'completed_with_execution_errors');
    assert.equal(summary.quality_run_count, 0);
    assert.equal(summary.failed_run_count, 0);
    assert.equal(summary.execution_error_run_count, 1);
    assert.equal(summary.runs[0].execution_error.category, 'provider_execution_failed');
    assert.equal(summary.runs[0].execution_error.retryable, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('stored live scenario summaries can be reclassified without rerunning the provider', () => {
  const stored = {
    schema_version: 'ddalggak.harness_evaluation_summary/v1',
    evaluation_id: 'eval-old',
    suite: 'live',
    status: 'completed_with_failures',
    started_at: '2026-07-13T00:00:00.000Z',
    finished_at: '2026-07-13T00:00:04.000Z',
    total_run_count: 1,
    passed_run_count: 0,
    failed_run_count: 1,
    runs: [{
      schema_version: 'ddalggak.live_scenario_run_result/v1',
      evaluation_id: 'eval-old',
      run_id: 'run-old',
      scenario_id: 'coding',
      harness_variant_id: 'code_executor.codex.default.high.v1',
      provider: 'codex',
      model: 'gpt-5-codex',
      reasoning_effort: 'high',
      cli_version: 'codex-cli 0.144.1',
      runtime_signature: 'code_executor.codex.default.high.v1|codex|gpt-5-codex|high|codex-cli 0.144.1',
      passed: false,
      score: 0.4,
      duration_ms: 3980,
      provider_result: {
        ok: false,
        exit_code: 1,
        stdout: '',
        stderr: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    }],
  };
  const corrected = reconcileStoredLiveScenarioSummary(stored);
  assert.equal(corrected.status, 'completed_with_execution_errors');
  assert.equal(corrected.failed_run_count, 0);
  assert.equal(corrected.quality_run_count, 0);
  assert.equal(corrected.execution_error_run_count, 1);
  assert.equal(corrected.variant_results[0].average_score, null);
  assert.equal(corrected.recommendation, null);
  assert.equal(corrected.runs[0].outcome, 'execution_error');
  assert.equal(corrected.runs[0].execution_error.category, 'model_access_denied');
  assert.equal(corrected.runs[0].provider_result.execution_error.exit_code, 1);
  assert.equal(corrected.reconciliation.newly_classified_execution_error_run_count, 1);
});
