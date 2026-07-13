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
    assert.equal(first.counts.failed, 1);
    failClaude = false;
    const second = await runAllModelBenchmark({ resumeDir: out, execute: true, retryFailed: true, liveScenarioRunner: fakeRunner });
    assert.equal(second.counts.passed, 2);
    assert.equal(second.counts.failed, 0);
    assert.deepEqual(calls, ['claude', 'codex', 'claude']);
    assert.equal(fs.existsSync(path.join(out, 'results.tsv')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
