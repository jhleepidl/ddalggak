import { normalizeStringList } from "../shared/normalize.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeRounds(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function normalizePattern(raw = "") {
  const value = normalizeText(raw).toLowerCase();
  if ([
    "single",
    "parallel_fanout",
    "reflection",
    "debate",
    "committee",
    "handoff",
    "manager_as_tool",
  ].includes(value)) {
    return value;
  }
  if (["review_loop", "reflection_loop"].includes(value)) return "reflection";
  if (["oversight", "supervisor"].includes(value)) return "manager_as_tool";
  return "single";
}

function normalizeTopology(raw = "", pattern = "single") {
  const value = normalizeText(raw).toLowerCase();
  if (value) return value;
  if (pattern === "parallel_fanout") return "fanout";
  if (pattern === "reflection") return "loop";
  if (pattern === "manager_as_tool") return "hub";
  if (pattern === "handoff") return "pipeline";
  return "single";
}

export function normalizeCollaborationCell(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const cellId = normalizeText(row.cell_id || row.cellId || row.id).toLowerCase();
  if (!cellId) return null;
  const pattern = normalizePattern(row.pattern || row.type || "single");
  return {
    cell_id: cellId,
    pattern,
    member_instance_ids: normalizeStringList(
      row.member_instance_ids ?? row.memberInstanceIds ?? [],
      { max: 16, lower: false }
    ),
    topology: normalizeTopology(row.topology, pattern),
    max_rounds: normalizeRounds(row.max_rounds ?? row.maxRounds, 1),
    termination: row.termination && typeof row.termination === "object"
      ? row.termination
      : { condition: normalizeText(row.termination || "handoff_complete") || "handoff_complete" },
    visibility: normalizeText(row.visibility).toLowerCase() || undefined,
    report_back_to_instance_id: normalizeText(
      row.report_back_to_instance_id || row.reportBackToInstanceId
    ) || undefined,
    target_instance_ids: normalizeStringList(
      row.target_instance_ids ?? row.targetInstanceIds ?? [],
      { max: 16, lower: false }
    ),
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
    status: normalizeText(row.status || "planned").toLowerCase() || "planned",
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
