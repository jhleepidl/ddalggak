import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadLiveScenario, normalizeScenarioMatrix, runLiveScenarioSuite } from './live_scenario_runner.js';
import { loadHarnessVariantRegistry, resolveHarnessVariant } from './harness_variant_registry.js';
import {
  listPendingModelBenchmarks,
  modelDiscoveryRegistryPath,
  modelNodesDiscoveredConfigPath,
  readJson,
  refreshModelCatalog,
} from '../application/model_catalog_refresh.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function nowIso() { return new Date().toISOString(); }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'; }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value ?? ''), 'utf8'); }
function appendJsonl(file, value) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value ?? '')).digest('hex'); }
function caseId(row = {}) {
  return sha256([row.provider, row.model, row.scenario_id, row.matrix_index, row.harness_variant_id, row.reasoning_effort, row.repeat].join('|')).slice(0, 16);
}
function modelKey(provider = '', model = '') { return `${clean(provider).toLowerCase()}:${clean(model).toLowerCase()}`; }
function tsvCell(value = '') { return String(value ?? '').replace(/[\t\r\n]+/g, ' '); }

export function listDiscoveredBenchmarkModels({
  catalogPath = modelNodesDiscoveredConfigPath(),
  registryPath = modelDiscoveryRegistryPath(),
  providers = [],
  models = [],
  pendingOnly = false,
  includeUnavailable = false,
  maxModels = 0,
} = {}) {
  const allowedProviders = new Set((providers.length ? providers : ['codex', 'claude', 'antigravity']).map((x) => clean(x).toLowerCase()));
  const allowedModels = new Set(asArray(models).map(clean).filter(Boolean));
  const registry = readJson(registryPath) || {};
  const entries = asObject(registry.entries);
  const pending = new Set(listPendingModelBenchmarks({ registryPath }).map((row) => modelKey(row.provider, row.model)));
  const catalog = readJson(catalogPath) || {};
  const byKey = new Map();

  for (const node of asArray(catalog.nodes)) {
    const provider = clean(node?.provider).toLowerCase();
    const model = clean(node?.model);
    if (!allowedProviders.has(provider) || !model) continue;
    const key = modelKey(provider, model);
    const lifecycle = asObject(entries[key]);
    const availability = clean(lifecycle.availability || 'available').toLowerCase();
    if (!includeUnavailable && availability === 'unavailable') continue;
    if (node?.discovery_runtime?.cli_available === false && !includeUnavailable) continue;
    if (allowedModels.size && !allowedModels.has(model) && !allowedModels.has(key)) continue;
    if (pendingOnly && !pending.has(key)) continue;
    byKey.set(key, {
      provider,
      model,
      availability,
      benchmark_status: clean(lifecycle.benchmark_status) || 'unknown',
      cli_version: clean(node?.discovery_runtime?.cli_version || lifecycle.discovered_cli_version) || null,
      discovery_source: clean(node?.model_catalog?.discovered_from || lifecycle.discovery_source) || null,
    });
  }

  // Registry fallback keeps the command useful when a valid lifecycle registry exists
  // but the presentation catalog was moved or regenerated separately.
  if (!asArray(catalog.nodes).length) for (const lifecycle of Object.values(entries)) {
    const provider = clean(lifecycle?.provider).toLowerCase();
    const model = clean(lifecycle?.model);
    const key = modelKey(provider, model);
    if (byKey.has(key) || !allowedProviders.has(provider) || !model) continue;
    const availability = clean(lifecycle.availability || 'available').toLowerCase();
    if (!includeUnavailable && availability === 'unavailable') continue;
    if (allowedModels.size && !allowedModels.has(model) && !allowedModels.has(key)) continue;
    if (pendingOnly && !pending.has(key)) continue;
    byKey.set(key, {
      provider,
      model,
      availability,
      benchmark_status: clean(lifecycle.benchmark_status) || 'unknown',
      cli_version: clean(lifecycle.discovered_cli_version) || null,
      discovery_source: clean(lifecycle.discovery_source) || null,
    });
  }

  const rows = [...byKey.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return maxModels > 0 ? rows.slice(0, maxModels) : rows;
}

export function resolveBenchmarkScenarioFiles({ scenarioFiles = [], scenarioDir = 'scenarios/live' } = {}) {
  let files = asArray(scenarioFiles).map((file) => path.resolve(file));
  if (clean(scenarioDir)) {
    const dir = path.resolve(scenarioDir);
    if (fs.existsSync(dir)) {
      files.push(...fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)));
    }
  }
  return [...new Set(files)].filter((file) => fs.existsSync(file)).sort();
}

