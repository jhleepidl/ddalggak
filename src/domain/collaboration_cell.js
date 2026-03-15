import { normalizeStringList } from "../shared/normalize.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeRounds(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

export function normalizeCollaborationCell(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const cellId = normalizeText(row.cell_id || row.cellId || row.id).toLowerCase();
  if (!cellId) return null;
  return {
    cell_id: cellId,
    pattern: normalizeText(row.pattern || "handoff").toLowerCase() || "handoff",
    member_instance_ids: normalizeStringList(
      row.member_instance_ids ?? row.memberInstanceIds ?? [],
      { max: 16, lower: false }
    ),
    topology: normalizeText(row.topology || "pair").toLowerCase() || "pair",
    max_rounds: normalizeRounds(row.max_rounds ?? row.maxRounds, 1),
    termination: row.termination && typeof row.termination === "object"
      ? row.termination
      : { condition: normalizeText(row.termination || "handoff_complete") || "handoff_complete" },
    visibility: normalizeText(row.visibility).toLowerCase() || undefined,
  };
}

export function normalizeCollaborationCellList(list = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeCollaborationCell(row);
    if (!normalized || seen.has(normalized.cell_id)) continue;
    seen.add(normalized.cell_id);
    out.push(normalized);
  }
  return out;
}
