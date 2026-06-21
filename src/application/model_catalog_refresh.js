import fs from 'node:fs';
import path from 'node:path';

import {
  discoverCodexCliModelNodes,
  discoverGeminiCliModelNodes,
  discoverOllamaModelNodes,
  discoverOpenAICompatibleModelNodes,
} from './model_node_discovery.js';
import { geminiCliDisabledByDefault } from '../provider_migration.js';

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

function uniqueNodes(nodes = []) {
  const byId = new Map();
  for (const node of asArray(nodes)) {
    if (!node?.id || !node?.model) continue;
    byId.set(String(node.id), node);
  }
  return [...byId.values()];
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

function readJson(file = '') {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file = '', value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function shouldRefreshNow({ force = false, statePath = modelCatalogRefreshStatePath(), intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000) } = {}) {
  if (force) return true;
  const state = readJson(statePath);
  const last = Date.parse(state?.last_completed_at || state?.last_started_at || '');
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= Math.max(60_000, Number(intervalMs || 0));
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

export async function discoverConfiguredModelCatalog({ includeOllama = envFlag('OLLAMA_DISCOVERY_ENABLED', !!clean(process.env.OLLAMA_BASE_URL)), includeOpenAICompatible = envFlag('OPENAI_COMPATIBLE_DISCOVERY_ENABLED', !!clean(process.env.OPENAI_COMPATIBLE_BASE_URL)), includeCodex = envFlag('CODEX_CLI_MODEL_DISCOVERY_ENABLED', true), includeGemini = envFlag('GEMINI_CLI_MODEL_DISCOVERY_ENABLED', false) && !geminiCliDisabledByDefault(), timeoutMs = numberEnv('CLI_MODEL_DISCOVERY_TIMEOUT_MS', 12000), maxModels = numberEnv('MODEL_NODE_DISCOVERY_MAX_MODELS', 80), runner } = {}) {
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
  if (includeCodex) {
    discoveries.push(await safeDiscover('codex_cli', () => discoverCodexCliModelNodes({ timeoutMs, maxModels, runner })));
  }
  if (includeGemini) {
    discoveries.push(await safeDiscover('gemini_cli', () => discoverGeminiCliModelNodes({ timeoutMs, maxModels, runner })));
  }
  const nodes = uniqueNodes(discoveries.flatMap((entry) => asArray(entry.result?.nodes)));
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source: {
      kind: 'configured_model_catalog_refresh',
      interval_ms: numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000),
    },
    discovery_results: discoveries.map((entry) => ({
      label: entry.label,
      ok: entry.ok,
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      count: entry.count,
      error: entry.error,
      discovery_source: entry.result?.discovery_source || entry.result?.runtime || entry.label,
    })),
    nodes,
  };
}

export async function refreshModelCatalog({ force = false, reason = 'manual', outputPath = modelNodesDiscoveredConfigPath(), statePath = modelCatalogRefreshStatePath(), logger = console, runner } = {}) {
  const enabled = envFlag('MODEL_CATALOG_REFRESH_ENABLED', true);
  const intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000);
  if (!enabled && !force) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  if (!shouldRefreshNow({ force, statePath, intervalMs })) {
    return { ok: true, skipped: true, reason: 'interval_not_elapsed' };
  }
  const startedAt = new Date().toISOString();
  writeJson(statePath, { last_started_at: startedAt, reason, status: 'running' });
  const payload = await discoverConfiguredModelCatalog({ runner });
  writeJson(outputPath, payload);
  const ok = payload.discovery_results.some((entry) => entry.ok);
  const state = {
    last_started_at: startedAt,
    last_completed_at: new Date().toISOString(),
    reason,
    status: ok ? 'ok' : 'no_successful_discovery',
    output_path: outputPath,
    nodes: payload.nodes.length,
    discovery_results: payload.discovery_results,
  };
  writeJson(statePath, state);
  logger?.log?.(`[model-catalog] refreshed ${payload.nodes.length} model node(s) -> ${outputPath}`);
  return { ok, skipped: false, outputPath, statePath, payload, state };
}

export function startModelCatalogRefreshScheduler({ logger = console } = {}) {
  if (!envFlag('MODEL_CATALOG_REFRESH_ENABLED', true)) {
    logger?.log?.('[model-catalog] refresh disabled');
    return { stop() {} };
  }
  const intervalMs = numberEnv('MODEL_CATALOG_REFRESH_INTERVAL_MS', 24 * 60 * 60 * 1000);
  const run = (reason) => {
    refreshModelCatalog({ reason, logger }).catch((error) => {
      logger?.error?.(`[model-catalog] refresh failed: ${String(error?.message || error)}`);
    });
  };
  const initialDelayMs = numberEnv('MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS', 2500);
  const startupTimer = setTimeout(() => run('startup'), initialDelayMs);
  startupTimer.unref?.();
  const interval = setInterval(() => run('scheduled_daily'), Math.max(60_000, intervalMs));
  interval.unref?.();
  return {
    stop() {
      clearTimeout(startupTimer);
      clearInterval(interval);
    },
  };
}
