import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAllModelBenchmarkPlan, listDiscoveredBenchmarkModels, runAllModelBenchmark } from '../src/evaluation/all_model_benchmark_runner.js';

function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-all-'));
  const catalog = path.join(root, 'models.json');
  const registry = path.join(root, 'registry.json');
  const scenario = path.join(root, 'scenario.json');
  writeJson(catalog, { nodes: [
    { provider: 'codex', model: 'gpt-test', discovery_runtime: { cli_available: true, cli_version: 'codex 1' } },
    { provider: 'claude', model: 'sonnet-test', discovery_runtime: { cli_available: true, cli_version: 'claude 1' } },
  ] });
  writeJson(registry, { entries: {
    'codex:gpt-test': { provider: 'codex', model: 'gpt-test', availability: 'available', benchmark_status: 'evaluated' },
    'claude:sonnet-test': { provider: 'claude', model: 'sonnet-test', availability: 'available', benchmark_status: 'benchmark_pending' },
  }, benchmark_candidates: [{ provider: 'claude', model: 'sonnet-test', availability: 'available' }] });
  writeJson(scenario, {
    id: 'task', goal: 'Create output', role: 'task_worker',
    matrix: [{ provider: 'codex', role: 'task_worker', harness_variant_id: 'task_worker.codex.default.medium.v1' }],
    fixture: { files: { 'input.txt': 'x' } }, expectations: { provider_ok: true },
  });
  return { root, catalog, registry, scenario };
}

