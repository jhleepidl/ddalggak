import { normalizeScopeGrantSet } from './scope_grant.js';

function asObject(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeStringList(raw = [], { lower = true, max = 64 } = {}) {
  const rows = asArray(raw);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = normalizeText(row, { lower });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeBudget(raw = {}) {
  const row = asObject(raw);
  const softTokens = Number(row.soft_tokens ?? row.softTokens ?? row.soft_limit ?? row.softLimit);
  const hardTokens = Number(row.hard_tokens ?? row.hardTokens ?? row.hard_limit ?? row.hardLimit);
  return {
    soft_tokens: Number.isFinite(softTokens) ? Math.max(0, Math.floor(softTokens)) : undefined,
    hard_tokens: Number.isFinite(hardTokens) ? Math.max(0, Math.floor(hardTokens)) : undefined,
  };
}

function normalizeNodeSelection(raw = {}) {
  const row = asObject(raw);
  const strategy = normalizeText(row.strategy || row.mode || 'query_plus_closure', { lower: true })
    || 'query_plus_closure';
  return {
    strategy,
    query: normalizeText(row.query || row.prompt || '') || undefined,
    closure_edge_types: normalizeStringList(
      row.closure_edge_types ?? row.closureEdgeTypes ?? [],
      { lower: false, max: 24 }
    ),
    closure_direction: normalizeText(row.closure_direction || row.closureDirection || '', { lower: true }) || undefined,
    max_nodes: Number.isFinite(Number(row.max_nodes ?? row.maxNodes))
      ? Math.max(1, Math.min(512, Math.floor(Number(row.max_nodes ?? row.maxNodes))))
      : undefined,
    add_node_ids: normalizeStringList(row.add_node_ids ?? row.addNodeIds ?? [], { lower: false, max: 128 }),
    remove_node_ids: normalizeStringList(row.remove_node_ids ?? row.removeNodeIds ?? [], { lower: false, max: 128 }),
  };
}

export function normalizeScopeSpec(raw = {}, { fallbackIndex = 0 } = {}) {
  const row = asObject(raw);
  const scopeId = normalizeText(row.scope_id || row.scopeId || row.id || `scope_${fallbackIndex + 1}`);
  if (!scopeId) return null;
  const visibilityMode = normalizeText(row.visibility_mode || row.visibilityMode || row.mode || 'scoped', { lower: true }) || 'scoped';
  return {
    scope_id: scopeId,
    target_slot_id: normalizeText(row.target_slot_id || row.targetSlotId || row.slot_id || row.slotId) || undefined,
    target_instance_id: normalizeText(
      row.target_instance_id || row.targetInstanceId || row.target_runtime_agent_instance_id || row.targetRuntimeAgentInstanceId || row.instance_id || row.instanceId
    ) || undefined,
    role_id: normalizeText(row.role_id || row.roleId, { lower: true }) || undefined,
    visibility_mode: ['scoped', 'shared', 'shared_memory', 'scoped_context'].includes(visibilityMode)
      ? visibilityMode
      : 'scoped',
    context_types: normalizeStringList(row.context_types ?? row.contextTypes ?? [], { lower: true, max: 32 }),
    node_selection: normalizeNodeSelection(row.node_selection ?? row.nodeSelection ?? {}),
    memory_grants: normalizeScopeGrantSet(row.memory_grants ?? row.memoryGrants ?? {}),
    budget: normalizeBudget(row.budget ?? {}),
    selection_reason: normalizeText(row.selection_reason || row.selectionReason || row.reason) || undefined,
    context_pack_id: normalizeText(row.context_pack_id || row.contextPackId) || undefined,
    compatibility_mode: normalizeText(row.compatibility_mode || row.compatibilityMode, { lower: true }) || undefined,
    visibility_rationale: normalizeText(row.visibility_rationale || row.visibilityRationale) || undefined,
  };
}

export function normalizeScopeSpecList(raw = []) {
  const out = [];
  const seen = new Set();
  asArray(raw).forEach((entry, index) => {
    const normalized = normalizeScopeSpec(entry, { fallbackIndex: index });
    if (!normalized || seen.has(normalized.scope_id)) return;
    seen.add(normalized.scope_id);
    out.push(normalized);
  });
  return out;
}
