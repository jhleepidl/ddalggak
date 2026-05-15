import fs from 'node:fs';
import path from 'node:path';

import { applyModelCatalogToNode } from './model_node_catalog.js';
import { modelNodesDiscoveredConfigPath } from './model_catalog_refresh.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

function truthyEnv(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function uniqueStrings(values = [], { max = 24, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = clean(raw);
    if (!text) continue;
    const value = lower ? text.toLowerCase() : text;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Math.floor(Number(max) || 24))) break;
  }
  return out;
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeTier(value = '', fallback = 'standard') {
  const key = clean(value).toLowerCase();
  return key || fallback;
}

function normalizeCostProfile(input = {}, fallback = {}) {
  const row = asObject(input);
  const tier = normalizeTier(row.tier || input || fallback.tier || 'unknown');
  return {
    tier,
    billing: normalizeTier(row.billing || fallback.billing || (tier === 'free' ? 'free' : 'metered')),
    input_per_1m_usd: numberOrUndefined(row.input_per_1m_usd ?? row.inputPer1mUsd ?? fallback.input_per_1m_usd),
    output_per_1m_usd: numberOrUndefined(row.output_per_1m_usd ?? row.outputPer1mUsd ?? fallback.output_per_1m_usd),
    notes: clean(row.notes || fallback.notes || ''),
  };
}

function normalizeLatencyProfile(input = {}, fallback = {}) {
  const row = asObject(input);
  const tier = normalizeTier(row.tier || input || fallback.tier || 'unknown');
  return {
    tier,
    expected: normalizeTier(row.expected || fallback.expected || tier),
    startup: normalizeTier(row.startup || fallback.startup || ''),
    p50_ms: numberOrUndefined(row.p50_ms ?? row.p50Ms ?? fallback.p50_ms),
    p95_ms: numberOrUndefined(row.p95_ms ?? row.p95Ms ?? fallback.p95_ms),
  };
}

function normalizeQualityProfile(input = {}, fallback = {}) {
  const row = asObject(input);
  return {
    tier: normalizeTier(row.tier || input || fallback.tier || 'standard'),
    reasoning: normalizeTier(row.reasoning || fallback.reasoning || ''),
    coding: normalizeTier(row.coding || fallback.coding || ''),
    factuality: normalizeTier(row.factuality || fallback.factuality || ''),
    context: normalizeTier(row.context || fallback.context || ''),
  };
}

function normalizePrivacyProfile(input = {}, fallback = {}) {
  const row = asObject(input);
  const trustedContext = row.trusted_context === true
    || row.trustedContext === true
    || row.allow_private_context === true
    || row.allowPrivateContext === true
    || fallback.trusted_context === true
    || fallback.trustedContext === true
    || fallback.allow_private_context === true
    || fallback.allowPrivateContext === true;
  const dataBoundary = clean(row.data_boundary || row.dataBoundary || fallback.data_boundary || fallback.dataBoundary || (trustedContext ? 'user_controlled_remote' : 'unspecified'));
  const tierFallback = trustedContext ? 'trusted_private' : (dataBoundary === 'local_device' ? 'local_private' : 'standard');
  return {
    tier: normalizeTier(row.tier || fallback.tier || tierFallback),
    data_boundary: dataBoundary,
    retention: clean(row.retention || fallback.retention || ''),
    sends_context_off_device: row.sends_context_off_device ?? row.sendsContextOffDevice ?? fallback.sends_context_off_device ?? fallback.sendsContextOffDevice ?? (dataBoundary !== 'local_device'),
    trusted_context: trustedContext,
    allow_private_context: trustedContext || row.allow_private_context === true || row.allowPrivateContext === true || fallback.allow_private_context === true || fallback.allowPrivateContext === true,
    network_scope: clean(row.network_scope || row.networkScope || fallback.network_scope || fallback.networkScope || ''),
  };
}

function normalizeAccountProfile(input = {}, fallback = {}) {
  const row = asObject(input);
  const mode = clean(row.mode || fallback.mode || process.env.PROVIDER_ACCOUNT_MODE || 'deployment_owner') || 'deployment_owner';
  return {
    mode,
    billing_owner: clean(row.billing_owner || row.billingOwner || fallback.billing_owner || fallback.billingOwner || (mode === 'per_user_isolated' ? 'end_user' : 'deployment_owner')),
    credential_scope: clean(row.credential_scope || row.credentialScope || fallback.credential_scope || fallback.credentialScope || (mode === 'per_user_isolated' ? 'per_user' : 'service')),
    isolation: clean(row.isolation || fallback.isolation || (mode === 'per_user_isolated' ? 'required' : 'service_process')),
  };
}

