import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleList } from "../compatibility/legacy_roles.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeMode(raw = "", fallback = "run") {
  const value = normalizeText(raw).toLowerCase();
  return value || fallback;
}

export function normalizeTaskInterpretation(raw = {}, {
  fallbackGoal = "",
  fallbackMode = "run",
} = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const goal = normalizeText(row.goal || row.objective || row.task || fallbackGoal);
  return {
    task_id: normalizeText(row.task_id || row.taskId || row.id) || undefined,
    goal,
    objective: normalizeText(row.objective || goal) || goal,
    operating_mode: normalizeMode(row.operating_mode || row.operatingMode || row.mode, fallbackMode),
    requested_deliverables: normalizeStringList(
      row.requested_deliverables ?? row.requestedDeliverables ?? row.deliverables ?? [],
      { max: 24, lower: false }
    ),
    constraints: normalizeStringList(row.constraints ?? [], { max: 24, lower: false }),
    preferred_role_ids: normalizeRoleList(
      row.preferred_role_ids ?? row.preferredRoleIds ?? row.preferred_roles ?? row.preferredRoles ?? [],
      { allowDeprecatedControlPlane: false, max: 16 }
    ),
    source: normalizeText(row.source || "control_plane") || "control_plane",
    route_reason_hint: normalizeText(row.route_reason_hint || row.routeReasonHint) || undefined,
    notes: normalizeStringList(row.notes ?? [], { max: 24, lower: false }),
  };
}
