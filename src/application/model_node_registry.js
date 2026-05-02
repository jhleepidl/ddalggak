import fs from 'node:fs';
import path from 'node:path';

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

function parseJsonMaybe(raw = '') {
  try {
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}

function modelNodesConfigPath() {
  const explicit = clean(process.env.MODEL_NODES_CONFIG || process.env.DDALGGAK_MODEL_NODES_CONFIG);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'config', 'model_nodes.json');
}

function defaultLocalNodeFromEnv() {
  const baseUrl = clean(process.env.LOCAL_MODEL_BASE_URL || process.env.OLLAMA_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL);
  const model = clean(process.env.LOCAL_MODEL || process.env.OLLAMA_MODEL || process.env.OPENAI_COMPATIBLE_MODEL);
  if (!baseUrl || !model) return null;
  return {
    id: cleanId(process.env.LOCAL_MODEL_NODE_ID || process.env.OLLAMA_NODE_ID || 'local_model'),
    label: clean(process.env.LOCAL_MODEL_LABEL || process.env.OLLAMA_LABEL || model),
    provider: 'openai_compatible',
    runtime: clean(process.env.LOCAL_MODEL_RUNTIME || (baseUrl.includes('11434') ? 'ollama' : 'openai_compatible')),
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
  return {
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
    health: asObject(row.health),
  };
}

function readConfigNodes() {
  const configPath = modelNodesConfigPath();
  if (!fs.existsSync(configPath)) return [];
  const parsed = parseJsonMaybe(fs.readFileSync(configPath, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : asArray(parsed?.nodes);
  return rows.map((row, index) => normalizeModelNode(row, index)).filter(Boolean);
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
    return `- node_id=${node.id}; provider=${node.provider}; model=${node.model}; label=${node.label}; runtime=${node.runtime}; capabilities=${capabilities}; permissions=${permissions}${roleBias}`;
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
      health: node.health,
    })),
  };
}
