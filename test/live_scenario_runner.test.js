import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLiveScenarioSuite } from '../src/evaluation/live_scenario_runner.js';

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