function parseJsonMaybe(raw = '') {
  try {
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}


function isLoopbackUrl(value = '') {
  const text = clean(value).toLowerCase();
  return text.includes('127.0.0.1') || text.includes('localhost') || text.includes('::1');
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return truthyEnv(raw);
}

function inferConfiguredOllamaTrustedContext(baseUrl = '', runtime = '') {
  const rt = clean(runtime).toLowerCase();
  if (process.env.OLLAMA_TRUSTED_CONTEXT !== undefined) return truthyEnv(process.env.OLLAMA_TRUSTED_CONTEXT);
  if (process.env.LOCAL_MODEL_TRUSTED_CONTEXT !== undefined) return truthyEnv(process.env.LOCAL_MODEL_TRUSTED_CONTEXT);
  if (process.env.MODEL_NODE_TRUSTED_CONTEXT !== undefined) return truthyEnv(process.env.MODEL_NODE_TRUSTED_CONTEXT);
  return rt === 'ollama' || clean(baseUrl).includes('11434');
}

function modelNodesConfigPath() {
  const explicit = clean(process.env.MODEL_NODES_CONFIG || process.env.DDALGGAK_MODEL_NODES_CONFIG);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_nodes.json');
}

function defaultLocalNodeFromEnv() {
  const baseUrl = clean(process.env.LOCAL_MODEL_BASE_URL || process.env.OLLAMA_BASE_URL || process.env.REMOTE_OLLAMA_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL);
  const model = clean(process.env.LOCAL_MODEL || process.env.OLLAMA_MODEL || process.env.REMOTE_OLLAMA_MODEL || process.env.OPENAI_COMPATIBLE_MODEL);
  if (!baseUrl || !model) return null;
  return {
    id: cleanId(process.env.LOCAL_MODEL_NODE_ID || process.env.OLLAMA_NODE_ID || 'local_model'),
    label: clean(process.env.LOCAL_MODEL_LABEL || process.env.OLLAMA_LABEL || model),
    provider: 'openai_compatible',
    runtime: clean(process.env.LOCAL_MODEL_RUNTIME || process.env.OLLAMA_RUNTIME || (baseUrl.includes('11434') ? 'ollama' : 'openai_compatible')),
    base_url: baseUrl,
    model,
    location: clean(process.env.LOCAL_MODEL_LOCATION || 'local'),
    enabled: true,
    capabilities: {
      chat: true,
      structured_json: truthyEnv(process.env.LOCAL_MODEL_STRUCTURED_JSON || 'true'),
      tool_calling: truthyEnv(process.env.LOCAL_MODEL_TOOL_CALLING || ''),
      code: truthyEnv(process.env.LOCAL_MODEL_CODE || 'true'),
      vision: truthyEnv(process.env.LOCAL_MODEL_VISION || ''),
      embedding: truthyEnv(process.env.LOCAL_MODEL_EMBEDDING || ''),
    },
    limits: {
      context_tokens: Number(process.env.LOCAL_MODEL_CONTEXT_TOKENS || 0) || undefined,
      max_concurrent: Number(process.env.LOCAL_MODEL_MAX_CONCURRENT || 1) || 1,
      timeout_ms: Number(process.env.LOCAL_MODEL_TIMEOUT_MS || 90000) || 90000,
    },
    permissions: {
      memory_read: clean(process.env.LOCAL_MODEL_MEMORY_READ || 'project_scoped'),
      memory_write: clean(process.env.LOCAL_MODEL_MEMORY_WRITE || 'write_intent_only'),
      workspace_read: truthyEnv(process.env.LOCAL_MODEL_WORKSPACE_READ || 'true'),
      workspace_write: truthyEnv(process.env.LOCAL_MODEL_WORKSPACE_WRITE || ''),
    },
    role_bias: uniqueStrings(String(process.env.LOCAL_MODEL_ROLE_BIAS || 'research,review,draft,local_private_reasoning').split(','), { lower: true }),
    cost_profile: normalizeCostProfile({ tier: process.env.LOCAL_MODEL_COST_TIER || process.env.OLLAMA_COST_TIER || 'free', billing: 'local' }),
    latency_profile: normalizeLatencyProfile({ tier: process.env.LOCAL_MODEL_LATENCY_TIER || process.env.OLLAMA_LATENCY_TIER || 'medium' }),
    quality_profile: normalizeQualityProfile({ tier: process.env.LOCAL_MODEL_QUALITY_TIER || process.env.OLLAMA_QUALITY_TIER || 'standard' }),
    privacy_profile: normalizePrivacyProfile({
      tier: process.env.LOCAL_MODEL_PRIVACY_TIER || process.env.OLLAMA_PRIVACY_TIER || (isLoopbackUrl(baseUrl) ? 'local_private' : 'trusted_private'),
      data_boundary: process.env.LOCAL_MODEL_DATA_BOUNDARY || process.env.OLLAMA_DATA_BOUNDARY || (isLoopbackUrl(baseUrl) ? 'local_device' : 'user_controlled_remote'),
      sends_context_off_device: !isLoopbackUrl(baseUrl),
      trusted_context: inferConfiguredOllamaTrustedContext(baseUrl, process.env.LOCAL_MODEL_RUNTIME || process.env.OLLAMA_RUNTIME || (baseUrl.includes('11434') ? 'ollama' : 'openai_compatible')),
      allow_private_context: inferConfiguredOllamaTrustedContext(baseUrl, process.env.LOCAL_MODEL_RUNTIME || process.env.OLLAMA_RUNTIME || (baseUrl.includes('11434') ? 'ollama' : 'openai_compatible')),
      network_scope: process.env.LOCAL_MODEL_NETWORK_SCOPE || process.env.OLLAMA_NETWORK_SCOPE || (isLoopbackUrl(baseUrl) ? 'loopback' : 'remote'),
    }),
    account_profile: normalizeAccountProfile({
      mode: process.env.LOCAL_MODEL_ACCOUNT_MODE || process.env.PROVIDER_ACCOUNT_MODE || 'deployment_owner',
      billing_owner: process.env.LOCAL_MODEL_BILLING_OWNER || 'deployment_owner',
      credential_scope: process.env.LOCAL_MODEL_CREDENTIAL_SCOPE || 'none',
      isolation: process.env.LOCAL_MODEL_ISOLATION || 'local_process',
    }),
    routing: {
      priority: Number(process.env.LOCAL_MODEL_PRIORITY || 50) || 50,
      avoid_for: uniqueStrings(String(process.env.LOCAL_MODEL_AVOID_FOR || '').split(','), { lower: true }),
      prefer_for: uniqueStrings(String(process.env.LOCAL_MODEL_PREFER_FOR || 'private_context,review,draft').split(','), { lower: true }),
    },
  };
}

function normalizeProvider(value = '') {
  const key = cleanId(value);
  if (!key) return 'openai_compatible';
  if (['openai-compatible', 'openai_compatible', 'openai compatible', 'ollama', 'llama.cpp', 'llamacpp', 'local', 'local_openai'].includes(key)) return 'openai_compatible';
  return key;
}

function normalizeModelNode(raw = {}, index = 0) {
  const row = asObject(raw);
  const id = cleanId(row.id || row.node_id || row.nodeId || row.name || `model_node_${index + 1}`);
  const provider = normalizeProvider(row.provider || row.type || row.runtime || 'openai_compatible');
  const model = clean(row.model || row.model_id || row.modelId || row.name || '');
  const baseUrl = clean(row.base_url || row.baseUrl || row.endpoint || row.url || '');
  if (!id || !model) return null;
  const normalized = {
    id,
    label: clean(row.label || row.display_name || row.displayName || row.name || id) || id,
    provider,
    runtime: cleanId(row.runtime || row.engine || (baseUrl.includes('11434') ? 'ollama' : provider)) || provider,
    base_url: baseUrl,
    model,
    location: clean(row.location || row.host || ''),
    enabled: row.enabled !== false,
    capabilities: {
      chat: row.capabilities?.chat !== false,
      structured_json: row.capabilities?.structured_json === true || row.capabilities?.structuredJson === true,
      tool_calling: row.capabilities?.tool_calling === true || row.capabilities?.toolCalling === true,
      code: row.capabilities?.code === true,
      vision: row.capabilities?.vision === true,
      embedding: row.capabilities?.embedding === true,
      ...asObject(row.capabilities),
    },
    limits: {
      context_tokens: Number(row.limits?.context_tokens || row.limits?.contextTokens || row.context_tokens || row.contextTokens || 0) || undefined,
      max_concurrent: Number(row.limits?.max_concurrent || row.limits?.maxConcurrent || row.max_concurrent || row.maxConcurrent || 1) || 1,
      timeout_ms: Number(row.limits?.timeout_ms || row.limits?.timeoutMs || row.timeout_ms || row.timeoutMs || 90000) || 90000,
      max_output_tokens: Number(row.limits?.max_output_tokens || row.limits?.maxOutputTokens || row.max_output_tokens || row.maxOutputTokens || 0) || undefined,
    },
    permissions: {
      memory_read: clean(row.permissions?.memory_read || row.permissions?.memoryRead || row.memory_read || 'project_scoped'),
      memory_write: clean(row.permissions?.memory_write || row.permissions?.memoryWrite || row.memory_write || 'write_intent_only'),
      workspace_read: row.permissions?.workspace_read === true || row.permissions?.workspaceRead === true || row.workspace_read === true,
      workspace_write: row.permissions?.workspace_write === true || row.permissions?.workspaceWrite === true || row.workspace_write === true,
      ...asObject(row.permissions),
    },
    role_bias: uniqueStrings(row.role_bias || row.roleBias || row.roles || [], { max: 12, lower: true }),
    tags: uniqueStrings(row.tags || [], { max: 12, lower: true }),
    cost_profile: normalizeCostProfile(row.cost_profile || row.costProfile || row.cost || {}, { tier: 'unknown' }),
    latency_profile: normalizeLatencyProfile(row.latency_profile || row.latencyProfile || row.latency || {}, { tier: 'unknown' }),
    quality_profile: normalizeQualityProfile(row.quality_profile || row.qualityProfile || row.quality || {}, { tier: 'standard' }),
    privacy_profile: normalizePrivacyProfile(row.privacy_profile || row.privacyProfile || row.privacy || {}, {
      tier: isLoopbackUrl(baseUrl) ? 'local_private' : (row.trusted_context === false || row.trustedContext === false ? 'remote' : (cleanId(row.runtime || row.engine || provider) === 'ollama' ? 'trusted_private' : 'remote')),
      data_boundary: isLoopbackUrl(baseUrl) ? 'local_device' : (row.trusted_context === false || row.trustedContext === false ? 'remote_endpoint' : (cleanId(row.runtime || row.engine || provider) === 'ollama' ? 'user_controlled_remote' : 'remote_endpoint')),
      sends_context_off_device: !isLoopbackUrl(baseUrl),
      trusted_context: row.trusted_context === true || row.trustedContext === true || row.allow_private_context === true || row.allowPrivateContext === true || (row.trusted_context !== false && row.trustedContext !== false && cleanId(row.runtime || row.engine || provider) === 'ollama'),
      allow_private_context: row.allow_private_context === true || row.allowPrivateContext === true || row.trusted_context === true || row.trustedContext === true || (row.trusted_context !== false && row.trustedContext !== false && cleanId(row.runtime || row.engine || provider) === 'ollama'),
      network_scope: isLoopbackUrl(baseUrl) ? 'loopback' : 'remote',
    }),
    account_profile: normalizeAccountProfile(row.account_profile || row.accountProfile || row.account || {}, {
      mode: process.env.PROVIDER_ACCOUNT_MODE || 'deployment_owner',
      billing_owner: 'deployment_owner',
      credential_scope: 'service',
    }),
    routing: {
      priority: Number(row.routing?.priority ?? row.priority ?? 50) || 50,
      prefer_for: uniqueStrings(row.routing?.prefer_for || row.routing?.preferFor || row.prefer_for || row.preferFor || [], { max: 16, lower: true }),
      avoid_for: uniqueStrings(row.routing?.avoid_for || row.routing?.avoidFor || row.avoid_for || row.avoidFor || [], { max: 16, lower: true }),
      max_cost_tier: clean(row.routing?.max_cost_tier || row.routing?.maxCostTier || ''),
    },
    health: asObject(row.health),
  };
  return applyModelCatalogToNode(normalized);
}

function readNodesFromFile(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const parsed = parseJsonMaybe(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : asArray(parsed?.nodes);
  return rows.map((row, index) => normalizeModelNode(row, index)).filter(Boolean);
}

function readConfigNodes() {
  // Discovered nodes are loaded first so explicit config/model_nodes.json entries
  // with the same id can override auto-discovered metadata.
  const discovered = readNodesFromFile(modelNodesDiscoveredConfigPath());
  const configured = readNodesFromFile(modelNodesConfigPath());
  return [...discovered, ...configured];
}

export function listModelNodes({ includeDisabled = false } = {}) {
  const rows = [...readConfigNodes()];
  const envNode = defaultLocalNodeFromEnv();
  if (envNode) rows.push(normalizeModelNode(envNode, rows.length));
  const seen = new Map();
  for (const node of rows) {
    if (!node?.id) continue;
    if (!includeDisabled && node.enabled === false) continue;
    seen.set(node.id, node);
  }
  return [...seen.values()];
}

export function getModelNode(idOrModel = '') {
  const key = cleanId(idOrModel);
  if (!key) return null;
  return listModelNodes({ includeDisabled: true }).find((node) => cleanId(node.id) === key || cleanId(node.model) === key || cleanId(node.label) === key) || null;
}

export function isModelNodeProvider(provider = '') {
  return ['openai_compatible', 'ollama', 'local_model', 'local'].includes(cleanId(provider));
}

export function modelNodeProviderAliases() {
  return ['openai_compatible', 'ollama', 'local'];
}

export function listPlannerModelChoices() {
  return listModelNodes().map((node) => ({
    id: node.model,
    label: node.label,
    provider: node.provider,
    node_id: node.id,
    runtime: node.runtime,
    local: true,
  }));
}

export function formatModelNodeInventoryForPlanner({ maxNodes = 8 } = {}) {
  const nodes = listModelNodes().slice(0, Math.max(1, Math.floor(Number(maxNodes) || 8)));
  if (nodes.length === 0) return '';
  const lines = nodes.map((node) => {
    const capabilities = Object.entries(asObject(node.capabilities))
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key)
      .slice(0, 6)
      .join(', ') || 'chat';
    const permissions = [
      node.permissions?.memory_read ? `memory_read=${node.permissions.memory_read}` : '',
      node.permissions?.memory_write ? `memory_write=${node.permissions.memory_write}` : '',
      node.permissions?.workspace_read ? 'workspace_read' : '',
      node.permissions?.workspace_write ? 'workspace_write' : '',
    ].filter(Boolean).join(', ') || 'scoped_context_only';
    const roleBias = node.role_bias?.length ? `; good_for=${node.role_bias.join(',')}` : '';
    const cost = node.cost_profile?.tier ? `; cost=${node.cost_profile.tier}` : '';
    const latency = node.latency_profile?.tier ? `; latency=${node.latency_profile.tier}` : '';
    const quality = node.quality_profile?.tier ? `; quality=${node.quality_profile.tier}` : '';
    const privacy = node.privacy_profile?.tier ? `; privacy=${node.privacy_profile.tier}` : '';
    const context = node.limits?.context_tokens ? `; context=${node.limits.context_tokens}` : '';
    const account = node.account_profile?.billing_owner ? `; billing_owner=${node.account_profile.billing_owner}` : '';
    return `- node_id=${node.id}; provider=${node.provider}; model=${node.model}; label=${node.label}; runtime=${node.runtime}; capabilities=${capabilities}; permissions=${permissions}${roleBias}${cost}${latency}${quality}${privacy}${context}${account}`;
  });
  return ['Available local/API model nodes:', ...lines].join('\n');
}

export function modelNodeRuntimeSnapshot() {
  return {
    nodes: listModelNodes().map((node) => ({
      id: node.id,
      label: node.label,
      provider: node.provider,
      runtime: node.runtime,
      base_url: node.base_url,
      model: node.model,
      capabilities: node.capabilities,
      permissions: node.permissions,
      limits: node.limits,
      role_bias: node.role_bias,
      tags: node.tags,
      cost_profile: node.cost_profile,
      latency_profile: node.latency_profile,
      quality_profile: node.quality_profile,
      privacy_profile: node.privacy_profile,
      account_profile: node.account_profile,
      routing: node.routing,
      health: node.health,
    })),
  };
}
