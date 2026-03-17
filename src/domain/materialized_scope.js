function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "", { lower = false } = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeStringList(raw = [], { lower = false, max = 256 } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(raw)) {
    const text = normalizeText(entry, { lower });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeBreakdown(raw = {}) {
  const row = asObject(raw);
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = normalizeText(key, { lower: true });
    const cleanValue = Number(value);
    if (!cleanKey || !Number.isFinite(cleanValue)) continue;
    out[cleanKey] = Math.max(0, Math.floor(cleanValue));
  }
  return out;
}

export function normalizeMaterializedScope(raw = {}, { fallbackIndex = 0 } = {}) {
  const row = asObject(raw);
  const scopeId = normalizeText(row.scope_id || row.scopeId || row.id || `scope_${fallbackIndex + 1}`);
  if (!scopeId) return null;
  const tokenEstimate = Number(row.token_estimate ?? row.tokenEstimate ?? row.estimated_tokens ?? row.estimatedTokens);
  const actualTokens = Number(row.actual_tokens ?? row.actualTokens);
  return {
    scope_id: scopeId,
    context_set_id: normalizeText(row.context_set_id || row.contextSetId) || undefined,
    active_node_ids: normalizeStringList(row.active_node_ids ?? row.activeNodeIds ?? row.node_ids ?? row.nodeIds ?? [], { lower: false, max: 512 }),
    compiled_text: String(row.compiled_text || row.compiledText || row.text || "").trim(),
    token_estimate: Number.isFinite(tokenEstimate) ? Math.max(0, Math.floor(tokenEstimate)) : undefined,
    actual_tokens: Number.isFinite(actualTokens) ? Math.max(0, Math.floor(actualTokens)) : undefined,
    type_breakdown: normalizeBreakdown(row.type_breakdown ?? row.typeBreakdown ?? row.node_type_breakdown ?? row.nodeTypeBreakdown ?? {}),
    scope_version: Number.isFinite(Number(row.scope_version ?? row.scopeVersion))
      ? Math.max(1, Math.floor(Number(row.scope_version ?? row.scopeVersion)))
      : undefined,
    lineage: asObject(row.lineage),
  };
}

export function normalizeMaterializedScopeList(raw = []) {
  const out = [];
  const seen = new Set();
  asArray(raw).forEach((entry, index) => {
    const normalized = normalizeMaterializedScope(entry, { fallbackIndex: index });
    if (!normalized || seen.has(normalized.scope_id)) return;
    seen.add(normalized.scope_id);
    out.push(normalized);
  });
  return out;
}
