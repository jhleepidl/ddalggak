import { normalizeStringList } from "../shared/normalize.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

export function normalizeExecutionCheckpoint(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const checkpointId = normalizeText(
    row.checkpoint_id || row.checkpointId || row.id
  ).toLowerCase();
  if (!checkpointId) return null;
  return {
    checkpoint_id: checkpointId,
    label: normalizeText(row.label || row.name || checkpointId) || checkpointId,
    kind: normalizeText(row.kind || row.type || "quality_gate").toLowerCase() || "quality_gate",
    target_slot_ids: normalizeStringList(
      row.target_slot_ids ?? row.targetSlotIds ?? [],
      { max: 16, lower: false }
    ),
    approval_required: row.approval_required === true || row.approvalRequired === true,
    completion_signal: row.completion_signal && typeof row.completion_signal === "object"
      ? row.completion_signal
      : { when: normalizeText(row.completion_signal || row.completionSignal || "manual_ack") || "manual_ack" },
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
    status: normalizeText(row.status || "pending").toLowerCase() || "pending",
  };
}

export function normalizeExecutionCheckpointList(list = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeExecutionCheckpoint(row);
    if (!normalized || seen.has(normalized.checkpoint_id)) continue;
    seen.add(normalized.checkpoint_id);
    out.push(normalized);
  }
  return out;
}
