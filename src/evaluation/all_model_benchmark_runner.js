import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadLiveScenario, normalizeScenarioMatrix, reconcileStoredLiveScenarioSummary, runLiveScenarioSuite } from './live_scenario_runner.js';
import { syncHarnessEvaluationToGoc } from './live_scenario_goc_sync.js';
import { loadHarnessVariantRegistry, resolveHarnessVariant } from './harness_variant_registry.js';
import { sanitizeProviderCliVersion } from './provider_capability_registry.js';
import { shouldMarkModelExecutionIneligible } from './provider_execution_classification.js';
import {
  listPendingModelBenchmarks,
  modelDiscoveryRegistryPath,
  modelNodesDiscoveredConfigPath,
  recordModelExecutionIneligibility,
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
function executionModel(model = '') { return clean(model).toLowerCase() === '@default' ? '' : clean(model); }
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
    const executionEligibility = clean(lifecycle.execution_eligibility || 'unknown').toLowerCase();
    if (!includeUnavailable && executionEligibility === 'ineligible') continue;
    if (node?.discovery_runtime?.cli_available === false && !includeUnavailable) continue;
    if (allowedModels.size && !allowedModels.has(model) && !allowedModels.has(key)) continue;
    if (pendingOnly && !pending.has(key)) continue;
    byKey.set(key, {
      provider,
      model,
      availability,
      execution_eligibility: executionEligibility,
      execution_ineligibility: lifecycle.execution_ineligibility || null,
      benchmark_status: clean(lifecycle.benchmark_status) || 'unknown',
      cli_version: sanitizeProviderCliVersion(node?.discovery_runtime?.cli_version) || sanitizeProviderCliVersion(lifecycle.discovered_cli_version) || null,
      discovery_source: clean(node?.model_catalog?.discovered_from || lifecycle.discovery_source) || null,
      default_selector: node?.model_catalog?.default_selector === true || model.toLowerCase() === '@default',
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
    const executionEligibility = clean(lifecycle.execution_eligibility || 'unknown').toLowerCase();
    if (!includeUnavailable && executionEligibility === 'ineligible') continue;
    if (allowedModels.size && !allowedModels.has(model) && !allowedModels.has(key)) continue;
    if (pendingOnly && !pending.has(key)) continue;
    byKey.set(key, {
      provider,
      model,
      availability,
      execution_eligibility: executionEligibility,
      execution_ineligibility: lifecycle.execution_ineligibility || null,
      benchmark_status: clean(lifecycle.benchmark_status) || 'unknown',
      cli_version: sanitizeProviderCliVersion(lifecycle.discovered_cli_version) || null,
      discovery_source: clean(lifecycle.discovery_source) || null,
      default_selector: model.toLowerCase() === '@default',
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
      const runnableModel = modelRow.default_selector === true ? '' : executionModel(modelRow.model);
      const cells = normalizeScenarioMatrix(scenario, { provider: modelRow.provider, model: runnableModel, repeat: 1 });
      cells.forEach((cell, matrixIndex) => {
        const variant = resolveHarnessVariant({
          registry,
          variantId: cell.harness_variant_id,
          provider: cell.provider,
          role: cell.role,
          model: runnableModel,
          reasoningEffort: cell.reasoning_effort,
        });
        const row = {
          provider: modelRow.provider,
          model: modelRow.model,
          execution_model: runnableModel,
          cli_version: modelRow.cli_version || null,
          benchmark_status: modelRow.benchmark_status || 'unknown',
          execution_eligibility: modelRow.execution_eligibility || 'unknown',
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
  const counts = { total: rows.length, pending: 0, running: 0, passed: 0, failed: 0, execution_error: 0, skipped: 0 };
  for (const row of rows) {
    const key = counts[row.status] === undefined ? 'failed' : row.status;
    counts[key] += 1;
  }
  return counts;
}

function matrixStatus(counts = {}, fallback = 'planned') {
  if (Number(counts.pending || 0) > 0 || Number(counts.running || 0) > 0) return fallback;
  if (Number(counts.failed || 0) > 0) return 'completed_with_failures';
  if (Number(counts.execution_error || 0) > 0) return 'completed_with_execution_errors';
  if (Number(counts.skipped || 0) > 0) return 'passed_with_skips';
  return 'passed';
}


function resolveStoredEvaluationDir(root, row = {}) {
  const explicit = clean(row.evaluation_dir);
  if (explicit && fs.existsSync(path.join(explicit, 'summary.json'))) return explicit;
  const caseDir = path.join(root, 'cases', `${safe(row.provider)}__${safe(row.model)}__${safe(row.scenario_id)}__${row.case_id}`);
  const evaluationId = clean(asObject(row.summary).evaluation_id);
  if (evaluationId && fs.existsSync(path.join(caseDir, evaluationId, 'summary.json'))) return path.join(caseDir, evaluationId);
  if (!fs.existsSync(caseDir)) return '';
  const candidates = fs.readdirSync(caseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('eval_') && fs.existsSync(path.join(caseDir, entry.name, 'summary.json')))
    .map((entry) => path.join(caseDir, entry.name))
    .sort();
  return candidates.at(-1) || '';
}

function compactEvaluationSummary(result = {}, gocSync = null) {
  return {
    evaluation_id: result.evaluation_id,
    status: result.status,
    total_run_count: result.total_run_count,
    passed_run_count: result.passed_run_count,
    failed_run_count: result.failed_run_count,
    execution_error_run_count: Number(result.execution_error_run_count || 0),
    quality_run_count: Number(result.quality_run_count ?? (Number(result.passed_run_count || 0) + Number(result.failed_run_count || 0))),
    variant_results: result.variant_results,
    goc_sync: gocSync || result.goc_sync || null,
  };
}


function evaluationCaseDisposition(result = {}) {
  const executionErrors = asArray(result.runs)
    .map((run) => asObject(run.execution_error || run.provider_result?.execution_error))
    .filter((entry) => entry.kind === 'execution_error');
  const qualityRunCount = Number(result.quality_run_count ?? (Number(result.passed_run_count || 0) + Number(result.failed_run_count || 0)));
  const qualityFailureCount = Number(result.failed_run_count || 0);
  const executionErrorCount = Number(result.execution_error_run_count || 0);
  const modelIneligibility = qualityRunCount === 0
    ? executionErrors.find((entry) => shouldMarkModelExecutionIneligible(entry)) || null
    : null;
  if (qualityFailureCount > 0) {
    return {
      status: 'failed',
      executionErrors,
      modelIneligibility,
      executionErrorCategory: clean(executionErrors[0]?.category) || null,
      error: `live scenario completed with ${qualityFailureCount} failed quality run(s)`,
    };
  }
  if (executionErrorCount > 0) {
    const category = clean(executionErrors[0]?.category) || 'unknown';
    if (modelIneligibility) {
      return {
        status: 'skipped',
        executionErrors,
        modelIneligibility,
        executionErrorCategory: clean(modelIneligibility.category) || category,
        error: `execution ineligible: ${clean(modelIneligibility.category) || category}`,
      };
    }
    return {
      status: 'execution_error',
      executionErrors,
      modelIneligibility: null,
      executionErrorCategory: category,
      error: `provider execution error: ${category}`,
    };
  }
  return { status: 'passed', executionErrors, modelIneligibility: null, executionErrorCategory: null, error: null };
}

async function reconcileStoredMatrixEvaluations({ root, state, syncToGoc = false, lifecycleRegistryPath = '', evaluationSync = syncHarnessEvaluationToGoc } = {}) {
  const rows = Object.values(asObject(state.cases));
  const registryPath = clean(lifecycleRegistryPath) || clean(asObject(state.options).lifecycleRegistryPath) || modelDiscoveryRegistryPath();
  const reconciled = [];
  for (const row of rows) {
    const evaluationDir = resolveStoredEvaluationDir(root, row);
    if (!evaluationDir) continue;
    const summaryFile = path.join(evaluationDir, 'summary.json');
    const stored = readJson(summaryFile);
    if (!stored || !asArray(stored.runs).length) continue;
    const corrected = reconcileStoredLiveScenarioSummary(stored);
    const newlyClassified = Number(asObject(corrected.reconciliation).newly_classified_execution_error_run_count || 0);
    const countChanged = Number(stored.execution_error_run_count || 0) !== Number(corrected.execution_error_run_count || 0)
      || Number(stored.quality_run_count ?? stored.total_run_count ?? 0) !== Number(corrected.quality_run_count || 0);
    const summaryChanged = newlyClassified > 0 || countChanged || clean(stored.status) !== clean(corrected.status);

    if (summaryChanged) {
      writeJson(summaryFile, corrected);
      for (const run of asArray(corrected.runs)) {
        const resultFile = path.join(evaluationDir, 'runs', clean(run.run_id), 'result.json');
        if (clean(run.run_id) && fs.existsSync(resultFile)) writeJson(resultFile, run);
      }
      writeJson(path.join(evaluationDir, 'reconciliation.json'), corrected.reconciliation);
    }

    let gocSync = null;
    if (syncToGoc) {
      gocSync = await evaluationSync(corrected, { optional: true });
      writeJson(path.join(evaluationDir, 'goc_sync.json'), gocSync);
    }

    const disposition = evaluationCaseDisposition(corrected);
    const previousStatus = clean(row.status);
    const previousCategory = clean(row.execution_error_category);
    const previousCliVersion = sanitizeProviderCliVersion(row.cli_version) || null;
    row.evaluation_dir = evaluationDir;
    const observedCliVersion = sanitizeProviderCliVersion(corrected.runs?.[0]?.cli_version);
    if (observedCliVersion) row.cli_version = observedCliVersion;
    else row.cli_version = previousCliVersion;
    const cliVersionChanged = previousCliVersion !== row.cli_version;
    const stateChanged = previousStatus !== disposition.status
      || previousCategory !== clean(disposition.executionErrorCategory)
      || cliVersionChanged;
    row.summary = compactEvaluationSummary(corrected, gocSync || asObject(row.summary).goc_sync || null);
    row.status = disposition.status;
    row.execution_error_category = disposition.executionErrorCategory;
    row.error = disposition.error;

    if (disposition.modelIneligibility) {
      recordModelExecutionIneligibility({
        provider: row.provider,
        model: row.model,
        category: disposition.modelIneligibility.category,
        reason: disposition.modelIneligibility.message,
        retryable: false,
        errorScope: disposition.modelIneligibility.scope || 'model',
        evaluationId: corrected.evaluation_id,
        runId: corrected.runs?.[0]?.run_id || '',
        cliVersion: corrected.runs?.[0]?.cli_version || row.cli_version || '',
        registryPath,
      });
    }

    if (summaryChanged || stateChanged || syncToGoc) {
      row.reconciled_at = nowIso();
      reconciled.push({
        case_id: row.case_id,
        evaluation_id: corrected.evaluation_id,
        status: row.status,
        summary_changed: summaryChanged,
        state_changed: stateChanged,
        cli_version_changed: cliVersionChanged,
        execution_error_run_count: corrected.execution_error_run_count,
        goc_sync: gocSync,
      });
    }
  }
  if (reconciled.length) {
    state.reconciliation_history = [
      ...asArray(state.reconciliation_history),
      { reconciled_at: nowIso(), sync_to_goc: syncToGoc === true, cases: reconciled },
    ].slice(-50);
  }
  return reconciled;
}


function reconcileStoredMatrixMetadata(root, state) {
  const cases = Object.values(asObject(state.cases));
  const versionByModel = new Map();
  let caseVersionChanges = 0;
  for (const row of cases) {
    const before = clean(row.cli_version);
    const sanitized = sanitizeProviderCliVersion(before) || null;
    if ((before || null) !== sanitized) caseVersionChanges += 1;
    row.cli_version = sanitized;
    if (sanitized) versionByModel.set(modelKey(row.provider, row.model), sanitized);
  }

  const files = [];
  const modelsFile = path.join(root, 'models.json');
  const models = readJson(modelsFile);
  if (Array.isArray(models)) {
    let changed = false;
    const corrected = models.map((row) => {
      const key = modelKey(row?.provider, row?.model);
      const nextVersion = versionByModel.get(key) || sanitizeProviderCliVersion(row?.cli_version) || null;
      if ((clean(row?.cli_version) || null) !== nextVersion) changed = true;
      return { ...row, cli_version: nextVersion };
    });
    if (changed) {
      writeJson(modelsFile, corrected);
      files.push('models.json');
    }
  }

  const planFile = path.join(root, 'plan.json');
  const plan = readJson(planFile);
  if (plan && Array.isArray(plan.cases)) {
    const byCase = new Map(cases.map((row) => [clean(row.case_id), row]));
    let changed = false;
    const correctedCases = plan.cases.map((row) => {
      const stateRow = byCase.get(clean(row?.case_id));
      const nextVersion = sanitizeProviderCliVersion(stateRow?.cli_version || row?.cli_version) || null;
      if ((clean(row?.cli_version) || null) !== nextVersion) changed = true;
      return { ...row, cli_version: nextVersion };
    });
    if (changed) {
      writeJson(planFile, { ...plan, cases: correctedCases });
      files.push('plan.json');
    }
  }

  if (caseVersionChanges || files.length) {
    const entry = {
      reconciled_at: nowIso(),
      kind: 'cli_version_metadata',
      case_version_changes: caseVersionChanges,
      files,
    };
    state.metadata_reconciliation_history = [...asArray(state.metadata_reconciliation_history), entry].slice(-50);
    return entry;
  }
  return null;
}

function writeMatrixArtifacts(root, state) {
  const rows = Object.values(asObject(state.cases)).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.scenario_id.localeCompare(b.scenario_id));
  const headers = ['case_id','provider','model','scenario_id','matrix_index','role','harness_variant_id','reasoning_effort','repeat','status','attempts','passed_runs','failed_runs','execution_error_runs','average_score','average_duration_ms','evaluation_dir','execution_error_category','error'];
  const lines = [headers.join('\t')];
  const failures = [];
  const executionErrors = [];
  const evalDirs = [];
  for (const row of rows) {
    const summary = asObject(row.summary);
    const variants = asArray(summary.variant_results);
    const scoredVariants = variants.filter((item) => item.average_score !== null && item.average_score !== undefined && item.average_score !== '');
    const avgScore = scoredVariants.length ? scoredVariants.reduce((sum, item) => sum + Number(item.average_score || 0), 0) / scoredVariants.length : '';
    const avgDuration = variants.length ? variants.reduce((sum, item) => sum + Number(item.average_duration_ms || 0), 0) / variants.length : '';
    const values = [row.case_id,row.provider,row.model,row.scenario_id,row.matrix_index,row.role,row.harness_variant_id,row.reasoning_effort,row.repeat,row.status,row.attempts,summary.passed_run_count ?? '',summary.failed_run_count ?? '',summary.execution_error_run_count ?? '',avgScore,avgDuration,row.evaluation_dir || '',row.execution_error_category || '',row.error || ''];
    lines.push(values.map(tsvCell).join('\t'));
    if (row.status === 'failed') failures.push(values.map(tsvCell).join('\t'));
    if (row.status === 'execution_error') executionErrors.push(values.map(tsvCell).join('\t'));
    if (row.evaluation_dir) evalDirs.push(row.evaluation_dir);
  }
  writeText(path.join(root, 'results.tsv'), `${lines.join('\n')}\n`);
  writeText(path.join(root, 'failures.tsv'), failures.length ? `${headers.join('\t')}\n${failures.join('\n')}\n` : '');
  writeText(path.join(root, 'execution_errors.tsv'), executionErrors.length ? `${headers.join('\t')}\n${executionErrors.join('\n')}\n` : '');
  writeText(path.join(root, 'evaluation_dirs.txt'), evalDirs.length ? `${evalDirs.join('\n')}\n` : '');
  const counts = summarizeState(state);
  const providerCounts = {};
  for (const row of rows) providerCounts[row.provider] = (providerCounts[row.provider] || 0) + 1;
  const summary = {
    schema_version: 'ddalggak.all_model_benchmark_summary/v1',
    matrix_id: state.matrix_id,
    status: matrixStatus(counts, state.status),
    created_at: state.created_at,
    updated_at: state.updated_at,
    counts,
    provider_case_counts: providerCounts,
    quality_case_count: counts.passed + counts.failed,
    execution_error_case_count: counts.execution_error,
    execution_ineligible_case_count: counts.skipped,
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
    `- Failed quality cases: ${counts.failed}`,
    `- Retryable execution-error cases: ${counts.execution_error}`,
    `- Execution-ineligible cases: ${counts.skipped}`,
    `- Pending cases: ${counts.pending}`,
    '',
    'Review `results.tsv`, `failures.tsv`, `execution_errors.tsv`, `state.json`, and each case evaluation directory.',
    '',
  ].join('\n'));
  return summary;
}

export async function runAllModelBenchmark({
  outputDir = '', resumeDir = '', scenarioFiles = [], scenarioDir = 'scenarios/live', providers = [], models = [], repeat = 1,
  pendingOnly = false, includeUnavailable = false, maxModels = 0, execute = false, refresh = false, retryFailed = false,
  failFast = false, syncToGoc = false, keepWorkspaces = true, registryPath = '', catalogPath = '', lifecycleRegistryPath = '',
  liveScenarioRunner = runLiveScenarioSuite, refreshCatalog = refreshModelCatalog, evaluationSync = syncHarnessEvaluationToGoc,
} = {}) {
  if (refresh) await refreshCatalog({ force: true, reason: 'models_bench_all_manual_refresh' });

  let root;
  let state;
  if (clean(resumeDir)) {
    root = path.resolve(resumeDir);
    state = readJson(path.join(root, 'state.json'));
    if (!state) throw new Error(`Benchmark state not found: ${path.join(root, 'state.json')}`);
    state.options = {
      ...asObject(state.options),
      ...(syncToGoc === true ? { syncToGoc: true } : {}),
      ...(keepWorkspaces === false ? { keepWorkspaces: false } : {}),
    };
    state.resume_history = [
      ...asArray(state.resume_history),
      { resumed_at: nowIso(), execute: execute === true, retry_failed: retryFailed === true, sync_to_goc: syncToGoc === true, keep_workspaces: keepWorkspaces !== false },
    ].slice(-50);
    if (retryFailed) {
      for (const row of Object.values(asObject(state.cases))) {
        if (row.status === 'failed' || row.status === 'execution_error') Object.assign(row, { status: 'pending', error: null, execution_error_category: null });
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
    state = initialState({ matrixId, root, cases, options: {
      providers, models, repeat, pendingOnly, scenarioFiles: scenarios, scenarioDir, syncToGoc, keepWorkspaces,
      catalogPath: clean(catalogPath) || modelNodesDiscoveredConfigPath(),
      lifecycleRegistryPath: clean(lifecycleRegistryPath) || modelDiscoveryRegistryPath(),
    } });
    writeJson(path.join(root, 'models.json'), discovered);
    writeJson(path.join(root, 'plan.json'), { schema_version: 'ddalggak.all_model_benchmark_plan/v1', matrix_id: matrixId, options: state.options, cases });
  }

  if (clean(resumeDir)) {
    await reconcileStoredMatrixEvaluations({
      root,
      state,
      syncToGoc,
      lifecycleRegistryPath: clean(lifecycleRegistryPath) || clean(asObject(state.options).lifecycleRegistryPath),
      evaluationSync,
    });
    reconcileStoredMatrixMetadata(root, state);
  }

  const preRunCounts = summarizeState(state);
  state.status = execute
    ? 'running'
    : (clean(resumeDir) && !preRunCounts.pending && !preRunCounts.running
      ? matrixStatus(preRunCounts, 'planned')
      : 'planned');
  state.updated_at = nowIso();
  writeJson(path.join(root, 'state.json'), state);
  let summary = writeMatrixArtifacts(root, state);
  if (!execute) return { ...summary, state, output_dir: root, plan_only: true };

  for (const row of Object.values(asObject(state.cases))) {
    if (row.status === 'passed' || (row.status === 'skipped' && !retryFailed)) continue;
    if ((row.status === 'failed' || row.status === 'execution_error') && !retryFailed) continue;
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
        model: row.execution_model ?? executionModel(row.model),
        reasoningEffort: row.reasoning_effort,
        variantId: row.harness_variant_id,
        repeat: row.repeat,
        matrixIndex: row.matrix_index,
        syncToGoc,
        keepWorkspaces,
      });
      row.summary = compactEvaluationSummary(result, result.goc_sync || null);
      row.evaluation_dir = result.output_dir || caseDir;
      const disposition = evaluationCaseDisposition(result);
      row.status = disposition.status;
      row.execution_error_category = disposition.executionErrorCategory;
      row.error = disposition.error;
      if (disposition.modelIneligibility) {
        recordModelExecutionIneligibility({
          provider: row.provider,
          model: row.model,
          category: disposition.modelIneligibility.category,
          reason: disposition.modelIneligibility.message,
          retryable: false,
          errorScope: disposition.modelIneligibility.scope || 'model',
          evaluationId: result.evaluation_id,
          runId: result.runs?.[0]?.run_id || '',
          cliVersion: result.runs?.[0]?.cli_version || row.cli_version || '',
          registryPath: clean(lifecycleRegistryPath) || clean(asObject(state.options).lifecycleRegistryPath) || modelDiscoveryRegistryPath(),
        });
      }
      appendJsonl(path.join(root, 'results.jsonl'), { case_id: row.case_id, ...row.summary, evaluation_dir: row.evaluation_dir });
    } catch (error) {
      row.status = 'execution_error';
      row.execution_error_category = 'runner_error';
      row.error = clean(error?.stack || error?.message || error);
      writeText(path.join(caseDir, 'runner_error.txt'), `${row.error}\n`);
      appendJsonl(path.join(root, 'results.jsonl'), { case_id: row.case_id, status: 'runner_failed', error: row.error });
    }
    row.completed_at = nowIso();
    state.updated_at = nowIso();
    writeJson(path.join(root, 'state.json'), state);
    summary = writeMatrixArtifacts(root, state);
    if (failFast && (row.status === 'failed' || row.status === 'execution_error')) break;
  }

  const counts = summarizeState(state);
  state.status = matrixStatus(counts, 'interrupted');
  state.updated_at = nowIso();
  writeJson(path.join(root, 'state.json'), state);
  summary = writeMatrixArtifacts(root, state);
  return { ...summary, state, output_dir: root, plan_only: false };
}