export function buildAllModelBenchmarkPlan({ models = [], scenarioFiles = [], repeat = 1, registryPath = '' } = {}) {
  const registry = loadHarnessVariantRegistry({ registryPath, cwd: process.cwd() });
  const cases = [];
  for (const scenarioFile of scenarioFiles) {
    const scenario = loadLiveScenario(scenarioFile);
    for (const modelRow of models) {
      const cells = normalizeScenarioMatrix(scenario, { provider: modelRow.provider, model: modelRow.model, repeat: 1 });
      cells.forEach((cell, matrixIndex) => {
        const variant = resolveHarnessVariant({
          registry,
          variantId: cell.harness_variant_id,
          provider: cell.provider,
          role: cell.role,
          model: modelRow.model,
          reasoningEffort: cell.reasoning_effort,
        });
        const row = {
          provider: modelRow.provider,
          model: modelRow.model,
          cli_version: modelRow.cli_version || null,
          benchmark_status: modelRow.benchmark_status || 'unknown',
          scenario_id: scenario.id,
          scenario_title: scenario.title || scenario.id,
          scenario_file: scenarioFile,
          matrix_index: matrixIndex,
          role: cell.role,
          harness_variant_id: variant.id,
          reasoning_effort: variant.reasoning_effort,
          repeat: Math.max(1, Math.min(Number(repeat) || 1, 20)),
        };
        row.case_id = caseId(row);
        cases.push(row);
      });
    }
  }
  return cases;
}

function initialState({ matrixId, root, cases, options }) {
  return {
    schema_version: 'ddalggak.all_model_benchmark/v1',
    matrix_id: matrixId,
    output_dir: root,
    status: 'planned',
    created_at: nowIso(),
    updated_at: nowIso(),
    options,
    cases: Object.fromEntries(cases.map((row) => [row.case_id, { ...row, status: 'pending', attempts: 0, evaluation_dir: null, summary: null, error: null }])),
  };
}

function summarizeState(state = {}) {
  const rows = Object.values(asObject(state.cases));
  const counts = { total: rows.length, pending: 0, running: 0, passed: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const key = counts[row.status] === undefined ? 'failed' : row.status;
    counts[key] += 1;
  }
  return counts;
}

function writeMatrixArtifacts(root, state) {
  const rows = Object.values(asObject(state.cases)).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.scenario_id.localeCompare(b.scenario_id));
  const headers = ['case_id','provider','model','scenario_id','matrix_index','role','harness_variant_id','reasoning_effort','repeat','status','attempts','passed_runs','failed_runs','average_score','average_duration_ms','evaluation_dir','error'];
  const lines = [headers.join('\t')];
  const failures = [];
  const evalDirs = [];
  for (const row of rows) {
    const summary = asObject(row.summary);
    const variants = asArray(summary.variant_results);
    const avgScore = variants.length ? variants.reduce((sum, item) => sum + Number(item.average_score || 0), 0) / variants.length : '';
    const avgDuration = variants.length ? variants.reduce((sum, item) => sum + Number(item.average_duration_ms || 0), 0) / variants.length : '';
    const values = [row.case_id,row.provider,row.model,row.scenario_id,row.matrix_index,row.role,row.harness_variant_id,row.reasoning_effort,row.repeat,row.status,row.attempts,summary.passed_run_count ?? '',summary.failed_run_count ?? '',avgScore,avgDuration,row.evaluation_dir || '',row.error || ''];
    lines.push(values.map(tsvCell).join('\t'));
    if (row.status === 'failed') failures.push(values.map(tsvCell).join('\t'));
    if (row.evaluation_dir) evalDirs.push(row.evaluation_dir);
  }
  writeText(path.join(root, 'results.tsv'), `${lines.join('\n')}\n`);
  writeText(path.join(root, 'failures.tsv'), failures.length ? `${headers.join('\t')}\n${failures.join('\n')}\n` : '');
  writeText(path.join(root, 'evaluation_dirs.txt'), evalDirs.length ? `${evalDirs.join('\n')}\n` : '');
  const counts = summarizeState(state);
  const providerCounts = {};
  for (const row of rows) providerCounts[row.provider] = (providerCounts[row.provider] || 0) + 1;
  const summary = {
    schema_version: 'ddalggak.all_model_benchmark_summary/v1',
    matrix_id: state.matrix_id,
    status: counts.failed ? 'completed_with_failures' : (counts.pending || counts.running ? state.status : 'passed'),
    created_at: state.created_at,
    updated_at: state.updated_at,
    counts,
    provider_case_counts: providerCounts,
    planned_provider_calls: rows.reduce((sum, row) => sum + Number(row.repeat || 1), 0),
    output_dir: root,
  };
  writeJson(path.join(root, 'summary.json'), summary);
  writeText(path.join(root, 'SUMMARY.md'), [
    '# All-model benchmark matrix', '',
    `- Matrix: ${state.matrix_id}`,
    `- Status: ${summary.status}`,
    `- Cases: ${counts.total}`,
    `- Planned provider calls: ${summary.planned_provider_calls}`,
    `- Passed cases: ${counts.passed}`,
    `- Failed cases: ${counts.failed}`,
    `- Pending cases: ${counts.pending}`,
    '',
    'Review `results.tsv`, `failures.tsv`, `state.json`, and each case evaluation directory.',
    '',
  ].join('\n'));
  return summary;
}

