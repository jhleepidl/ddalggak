import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleList } from "../compatibility/legacy_roles.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeMode(raw = "", fallback = "run") {
  const value = normalizeText(raw).toLowerCase();
  return value || fallback;
}

function normalizeEnum(raw = "", allowed = [], fallback = "") {
  const value = normalizeText(raw).toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

function normalizeCandidateCapabilitySlot(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const roleId = normalizeRoleList(
    [row.role_id || row.roleId || row.role || row.role_label || row.roleLabel],
    { allowDeprecatedControlPlane: false, max: 1 }
  )[0];
  if (!roleId) return null;
  return {
    role_id: roleId,
    purpose: normalizeText(row.purpose || row.goal || roleId) || roleId,
    required_skill_ids: normalizeStringList(
      row.required_skill_ids ?? row.requiredSkillIds ?? [],
      { max: 24, lower: true }
    ),
    preferred_skill_ids: normalizeStringList(
      row.preferred_skill_ids ?? row.preferredSkillIds ?? [],
      { max: 24, lower: true }
    ),
    required_context_types: normalizeStringList(
      row.required_context_types ?? row.requiredContextTypes ?? [],
      { max: 24, lower: true }
    ),
    required_tool_ids: normalizeStringList(
      row.required_tool_ids ?? row.requiredToolIds ?? row.required_tools ?? row.requiredTools ?? [],
      { max: 24, lower: true }
    ),
    forbidden_skill_ids: normalizeStringList(
      row.forbidden_skill_ids ?? row.forbiddenSkillIds ?? [],
      { max: 24, lower: true }
    ),
    authority_profile_id: normalizeText(
      row.authority_profile_id || row.authorityProfileId
    ).toLowerCase() || undefined,
    parallelizable: row.parallelizable !== false,
    reviewer_required: row.reviewer_required === true || row.reviewerRequired === true || undefined,
    deliverable_type: normalizeText(row.deliverable_type || row.deliverableType).toLowerCase() || undefined,
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
  };
}

export function normalizeTaskInterpretation(raw = {}, {
  fallbackGoal = "",
  fallbackMode = "run",
} = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const goal = normalizeText(row.goal || row.objective || row.task || fallbackGoal);
  const operatingMode = normalizeMode(
    row.operating_mode || row.operatingMode || row.mode,
    fallbackMode
  );
  const preferredRoleIds = normalizeRoleList(
    row.preferred_role_ids ?? row.preferredRoleIds ?? row.preferred_roles ?? row.preferredRoles ?? [],
    { allowDeprecatedControlPlane: false, max: 16 }
  );
  const candidateCapabilitySlots = asArray(
    row.candidate_capability_slots ?? row.candidateCapabilitySlots ?? []
  ).map(normalizeCandidateCapabilitySlot).filter(Boolean);
  const preferredLocales = normalizeStringList(
    row.preferred_locales ?? row.preferredLocales ?? [],
    { max: 8, lower: false }
  );

  return {
    task_id: normalizeText(row.task_id || row.taskId || row.id) || undefined,
    goal,
    objective: normalizeText(row.objective || goal) || goal,
    operating_mode: operatingMode,
    mode: operatingMode,
    requested_deliverables: normalizeStringList(
      row.requested_deliverables ?? row.requestedDeliverables ?? row.deliverables ?? [],
      { max: 24, lower: false }
    ),
    constraints: normalizeStringList(row.constraints ?? [], { max: 24, lower: false }),
    preferred_role_ids: preferredRoleIds,
    preferred_roles: preferredRoleIds,
    source: normalizeText(row.source || "control_plane") || "control_plane",
    route_reason_hint: normalizeText(row.route_reason_hint || row.routeReasonHint) || undefined,
    notes: normalizeStringList(row.notes ?? [], { max: 24, lower: false }),
    task_type: normalizeEnum(
      row.task_type || row.taskType,
      ["analysis_report", "code_change", "workflow", "review", "mixed", "report", "analysis"],
      "analysis_report"
    ),
    task_summary: normalizeText(row.task_summary || row.taskSummary || goal) || goal,
    deliverable_type: normalizeEnum(
      row.deliverable_type || row.deliverableType,
      ["report", "brief", "code_patch", "software_delivery", "review_findings", "workflow_update", "research_notes", "artifact"],
      "report"
    ),
    risk_level: normalizeEnum(
      row.risk_level || row.riskLevel,
      ["low", "medium", "high"],
      "medium"
    ),
    domain_hints: normalizeStringList(
      row.domain_hints ?? row.domainHints ?? [],
      { max: 24, lower: true }
    ),
    candidate_capability_slots: candidateCapabilitySlots,
    control_mode: normalizeEnum(
      row.control_mode || row.controlMode,
      ["direct", "supervised", "checkpointed"],
      "direct"
    ),
    review_policy: normalizeEnum(
      row.review_policy || row.reviewPolicy,
      ["optional", "required", "claim_heavy", "code_default"],
      "optional"
    ),
    parallelism_preference: normalizeEnum(
      row.parallelism_preference || row.parallelismPreference,
      ["sequential", "parallel", "hybrid"],
      "hybrid"
    ),
    pinned_preset_ids: normalizeStringList(
      row.pinned_preset_ids ?? row.pinnedPresetIds ?? [],
      { max: 16, lower: true }
    ),
    banned_preset_ids: normalizeStringList(
      row.banned_preset_ids ?? row.bannedPresetIds ?? [],
      { max: 16, lower: true }
    ),
    preferred_domains: normalizeStringList(
      row.preferred_domains ?? row.preferredDomains ?? [],
      { max: 16, lower: true }
    ),
    preferred_locales: preferredLocales,
    suppressed_role_ids: normalizeRoleList(
      row.suppressed_role_ids ?? row.suppressedRoleIds ?? [],
      { allowDeprecatedControlPlane: false, max: 16 }
    ),
    suppressed_skill_ids: normalizeStringList(
      row.suppressed_skill_ids ?? row.suppressedSkillIds ?? [],
      { max: 24, lower: true }
    ),
  };
}