test('all-model plan maps provider overrides to provider-compatible variants', () => {
  const f = fixture();
  try {
    const models = listDiscoveredBenchmarkModels({ catalogPath: f.catalog, registryPath: f.registry });
    const plan = buildAllModelBenchmarkPlan({ models, scenarioFiles: [f.scenario], repeat: 2 });
    assert.equal(plan.length, 2);
    assert.equal(plan.find((row) => row.provider === 'codex').harness_variant_id, 'task_worker.codex.default.medium.v1');
    assert.equal(plan.find((row) => row.provider === 'claude').harness_variant_id, 'task_worker.claude.default.medium.v1');
    assert.equal(plan.every((row) => row.repeat === 2), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('provider-default selector stays distinct in the matrix but omits the CLI model override', () => {
  const f = fixture();
  try {
    const defaultCatalog = path.join(f.root, 'default-models.json');
    const defaultRegistry = path.join(f.root, 'default-registry.json');
    writeJson(defaultCatalog, { nodes: [
      { provider: 'antigravity', model: '@default', model_catalog: { default_selector: true }, discovery_runtime: { cli_available: true, cli_version: 'agy 1' } },
    ] });
    writeJson(defaultRegistry, { entries: {
      'antigravity:@default': { provider: 'antigravity', model: '@default', availability: 'available', benchmark_status: 'unbenchmarked' },
    } });
    const models = listDiscoveredBenchmarkModels({ catalogPath: defaultCatalog, registryPath: defaultRegistry });
    const plan = buildAllModelBenchmarkPlan({ models, scenarioFiles: [f.scenario], repeat: 1 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].model, '@default');
    assert.equal(plan[0].execution_model, '');
    assert.equal(plan[0].harness_variant_id, 'task_worker.antigravity.default.v1');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('pending-only filtering uses model lifecycle registry', () => {
  const f = fixture();
  try {
    const rows = listDiscoveredBenchmarkModels({ catalogPath: f.catalog, registryPath: f.registry, pendingOnly: true });
    assert.deepEqual(rows.map((row) => `${row.provider}:${row.model}`), ['claude:sonnet-test']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('all-model runner checkpoints, resumes, and retries only failed cases', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix');
  const calls = [];
  try {
    const plan = await runAllModelBenchmark({
      catalogPath: f.catalog, lifecycleRegistryPath: f.registry, scenarioFiles: [f.scenario], scenarioDir: '', outputDir: out,
    });
    assert.equal(plan.plan_only, true);
    assert.equal(plan.counts.total, 2);

    let failClaude = true;
    const fakeRunner = async (options) => {
      calls.push(options.provider);
      if (options.provider === 'claude' && failClaude) throw new Error('temporary failure');
      return { evaluation_id: `e-${options.provider}`, status: 'passed', total_run_count: 1, passed_run_count: 1, failed_run_count: 0, variant_results: [], output_dir: options.outputDir };
    };
    const first = await runAllModelBenchmark({ resumeDir: out, execute: true, liveScenarioRunner: fakeRunner });
    assert.equal(first.counts.passed, 1);
    assert.equal(first.counts.failed, 0);
    assert.equal(first.counts.execution_error, 1);
    assert.equal(first.quality_case_count, 1);
    failClaude = false;
    const second = await runAllModelBenchmark({ resumeDir: out, execute: true, retryFailed: true, liveScenarioRunner: fakeRunner });
    assert.equal(second.counts.passed, 2);
    assert.equal(second.counts.failed, 0);
    assert.equal(second.counts.execution_error, 0);
    assert.deepEqual(calls, ['claude', 'codex', 'claude']);
    assert.equal(fs.existsSync(path.join(out, 'results.tsv')), true);
    assert.equal(fs.existsSync(path.join(out, 'execution_errors.tsv')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('all-model runner skips non-retryable execution-ineligible models, records lifecycle state, and audits resume flags', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix-access-denied');
  const calls = [];
  try {
    await runAllModelBenchmark({
      catalogPath: f.catalog,
      lifecycleRegistryPath: f.registry,
      scenarioFiles: [f.scenario],
      scenarioDir: '',
      outputDir: out,
      providers: ['codex'],
      models: ['gpt-test'],
    });
    const result = await runAllModelBenchmark({
      resumeDir: out,
      execute: true,
      syncToGoc: true,
      lifecycleRegistryPath: f.registry,
      liveScenarioRunner: async (options) => {
        calls.push(options);
        return {
          evaluation_id: 'e-access',
          status: 'completed_with_execution_errors',
          total_run_count: 1,
          passed_run_count: 0,
          failed_run_count: 0,
          execution_error_run_count: 1,
          quality_run_count: 0,
          variant_results: [{
            runtime_signature: 'v|codex|gpt-test|medium|codex-cli 1',
            average_score: null,
            average_duration_ms: 10,
            quality_run_count: 0,
            execution_error_run_count: 1,
          }],
          runs: [{
            run_id: 'r-access',
            cli_version: 'codex-cli 1',
            execution_error: {
              kind: 'execution_error',
              category: 'model_access_denied',
              retryable: false,
              quality_eligible: false,
              message: 'model unavailable for current account',
            },
          }],
          output_dir: options.outputDir,
          goc_sync: { synced: true },
        };
      },
    });
    assert.equal(result.counts.skipped, 1);
    assert.equal(result.counts.failed, 0);
    assert.equal(result.status, 'passed_with_skips');
    assert.equal(calls[0].syncToGoc, true);
    const state = JSON.parse(fs.readFileSync(path.join(out, 'state.json'), 'utf8'));
    assert.equal(state.options.syncToGoc, true);
    assert.equal(state.resume_history.at(-1).sync_to_goc, true);
    const row = Object.values(state.cases)[0];
    assert.equal(row.status, 'skipped');
    assert.equal(row.execution_error_category, 'model_access_denied');
    assert.equal(row.summary.goc_sync.synced, true);
    const registry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    assert.equal(registry.entries['codex:gpt-test'].benchmark_status, 'execution_ineligible');
    assert.equal(registry.entries['codex:gpt-test'].execution_eligibility, 'ineligible');
    assert.equal(registry.benchmark_candidates.some((item) => item.model === 'gpt-test'), false);
    const rediscovered = listDiscoveredBenchmarkModels({ catalogPath: f.catalog, registryPath: f.registry });
    assert.equal(rediscovered.some((item) => item.model === 'gpt-test'), false);
    const included = listDiscoveredBenchmarkModels({ catalogPath: f.catalog, registryPath: f.registry, includeUnavailable: true });
    assert.equal(included.some((item) => item.model === 'gpt-test'), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});



test('explicit retry-failed re-executes a previously skipped model after credentials change', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix-retry-ineligible');
  let accessDenied = true;
  let calls = 0;
  try {
    await runAllModelBenchmark({
      catalogPath: f.catalog,
      lifecycleRegistryPath: f.registry,
      scenarioFiles: [f.scenario],
      scenarioDir: '',
      outputDir: out,
      providers: ['codex'],
      models: ['gpt-test'],
    });
    const fakeRunner = async (options) => {
      calls += 1;
      if (accessDenied) return {
        evaluation_id: 'e-denied',
        status: 'completed_with_execution_errors',
        total_run_count: 1,
        passed_run_count: 0,
        failed_run_count: 0,
        execution_error_run_count: 1,
        quality_run_count: 0,
        variant_results: [],
        runs: [{
          run_id: 'r-denied',
          execution_error: {
            kind: 'execution_error',
            category: 'model_access_denied',
            retryable: false,
            lifecycle_action: 'mark_model_ineligible',
            quality_eligible: false,
            message: 'model unavailable for current account',
          },
        }],
        output_dir: options.outputDir,
      };
      return {
        evaluation_id: 'e-now-available',
        status: 'passed',
        total_run_count: 1,
        passed_run_count: 1,
        failed_run_count: 0,
        execution_error_run_count: 0,
        quality_run_count: 1,
        variant_results: [],
        runs: [{ run_id: 'r-success', passed: true, score: 1 }],
        output_dir: options.outputDir,
      };
    };

    const first = await runAllModelBenchmark({ resumeDir: out, execute: true, lifecycleRegistryPath: f.registry, liveScenarioRunner: fakeRunner });
    assert.equal(first.status, 'passed_with_skips');
    assert.equal(first.counts.skipped, 1);

    accessDenied = false;
    const second = await runAllModelBenchmark({ resumeDir: out, execute: true, retryFailed: true, lifecycleRegistryPath: f.registry, liveScenarioRunner: fakeRunner });
    assert.equal(second.status, 'passed');
    assert.equal(second.counts.passed, 1);
    assert.equal(second.counts.skipped, 0);
    assert.equal(calls, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('resume reconciles stored access-denied artifacts and repairs GoC without a provider rerun', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix-reconcile');
  const syncCalls = [];
  let providerCalls = 0;
  try {
    await runAllModelBenchmark({
      catalogPath: f.catalog,
      lifecycleRegistryPath: f.registry,
      scenarioFiles: [f.scenario],
      scenarioDir: '',
      outputDir: out,
      providers: ['codex'],
      models: ['gpt-test'],
    });
    const stateFile = path.join(out, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const row = Object.values(state.cases)[0];
    const evaluationDir = path.join(out, 'cases', `codex__gpt-test__task__${row.case_id}`, 'eval-old');
    row.status = 'failed';
    row.evaluation_dir = evaluationDir;
    row.cli_version = JSON.stringify({ models: [{ slug: 'gpt-test' }] });
    row.summary = { evaluation_id: 'eval-old', total_run_count: 1, passed_run_count: 0, failed_run_count: 1, variant_results: [] };
    const modelsFile = path.join(out, 'models.json');
    const storedModels = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    storedModels[0].cli_version = row.cli_version;
    writeJson(modelsFile, storedModels);
    const planFile = path.join(out, 'plan.json');
    const storedPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    storedPlan.cases[0].cli_version = row.cli_version;
    writeJson(planFile, storedPlan);
    writeJson(path.join(evaluationDir, 'summary.json'), {
      schema_version: 'ddalggak.harness_evaluation_summary/v1',
      evaluation_id: 'eval-old',
      suite: 'live',
      status: 'completed_with_failures',
      started_at: '2026-07-13T00:00:00.000Z',
      finished_at: '2026-07-13T00:00:04.000Z',
      total_run_count: 1,
      passed_run_count: 0,
      failed_run_count: 1,
      variant_results: [],
      runs: [{
        evaluation_id: 'eval-old',
        run_id: 'run-old',
        scenario_id: 'task',
        harness_variant_id: row.harness_variant_id,
        provider: 'codex',
        model: 'gpt-test',
        reasoning_effort: row.reasoning_effort,
        cli_version: 'codex-cli 0.144.1',
        runtime_signature: `${row.harness_variant_id}|codex|gpt-test|${row.reasoning_effort}|codex-cli 0.144.1`,
        passed: false,
        score: 0.4,
        duration_ms: 4000,
        provider_result: {
          ok: false,
          exit_code: 1,
          stderr: "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.",
        },
      }],
    });
    writeJson(path.join(evaluationDir, 'runs', 'run-old', 'result.json'), { stale: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const result = await runAllModelBenchmark({
      resumeDir: out,
      syncToGoc: true,
      lifecycleRegistryPath: f.registry,
      liveScenarioRunner: async () => { providerCalls += 1; throw new Error('must not run'); },
      evaluationSync: async (summary) => { syncCalls.push(summary); return { synced: true, repaired: true }; },
    });
    assert.equal(result.plan_only, true);
    assert.equal(result.counts.skipped, 1);
    assert.equal(result.counts.failed, 0);
    assert.equal(providerCalls, 0);
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].quality_run_count, 0);
    assert.equal(syncCalls[0].execution_error_run_count, 1);
    const correctedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const correctedRow = Object.values(correctedState.cases)[0];
    assert.equal(correctedRow.status, 'skipped');
    assert.equal(correctedRow.execution_error_category, 'model_access_denied');
    assert.equal(correctedRow.summary.goc_sync.repaired, true);
    assert.equal(correctedState.reconciliation_history.at(-1).cases[0].status, 'skipped');
    assert.equal(correctedState.reconciliation_history.at(-1).cases[0].cli_version_changed, true);
    assert.equal(correctedRow.cli_version, 'codex-cli 0.144.1');
    assert.equal(correctedState.metadata_reconciliation_history.at(-1).kind, 'cli_version_metadata');
    assert.equal(JSON.parse(fs.readFileSync(modelsFile, 'utf8'))[0].cli_version, 'codex-cli 0.144.1');
    assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf8')).cases[0].cli_version, 'codex-cli 0.144.1');
    const correctedSummary = JSON.parse(fs.readFileSync(path.join(evaluationDir, 'summary.json'), 'utf8'));
    assert.equal(correctedSummary.status, 'completed_with_execution_errors');
    assert.equal(correctedSummary.runs[0].quality_eligible, false);
    assert.equal(fs.existsSync(path.join(evaluationDir, 'reconciliation.json')), true);
    const registry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    assert.equal(registry.entries['codex:gpt-test'].execution_eligibility, 'ineligible');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('retryable provider execution errors stay outside quality counts and remain retryable', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix-rate-limit');
  let rateLimited = true;
  try {
    await runAllModelBenchmark({
      catalogPath: f.catalog,
      lifecycleRegistryPath: f.registry,
      scenarioFiles: [f.scenario],
      scenarioDir: '',
      outputDir: out,
      providers: ['codex'],
      models: ['gpt-test'],
    });
    const fakeRunner = async (options) => rateLimited ? {
      evaluation_id: 'e-rate-limit',
      status: 'completed_with_execution_errors',
      total_run_count: 1,
      passed_run_count: 0,
      failed_run_count: 0,
      execution_error_run_count: 1,
      quality_run_count: 0,
      variant_results: [{
        runtime_signature: 'v|codex|gpt-test|medium|codex-cli 1',
        average_score: null,
        average_duration_ms: 10,
        quality_run_count: 0,
        execution_error_run_count: 1,
      }],
      runs: [{
        run_id: 'r-rate-limit',
        execution_error: {
          kind: 'execution_error',
          category: 'rate_limited',
          retryable: true,
          lifecycle_action: 'retry',
          quality_eligible: false,
          message: 'rate limit exceeded',
        },
      }],
      output_dir: options.outputDir,
    } : {
      evaluation_id: 'e-success',
      status: 'passed',
      total_run_count: 1,
      passed_run_count: 1,
      failed_run_count: 0,
      execution_error_run_count: 0,
      quality_run_count: 1,
      variant_results: [],
      runs: [],
      output_dir: options.outputDir,
    };
    const first = await runAllModelBenchmark({ resumeDir: out, execute: true, lifecycleRegistryPath: f.registry, liveScenarioRunner: fakeRunner });
    assert.equal(first.status, 'completed_with_execution_errors');
    assert.equal(first.counts.execution_error, 1);
    assert.equal(first.counts.failed, 0);
    assert.equal(first.quality_case_count, 0);
    assert.equal(first.execution_error_case_count, 1);
    const registryBeforeRetry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    assert.notEqual(registryBeforeRetry.entries['codex:gpt-test'].execution_eligibility, 'ineligible');

    rateLimited = false;
    const second = await runAllModelBenchmark({ resumeDir: out, execute: true, retryFailed: true, lifecycleRegistryPath: f.registry, liveScenarioRunner: fakeRunner });
    assert.equal(second.status, 'passed');
    assert.equal(second.counts.passed, 1);
    assert.equal(second.counts.execution_error, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('resume with sync-goc re-sends an already-correct stored evaluation without provider execution', async () => {
  const f = fixture();
  const out = path.join(f.root, 'matrix-resync-correct');
  const syncCalls = [];
  let providerCalls = 0;
  try {
    await runAllModelBenchmark({
      catalogPath: f.catalog,
      lifecycleRegistryPath: f.registry,
      scenarioFiles: [f.scenario],
      scenarioDir: '',
      outputDir: out,
      providers: ['codex'],
      models: ['gpt-test'],
    });
    const stateFile = path.join(out, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const row = Object.values(state.cases)[0];
    const evaluationDir = path.join(out, 'cases', `codex__gpt-test__task__${row.case_id}`, 'eval-correct');
    row.status = 'passed';
    row.evaluation_dir = evaluationDir;
    row.summary = { evaluation_id: 'eval-correct', total_run_count: 1, passed_run_count: 1, failed_run_count: 0, quality_run_count: 1, execution_error_run_count: 0, variant_results: [] };
    writeJson(path.join(evaluationDir, 'summary.json'), {
      schema_version: 'ddalggak.harness_evaluation_summary/v1',
      evaluation_id: 'eval-correct',
      suite: 'live',
      status: 'passed',
      started_at: '2026-07-13T00:00:00.000Z',
      finished_at: '2026-07-13T00:01:00.000Z',
      scenario_count: 1,
      total_run_count: 1,
      passed_run_count: 1,
      failed_run_count: 0,
      execution_error_run_count: 0,
      quality_run_count: 1,
      variant_results: [],
      runs: [{
        evaluation_id: 'eval-correct',
        run_id: 'run-correct',
        scenario_id: 'task',
        passed: true,
        score: 1,
        quality_eligible: true,
        provider_result: { ok: true, exit_code: 0, stdout: '', stderr: '' },
      }],
    });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const result = await runAllModelBenchmark({
      resumeDir: out,
      syncToGoc: true,
      liveScenarioRunner: async () => { providerCalls += 1; throw new Error('must not run'); },
      evaluationSync: async (summary) => { syncCalls.push(summary); return { synced: true }; },
    });
    assert.equal(result.plan_only, true);
    assert.equal(providerCalls, 0);
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].evaluation_id, 'eval-correct');
    const correctedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(correctedState.options.syncToGoc, true);
    assert.equal(correctedState.reconciliation_history.at(-1).cases[0].summary_changed, false);
    assert.equal(correctedState.reconciliation_history.at(-1).cases[0].goc_sync.synced, true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
