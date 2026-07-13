import fs from 'node:fs';
import path from 'node:path';

import {
  discoverAntigravityCliModelNodes,
  discoverClaudeCliModelNodes,
  discoverCodexCliModelNodes,
  discoverGeminiCliModelNodes,
  discoverOllamaModelNodes,
  discoverOpenAICompatibleModelNodes,
} from './model_node_discovery.js';
import { geminiCliDisabledByDefault } from '../provider_migration.js';
import { probeProviderCapabilities, sanitizeProviderCliVersion } from '../evaluation/provider_capability_registry.js';

function clean(value = '') {
  return String(value || '').trim();
}

function truthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function envFlag(name, fallback = false) {
  if (process.env[name] === undefined) return fallback;
  return truthy(process.env[name]);
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueNodes(nodes = []) {
  const byId = new Map();
  for (const node of asArray(nodes)) {
    if (!node?.id || !node?.model) continue;
    byId.set(String(node.id), node);
  }
  return [...byId.values()];
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function modelKey(provider = '', model = '') {
  return `${clean(provider).toLowerCase()}:${clean(model).toLowerCase()}`;
}

function capabilityMap(registry = {}) {
  const out = new Map();
  for (const row of asArray(registry?.items)) {
    const provider = clean(row?.provider).toLowerCase();
    if (provider) out.set(provider, row);
  }
  return out;
}

function capabilityVersionFingerprint(registry = {}) {
  return asArray(registry?.items)
    .map((row) => `${clean(row?.provider).toLowerCase()}=${sanitizeProviderCliVersion(row?.cli_version) || 'unavailable'}`)
    .filter(Boolean)
    .sort()
    .join('|');
}

function discoveryScopeMatchesNode(label = '', node = {}) {
  const runtime = clean(node?.runtime).toLowerCase();
  const provider = clean(node?.provider).toLowerCase();
  const source = clean(node?.model_catalog?.discovered_from).toLowerCase();
  if (label === 'codex_cli') return provider === 'codex' || runtime === 'codex_cli' || source.startsWith('codex_cli_');
  if (label === 'claude_cli') return provider === 'claude' || runtime === 'claude_cli' || source.startsWith('claude_cli_');
  if (label === 'antigravity_cli') return provider === 'antigravity' || runtime === 'antigravity_cli' || source.startsWith('antigravity_cli_');
  if (label === 'gemini_cli') return provider === 'gemini' || runtime === 'gemini_cli' || source.startsWith('gemini_cli_');
  if (label === 'ollama') return runtime === 'ollama' || source === 'ollama_api';
  if (label === 'openai_compatible') return runtime === 'openai_compatible' || source.includes('models_api');
  return false;
}

function mergeDiscoveryWithPrevious({ previousNodes = [], discoveries = [] } = {}) {
  let merged = uniqueNodes(previousNodes);
  for (const entry of asArray(discoveries)) {
    if (!entry?.label || entry?.ok !== true) continue;
    merged = merged.filter((node) => !discoveryScopeMatchesNode(entry.label, node));
    merged.push(...asArray(entry.result?.nodes));
  }
  return uniqueNodes(merged);
}

export function modelNodesDiscoveredConfigPath() {
  const explicit = clean(process.env.MODEL_NODES_DISCOVERED_CONFIG || process.env.MODEL_NODES_DISCOVERED_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_nodes.discovered.json');
}

export function modelCatalogRefreshStatePath() {
  const explicit = clean(process.env.MODEL_CATALOG_REFRESH_STATE_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_catalog_refresh_state.json');
}

export function modelDiscoveryRegistryPath() {
  const explicit = clean(process.env.MODEL_DISCOVERY_REGISTRY_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_discovery_registry.json');
}

export function modelCapabilitySnapshotPath() {
  const explicit = clean(process.env.MODEL_CAPABILITY_SNAPSHOT_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'provider_capabilities.discovered.json');
}

export function readJson(file = '') {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file = '', value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function shouldRefreshNow({ force = false, statePath = modelCatalogRefreshStatePath(), intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000), nowMs = Date.now() } = {}) {
  if (force) return true;
  const state = readJson(statePath);
  const last = Date.parse(state?.last_completed_at || state?.last_started_at || '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= Math.max(60_000, Number(intervalMs || 0));
}

async function safeDiscover(label, fn) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    return {
      label,
      ok: result?.ok === true,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      count: Array.isArray(result?.nodes) ? result.nodes.length : 0,
      error: result?.ok === true ? '' : clean(result?.error || result?.status || 'discovery_failed'),
      result,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      count: 0,
      error: clean(error?.message || error).slice(0, 600),
      result: { ok: false, nodes: [] },
    };
  }
}

export async function probeConfiguredProviderCapabilities({ runner, timeoutMs = numberEnv('MODEL_CATALOG_VERSION_PROBE_TIMEOUT_MS', 10000) } = {}) {
  const providers = [];
  if (envFlag('CODEX_CLI_MODEL_DISCOVERY_ENABLED', true)) providers.push('codex');
  if (envFlag('CLAUDE_CLI_MODEL_DISCOVERY_ENABLED', true)) providers.push('claude');
  if (envFlag('ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED', true)) providers.push('antigravity');
  return await probeProviderCapabilities({ providers, timeoutMs, runner });
}

export async function discoverConfiguredModelCatalog({
  includeOllama = envFlag('OLLAMA_DISCOVERY_ENABLED', !!clean(process.env.OLLAMA_BASE_URL)),
  includeOpenAICompatible = envFlag('OPENAI_COMPATIBLE_DISCOVERY_ENABLED', !!clean(process.env.OPENAI_COMPATIBLE_BASE_URL)),
  includeCodex = envFlag('CODEX_CLI_MODEL_DISCOVERY_ENABLED', true),
  includeClaude = envFlag('CLAUDE_CLI_MODEL_DISCOVERY_ENABLED', true),
  includeAntigravity = envFlag('ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED', true),
  includeGemini = envFlag('GEMINI_CLI_MODEL_DISCOVERY_ENABLED', false) && !geminiCliDisabledByDefault(),
  timeoutMs = numberEnv('CLI_MODEL_DISCOVERY_TIMEOUT_MS', 12000),
  maxModels = numberEnv('MODEL_NODE_DISCOVERY_MAX_MODELS', 80),
  runner,
  previousPayload = null,
  capabilityRegistry = null,
} = {}) {
  const discoveries = [];
  if (includeOllama) {
    discoveries.push(await safeDiscover('ollama', () => discoverOllamaModelNodes({
      baseUrl: process.env.OLLAMA_BASE_URL || process.env.REMOTE_OLLAMA_BASE_URL || 'http://localhost:11434',
      trustedContext: process.env.OLLAMA_TRUSTED_CONTEXT === undefined ? true : truthy(process.env.OLLAMA_TRUSTED_CONTEXT),
      timeoutMs: numberEnv('MODEL_NODE_DISCOVERY_TIMEOUT_MS', 5000),
      maxModels,
      apiKey: process.env.OLLAMA_API_KEY || '',
    })));
  }
  if (includeOpenAICompatible) {
    discoveries.push(await safeDiscover('openai_compatible', () => discoverOpenAICompatibleModelNodes({
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || '',
      runtime: process.env.OPENAI_COMPATIBLE_RUNTIME || 'openai_compatible',
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || '',
      trustedContext: envFlag('OPENAI_COMPATIBLE_TRUSTED_CONTEXT', false),
      timeoutMs: numberEnv('MODEL_NODE_DISCOVERY_TIMEOUT_MS', 5000),
      maxModels,
    })));
  }
  if (includeCodex) discoveries.push(await safeDiscover('codex_cli', () => discoverCodexCliModelNodes({ timeoutMs, maxModels, runner })));
  if (includeClaude) discoveries.push(await safeDiscover('claude_cli', () => discoverClaudeCliModelNodes({ timeoutMs, maxModels, runner })));
  if (includeAntigravity) discoveries.push(await safeDiscover('antigravity_cli', () => discoverAntigravityCliModelNodes({ timeoutMs, maxModels, runner })));
  if (includeGemini) discoveries.push(await safeDiscover('gemini_cli', () => discoverGeminiCliModelNodes({ timeoutMs, maxModels, runner })));

  const previousNodes = asArray(previousPayload?.nodes);
  const nodes = mergeDiscoveryWithPrevious({ previousNodes, discoveries });
  const capabilities = capabilityRegistry || await probeConfiguredProviderCapabilities({ runner });
  const capabilitiesByProvider = capabilityMap(capabilities);
  const decoratedNodes = nodes.map((node) => {
    const capability = capabilitiesByProvider.get(clean(node?.provider).toLowerCase());
    if (!capability) return node;
    return {
      ...node,
      discovery_runtime: {
        cli_version: sanitizeProviderCliVersion(capability.cli_version) || null,
        cli_available: capability.cli_available === true,
        probed_at: capability.probed_at || null,
      },
    };
  });

  return {
    version: 2,
    generated_at: new Date().toISOString(),
    source: {
      kind: 'configured_model_catalog_refresh',
      interval_ms: numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000),
      request_path_discovery: false,
      refresh_policy: 'background_idle_cached',
    },
    provider_capabilities: capabilities,
    discovery_results: discoveries.map((entry) => ({
      label: entry.label,
      ok: entry.ok,
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      count: entry.count,
      error: entry.error,
      warning: clean(entry.result?.warning || ''),
      discovery_source: entry.result?.discovery_source || entry.result?.runtime || entry.label,
    })),
    nodes: decoratedNodes,
  };
}

function buildDiscoveryRegistry({ previousRegistry = {}, previousPayload = {}, payload = {}, reason = '', cliVersionsChanged = [] } = {}) {
  const now = payload.generated_at || new Date().toISOString();
  const previousEntries = asObject(previousRegistry?.entries);
  const currentKeys = new Set();
  const entries = { ...previousEntries };
  const newModels = [];
  const revalidationProviders = new Set(asArray(cliVersionsChanged).map((x) => clean(x).toLowerCase()).filter(Boolean));
  const currentDiscoveryOk = new Set(
    asArray(payload.discovery_results)
      .filter((row) => row?.ok === true)
      .map((row) => clean(row.label).toLowerCase()),
  );

  const providerLabel = {
    codex: 'codex_cli',
    claude: 'claude_cli',
    antigravity: 'antigravity_cli',
    gemini: 'gemini_cli',
  };

  for (const node of asArray(payload.nodes)) {
    const provider = clean(node?.provider).toLowerCase();
    const model = clean(node?.model);
    if (!provider || !model) continue;
    const key = modelKey(provider, model);
    currentKeys.add(key);
    const previous = asObject(previousEntries[key]);
    const isNew = !previous.model;
    const cliVersion = sanitizeProviderCliVersion(node?.discovery_runtime?.cli_version) || null;
    const benchmarkEligible = ['codex', 'claude', 'antigravity'].includes(provider);
    const revalidationRequired = benchmarkEligible && revalidationProviders.has(provider);
    const benchmarkStatus = isNew && benchmarkEligible
      ? 'benchmark_pending'
      : (revalidationRequired ? 'revalidation_pending' : clean(previous.benchmark_status) || (benchmarkEligible ? 'unbenchmarked' : 'not_required'));
    entries[key] = {
      ...previous,
      provider,
      model,
      node_id: clean(node?.id) || previous.node_id || null,
      first_seen_at: previous.first_seen_at || now,
      last_seen_at: now,
      last_discovery_at: now,
      availability: 'available',
      benchmark_status: benchmarkStatus,
      revalidation_required: revalidationRequired || previous.revalidation_required === true && benchmarkStatus !== 'evaluated',
      execution_eligibility: revalidationRequired ? 'unknown' : (clean(previous.execution_eligibility) || 'unknown'),
      execution_ineligibility: revalidationRequired ? null : (previous.execution_ineligibility || null),
      discovered_cli_version: cliVersion,
      discovery_source: clean(node?.model_catalog?.discovered_from) || previous.discovery_source || null,
      last_refresh_reason: reason || null,
    };
    if (isNew) newModels.push(entries[key]);
  }

  // Only mark a model unavailable when its provider discovery succeeded and the model disappeared.
  for (const [key, previous] of Object.entries(previousEntries)) {
    if (currentKeys.has(key)) continue;
    const provider = clean(previous?.provider).toLowerCase();
    const scope = providerLabel[provider];
    if (scope && currentDiscoveryOk.has(scope)) {
      entries[key] = {
        ...previous,
        availability: 'unavailable',
        last_missing_at: now,
        last_refresh_reason: reason || null,
      };
    }
  }

  const benchmarkCandidates = Object.values(entries)
    .filter((row) => row?.availability === 'available' && clean(row?.execution_eligibility) !== 'ineligible' && ['benchmark_pending', 'benchmark_running', 'revalidation_pending'].includes(clean(row?.benchmark_status)))
    .sort((a, b) => String(b.first_seen_at || '').localeCompare(String(a.first_seen_at || '')));

  return {
    version: 1,
    updated_at: now,
    last_refresh_reason: reason || null,
    entries,
    new_models: newModels,
    benchmark_candidates: benchmarkCandidates,
  };
}

export function listPendingModelBenchmarks({ registryPath = modelDiscoveryRegistryPath() } = {}) {
  const registry = readJson(registryPath) || {};
  return asArray(registry.benchmark_candidates).filter((row) => row?.availability === 'available' && clean(row?.execution_eligibility) !== 'ineligible');
}

export function markModelBenchmarkStatus({ provider = '', model = '', status = 'evaluated', metadata = {}, registryPath = modelDiscoveryRegistryPath() } = {}) {
  const registry = readJson(registryPath) || { version: 1, entries: {} };
  const entries = { ...asObject(registry.entries) };
  const key = modelKey(provider, model);
  if (!entries[key]) return { ok: false, reason: 'model_not_found', key };
  const now = new Date().toISOString();
  entries[key] = {
    ...entries[key],
    benchmark_status: clean(status) || 'evaluated',
    revalidation_required: false,
    benchmark_updated_at: now,
    benchmark_metadata: { ...asObject(entries[key].benchmark_metadata), ...asObject(metadata) },
  };
  const next = {
    ...registry,
    updated_at: now,
    entries,
    benchmark_candidates: Object.values(entries)
      .filter((row) => row?.availability === 'available' && clean(row?.execution_eligibility) !== 'ineligible' && ['benchmark_pending', 'benchmark_running', 'revalidation_pending'].includes(clean(row?.benchmark_status))),
  };
  writeJson(registryPath, next);
  return { ok: true, key, entry: entries[key], registry: next };
}


export function recordModelEvaluationObservation({ provider = '', model = '', passed = false, score = 0, evaluationId = '', runId = '', runtimeSignature = '', registryPath = modelDiscoveryRegistryPath(), minRuns = numberEnv('MODEL_BENCHMARK_MIN_RUNS', 3) } = {}) {
  const registry = readJson(registryPath) || { version: 1, entries: {} };
  const entries = { ...asObject(registry.entries) };
  const key = modelKey(provider, model);
  const current = asObject(entries[key]);
  if (!current.model) return { ok: false, reason: 'model_not_found', key };
  const previous = asObject(current.evaluation_observations);
  const count = Number(previous.count || 0) + 1;
  const passedCount = Number(previous.passed_count || 0) + (passed ? 1 : 0);
  const totalScore = Number(previous.total_score || 0) + Number(score || 0);
  const now = new Date().toISOString();
  const requiredRuns = Math.max(1, Number(minRuns || 3));
  const status = count >= requiredRuns ? 'evaluated' : 'benchmark_running';
  entries[key] = {
    ...current,
    benchmark_status: status,
    execution_eligibility: 'eligible',
    execution_ineligibility: null,
    revalidation_required: status !== 'evaluated' && current.revalidation_required === true,
    benchmark_updated_at: now,
    evaluation_observations: {
      count,
      passed_count: passedCount,
      pass_rate: count ? passedCount / count : 0,
      total_score: totalScore,
      average_score: count ? totalScore / count : 0,
      last_evaluation_at: now,
      last_evaluation_id: clean(evaluationId) || null,
      last_run_id: clean(runId) || null,
      last_runtime_signature: clean(runtimeSignature) || null,
      required_runs: requiredRuns,
    },
  };
  const next = {
    ...registry,
    updated_at: now,
    entries,
    benchmark_candidates: Object.values(entries)
      .filter((row) => row?.availability === 'available' && clean(row?.execution_eligibility) !== 'ineligible' && ['benchmark_pending', 'benchmark_running', 'revalidation_pending'].includes(clean(row?.benchmark_status))),
  };
  writeJson(registryPath, next);
  return { ok: true, key, entry: entries[key], registry: next };
}

export function recordModelExecutionIneligibility({
  provider = '', model = '', category = 'provider_execution_error', reason = '', retryable = false, errorScope = 'model',
  evaluationId = '', runId = '', cliVersion = '', registryPath = modelDiscoveryRegistryPath(),
} = {}) {
  const registry = readJson(registryPath) || { version: 1, entries: {} };
  const entries = { ...asObject(registry.entries) };
  const key = modelKey(provider, model);
  const current = asObject(entries[key]);
  const now = new Date().toISOString();
  const base = current.model ? current : {
    provider: clean(provider).toLowerCase(),
    model: clean(model),
    availability: 'available',
    first_seen_at: now,
    last_seen_at: now,
    discovery_source: 'benchmark_execution_observation',
  };
  if (!base.provider || !base.model) return { ok: false, reason: 'provider_and_model_required', key };
  entries[key] = {
    ...base,
    benchmark_status: retryable ? (clean(current.benchmark_status) || 'benchmark_pending') : 'execution_ineligible',
    execution_eligibility: retryable ? 'unknown' : 'ineligible',
    execution_ineligibility: {
      category: clean(category) || 'provider_execution_error',
      reason: clean(reason).slice(0, 1200) || null,
      retryable: retryable === true,
      scope: 'current_runtime_credentials',
      affected_scope: clean(errorScope) || 'model',
      observed_at: now,
      evaluation_id: clean(evaluationId) || null,
      run_id: clean(runId) || null,
      cli_version: sanitizeProviderCliVersion(cliVersion) || null,
    },
    benchmark_updated_at: now,
    revalidation_required: false,
  };
  const next = {
    ...registry,
    updated_at: now,
    entries,
    benchmark_candidates: Object.values(entries)
      .filter((row) => row?.availability === 'available' && clean(row?.execution_eligibility) !== 'ineligible' && ['benchmark_pending', 'benchmark_running', 'revalidation_pending'].includes(clean(row?.benchmark_status))),
  };
  writeJson(registryPath, next);
  return { ok: true, key, entry: entries[key], registry: next };
}

export async function refreshModelCatalog({
  force = false,
  reason = 'manual',
  outputPath = modelNodesDiscoveredConfigPath(),
  statePath = modelCatalogRefreshStatePath(),
  registryPath = modelDiscoveryRegistryPath(),
  capabilityPath = modelCapabilitySnapshotPath(),
  logger = console,
  runner,
  capabilityRegistry = null,
  cliVersionsChanged = [],
} = {}) {
  const enabled = envFlag('MODEL_CATALOG_REFRESH_ENABLED', true);
  const intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000);
  if (!enabled && !force) return { ok: false, skipped: true, reason: 'disabled' };
  if (!shouldRefreshNow({ force, statePath, intervalMs })) return { ok: true, skipped: true, reason: 'interval_not_elapsed' };

  const startedAt = new Date().toISOString();
  const previousState = readJson(statePath) || {};
  writeJson(statePath, { ...previousState, last_started_at: startedAt, reason, status: 'running' });

  const previousPayload = readJson(outputPath) || {};
  const previousRegistry = readJson(registryPath) || {};
  const capabilities = capabilityRegistry || await probeConfiguredProviderCapabilities({ runner });
  const payload = await discoverConfiguredModelCatalog({ runner, previousPayload, capabilityRegistry: capabilities });
  const registry = buildDiscoveryRegistry({ previousRegistry, previousPayload, payload, reason, cliVersionsChanged });
  payload.model_lifecycle = {
    registry_path: registryPath,
    new_models: registry.new_models,
    benchmark_candidates: registry.benchmark_candidates,
  };

  writeJson(outputPath, payload);
  writeJson(registryPath, registry);
  writeJson(capabilityPath, capabilities);

  const ok = payload.discovery_results.some((entry) => entry.ok);
  const state = {
    ...previousState,
    last_started_at: startedAt,
    last_completed_at: new Date().toISOString(),
    last_capability_probe_at: capabilities.generated_at || new Date().toISOString(),
    cli_version_fingerprint: capabilityVersionFingerprint(capabilities),
    reason,
    status: ok ? 'ok' : 'no_successful_discovery',
    output_path: outputPath,
    registry_path: registryPath,
    capability_path: capabilityPath,
    nodes: payload.nodes.length,
    new_models: registry.new_models.length,
    benchmark_candidates: registry.benchmark_candidates.length,
    cli_versions_changed: asArray(cliVersionsChanged),
    discovery_results: payload.discovery_results,
  };
  writeJson(statePath, state);
  logger?.log?.(`[model-catalog] refreshed ${payload.nodes.length} model node(s), new=${registry.new_models.length}, benchmark_pending=${registry.benchmark_candidates.length} -> ${outputPath}`);
  return { ok, skipped: false, outputPath, statePath, registryPath, capabilityPath, payload, registry, state };
}

function activityIsIdle(activity = {}, minIdleMs = 0) {
  const row = asObject(activity);
  if (row.busy === true) return false;
  if (Number(row.active_runs || 0) > 0) return false;
  if (Number(row.pending_messages || 0) > 0) return false;
  const idleForMs = Number(row.idle_for_ms);
  if (Number.isFinite(idleForMs) && idleForMs < minIdleMs) return false;
  return true;
}

function providersWithVersionChanges(previousRegistry = {}, nextRegistry = {}) {
  const before = capabilityMap(previousRegistry);
  const after = capabilityMap(nextRegistry);
  const changed = [];
  for (const [provider, next] of after.entries()) {
    const prev = before.get(provider);
    const prevVersion = clean(prev?.cli_version);
    const nextVersion = clean(next?.cli_version);
    if (prevVersion && nextVersion && prevVersion !== nextVersion) changed.push(provider);
  }
  return changed;
}

export function startModelCatalogRefreshScheduler({ logger = console, getActivityState = null, runner } = {}) {
  if (!envFlag('MODEL_CATALOG_REFRESH_ENABLED', true)) {
    logger?.log?.('[model-catalog] refresh disabled');
    return { stop() {}, trigger() {} };
  }

  const intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000);
  const checkIntervalMs = numberEnv('MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS', 5 * 60 * 1000);
  const initialDelayMs = numberEnv('MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS', 30_000);
  const idleMinMs = numberEnv('MODEL_CATALOG_REFRESH_IDLE_MIN_MS', 60_000);
  const versionProbeIntervalMs = numberEnv('MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS', 60 * 60 * 1000);
  const refreshOnVersionChange = envFlag('MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE', true);
  let stopped = false;
  let running = false;

  const activity = () => {
    try {
      if (typeof getActivityState === 'function') return asObject(getActivityState());
    } catch {}
    return { busy: false, active_runs: 0, pending_messages: 0, idle_for_ms: Number.POSITIVE_INFINITY };
  };

  const tick = async (reason = 'scheduled_idle_check', { force = false } = {}) => {
    if (stopped || running) return { ok: false, skipped: true, reason: stopped ? 'stopped' : 'already_running' };
    const currentActivity = activity();
    if (!force && !activityIsIdle(currentActivity, idleMinMs)) {
      return { ok: true, skipped: true, reason: 'runtime_busy', activity: currentActivity };
    }

    const statePath = modelCatalogRefreshStatePath();
    const state = readJson(statePath) || {};
    const dueByInterval = shouldRefreshNow({ force, statePath, intervalMs });
    let capabilities = null;
    let cliVersionsChanged = [];
    let dueByVersionChange = false;

    const lastProbe = Date.parse(state.last_capability_probe_at || '');
    const versionProbeDue = force || !Number.isFinite(lastProbe) || Date.now() - lastProbe >= versionProbeIntervalMs;
    if (refreshOnVersionChange && versionProbeDue) {
      capabilities = await probeConfiguredProviderCapabilities({ runner });
      const previousCapabilities = readJson(modelCapabilitySnapshotPath()) || {};
      cliVersionsChanged = providersWithVersionChanges(previousCapabilities, capabilities);
      dueByVersionChange = cliVersionsChanged.length > 0;
      if (!dueByInterval && !dueByVersionChange) {
        writeJson(modelCapabilitySnapshotPath(), capabilities);
        writeJson(statePath, {
          ...state,
          last_capability_probe_at: capabilities.generated_at || new Date().toISOString(),
          cli_version_fingerprint: capabilityVersionFingerprint(capabilities),
          last_scheduler_check_at: new Date().toISOString(),
          last_scheduler_check_reason: reason,
          last_scheduler_skip_reason: 'interval_not_elapsed_and_cli_unchanged',
        });
      }
    }

    if (!dueByInterval && !dueByVersionChange && !force) {
      return { ok: true, skipped: true, reason: 'interval_not_elapsed_and_cli_unchanged' };
    }

    running = true;
    try {
      return await refreshModelCatalog({
        force: true,
        reason: dueByVersionChange ? `${reason}:cli_version_changed` : reason,
        logger,
        runner,
        capabilityRegistry: capabilities,
        cliVersionsChanged,
      });
    } catch (error) {
      logger?.error?.(`[model-catalog] refresh failed: ${String(error?.message || error)}`);
      return { ok: false, skipped: false, reason: 'refresh_failed', error: String(error?.message || error) };
    } finally {
      running = false;
    }
  };

  const startupTimer = setTimeout(() => { void tick('startup_idle_check'); }, initialDelayMs);
  startupTimer.unref?.();
  const interval = setInterval(() => { void tick('scheduled_idle_check'); }, Math.max(60_000, checkIntervalMs));
  interval.unref?.();

  logger?.log?.(`[model-catalog] idle scheduler enabled · refresh=${intervalMs}ms check=${checkIntervalMs}ms idle_min=${idleMinMs}ms version_probe=${versionProbeIntervalMs}ms`);

  return {
    stop() {
      stopped = true;
      clearTimeout(startupTimer);
      clearInterval(interval);
    },
    trigger(options = {}) {
      return tick(options.reason || 'manual_scheduler_trigger', { force: options.force === true });
    },
  };
}
