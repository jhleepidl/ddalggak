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

export function normalizeVisibilityEdge(raw = {}) {
  const row = asObject(raw);
  const fromScopeId = normalizeText(row.from_scope_id || row.fromScopeId || row.from);
  const toScopeId = normalizeText(row.to_scope_id || row.toScopeId || row.to);
  if (!fromScopeId || !toScopeId || fromScopeId === toScopeId) return null;
  return {
    from_scope_id: fromScopeId,
    to_scope_id: toScopeId,
    relation: normalizeText(row.relation || "depends_on_scope", { lower: true }) || "depends_on_scope",
    selection_reason: normalizeText(row.selection_reason || row.selectionReason || row.reason) || undefined,
  };
}

export function normalizeVisibilityGraph(raw = []) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(raw)) {
    const normalized = normalizeVisibilityEdge(entry);
    if (!normalized) continue;
    const signature = `${normalized.from_scope_id}|${normalized.to_scope_id}|${normalized.relation}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(normalized);
  }
  return out;
}
