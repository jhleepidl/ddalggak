import { listModelNodes } from './model_node_registry.js';
import { checkOpenAICompatibleHealth } from '../providers/openai_compatible.js';

function clean(value = '') {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

export async function checkModelNodeHealth(node = {}, { timeoutMs = 4000 } = {}) {
  const provider = clean(node.provider || '').toLowerCase();
  if (node.enabled === false) return { ok: false, status: 'disabled', checked_at: nowIso() };
  if (provider === 'openai_compatible' || provider === 'ollama' || provider === 'local' || provider === 'local_model') {
    const health = await checkOpenAICompatibleHealth(node, { timeoutMs });
    return { ...health, checked_at: nowIso() };
  }
  return { ok: false, status: 'unsupported_provider', provider, checked_at: nowIso() };
}

export async function listModelNodesWithHealth({ includeDisabled = true, timeoutMs = 4000 } = {}) {
  const nodes = listModelNodes({ includeDisabled });
  const out = [];
  for (const node of nodes) {
    out.push({ ...node, health: await checkModelNodeHealth(node, { timeoutMs }) });
  }
  return out;
}
