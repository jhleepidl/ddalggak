#!/usr/bin/env node
import path from 'node:path';

import { listPendingModelBenchmarks, recordModelExecutionIneligibility } from '../src/application/model_catalog_refresh.js';
import { runLiveScenarioSuite } from '../src/evaluation/live_scenario_runner.js';
import { shouldMarkModelExecutionIneligible } from '../src/evaluation/provider_execution_classification.js';
import { sanitizeProviderCliVersion } from '../src/evaluation/provider_capability_registry.js';

function arg(name, fallback = '') {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
    if (argv[i] === `--${name}`) return argv[i + 1] || fallback;
  }
  return fallback;
}

function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

const providerFilter = String(arg('provider', '')).trim().toLowerCase();
const scenario = path.resolve(arg('scenario', 'scenarios/live/coding_smoke.json'));
const repeat = Math.max(1, Math.min(Number(arg('repeat', process.env.MODEL_BENCHMARK_MIN_RUNS || 3)) || 3, 20));
const limit = Math.max(1, Math.min(Number(arg('limit', 10)) || 10, 50));
const reasoningEffort = String(arg('reasoning', 'high')).trim();
const execute = flag('execute');
const syncToGoc = flag('sync-goc');
const candidates = listPendingModelBenchmarks()
  .filter((row) => !providerFilter || String(row.provider || '').toLowerCase() === providerFilter)
  .slice(0, limit);

if (!candidates.length) {
  console.log('No pending model benchmark candidates.');
  process.exit(0);
}

console.log(`Pending model benchmark plan · candidates=${candidates.length} · repeat=${repeat} · scenario=${scenario}`);
for (const row of candidates) {
  console.log(`- ${row.provider}/${row.model} · status=${row.benchmark_status} · cli=${sanitizeProviderCliVersion(row.discovered_cli_version) || '-'}`);
}

if (!execute) {
  console.log('\nDry plan only. Add --execute to run live provider CLIs and incur provider usage/cost.');
  process.exit(0);
}

for (const row of candidates) {
  console.log(`\n[benchmark] ${row.provider}/${row.model}`);
  const result = await runLiveScenarioSuite({
    scenarioFiles: [scenario],
    provider: row.provider,
    model: row.model,
    reasoningEffort,
    repeat,
    syncToGoc,
  });
  const executionErrors = Array.isArray(result.runs)
    ? result.runs.map((run) => run?.execution_error || run?.provider_result?.execution_error).filter((entry) => entry?.kind === 'execution_error')
    : [];
  const modelIneligibility = executionErrors.find((entry) => shouldMarkModelExecutionIneligible(entry));
  if (Number(result.quality_run_count || 0) === 0 && modelIneligibility) {
    recordModelExecutionIneligibility({
      provider: row.provider,
      model: row.model,
      category: modelIneligibility.category,
      reason: modelIneligibility.message,
      retryable: false,
      errorScope: modelIneligibility.scope || 'model',
      evaluationId: result.evaluation_id,
      runId: result.runs?.[0]?.run_id || '',
      cliVersion: result.runs?.[0]?.cli_version || row.discovered_cli_version || '',
    });
  }
  console.log(JSON.stringify({
    evaluation_id: result.evaluation_id,
    status: result.status,
    total_run_count: result.total_run_count,
    passed_run_count: result.passed_run_count,
    execution_error_run_count: result.execution_error_run_count || 0,
    quality_run_count: result.quality_run_count || 0,
    recommendation: result.recommendation,
  }, null, 2));
}