export async function runAllModelBenchmark({
  outputDir = '', resumeDir = '', scenarioFiles = [], scenarioDir = 'scenarios/live', providers = [], models = [], repeat = 1,
  pendingOnly = false, includeUnavailable = false, maxModels = 0, execute = false, refresh = false, retryFailed = false,
  failFast = false, syncToGoc = false, keepWorkspaces = true, registryPath = '', catalogPath = '', lifecycleRegistryPath = '',
  liveScenarioRunner = runLiveScenarioSuite, refreshCatalog = refreshModelCatalog,
} = {}) {
  if (refresh) await refreshCatalog({ force: true, reason: 'models_bench_all_manual_refresh' });

  let root;
  let state;
  if (clean(resumeDir)) {
    root = path.resolve(resumeDir);
    state = readJson(path.join(root, 'state.json'));
    if (!state) throw new Error(`Benchmark state not found: ${path.join(root, 'state.json')}`);
    if (retryFailed) {
      for (const row of Object.values(asObject(state.cases))) {
        if (row.status === 'failed') Object.assign(row, { status: 'pending', error: null });
      }
    }
  } else {
    const discovered = listDiscoveredBenchmarkModels({
      catalogPath: clean(catalogPath) || modelNodesDiscoveredConfigPath(),
      registryPath: clean(lifecycleRegistryPath) || modelDiscoveryRegistryPath(),
      providers, models, pendingOnly, includeUnavailable, maxModels,
    });
    if (!discovered.length) throw new Error('No discovered benchmark models. Run `npm run models:refresh` and inspect `npm run models:status`.');
    const scenarios = resolveBenchmarkScenarioFiles({ scenarioFiles, scenarioDir });
    if (!scenarios.length) throw new Error('No live scenario files found');
    const cases = buildAllModelBenchmarkPlan({ models: discovered, scenarioFiles: scenarios, repeat, registryPath });
    const created = nowIso();
    const matrixId = `model_matrix_${created.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
    root = ensureDir(path.resolve(outputDir || path.join('runs', 'evaluations', matrixId)));
    state = initialState({ matrixId, root, cases, options: { providers, models, repeat, pendingOnly, scenarioFiles: scenarios, scenarioDir, syncToGoc, keepWorkspaces } });
    writeJson(path.join(root, 'models.json'), discovered);
    writeJson(path.join(root, 'plan.json'), { schema_version: 'ddalggak.all_model_benchmark_plan/v1', matrix_id: matrixId, cases });
  }

  state.status = execute ? 'running' : 'planned';
  state.updated_at = nowIso();
  writeJson(path.join(root, 'state.json'), state);
  let summary = writeMatrixArtifacts(root, state);
  if (!execute) return { ...summary, state, output_dir: root, plan_only: true };

  for (const row of Object.values(asObject(state.cases))) {
    if (row.status === 'passed' || row.status === 'skipped') continue;
    if (row.status === 'failed' && !retryFailed) continue;
    row.status = 'running';
    row.attempts = Number(row.attempts || 0) + 1;
    row.started_at = nowIso();
    row.error = null;
    state.updated_at = nowIso();
    writeJson(path.join(root, 'state.json'), state);

    const caseDir = ensureDir(path.join(root, 'cases', `${safe(row.provider)}__${safe(row.model)}__${safe(row.scenario_id)}__${row.case_id}`));
    try {
      const result = await liveScenarioRunner({
        scenarioFiles: [row.scenario_file],
        outputDir: caseDir,
        provider: row.provider,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        variantId: row.harness_variant_id,
        repeat: row.repeat,
        matrixIndex: row.matrix_index,
        syncToGoc,
        keepWorkspaces,
      });
      row.summary = {
        evaluation_id: result.evaluation_id,
        status: result.status,
        total_run_count: result.total_run_count,
        passed_run_count: result.passed_run_count,
        failed_run_count: result.failed_run_count,
        variant_results: result.variant_results,
      };
      row.evaluation_dir = result.output_dir || caseDir;
      row.status = result.failed_run_count === 0 ? 'passed' : 'failed';
      if (row.status === 'failed') row.error = `live scenario completed with ${result.failed_run_count} failed run(s)`;
      appendJsonl(path.join(root, 'results.jsonl'), { case_id: row.case_id, ...row.summary, evaluation_dir: row.evaluation_dir });
    } catch (error) {
      row.status = 'failed';
      row.error = clean(error?.stack || error?.message || error);
      writeText(path.join(caseDir, 'runner_error.txt'), `${row.error}\n`);
      appendJsonl(path.join(root, 'results.jsonl'), { case_id: row.case_id, status: 'runner_failed', error: row.error });
    }
    row.completed_at = nowIso();
    state.updated_at = nowIso();
    writeJson(path.join(root, 'state.json'), state);
    summary = writeMatrixArtifacts(root, state);
    if (failFast && row.status === 'failed') break;
  }

  const counts = summarizeState(state);
  state.status = counts.pending || counts.running ? 'interrupted' : (counts.failed ? 'completed_with_failures' : 'passed');
  state.updated_at = nowIso();
  writeJson(path.join(root, 'state.json'), state);
  summary = writeMatrixArtifacts(root, state);
  return { ...summary, state, output_dir: root, plan_only: false };
}
