import crypto from "node:crypto";
import { normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "./skill_attachment.js";
import { getTransportRoleId, normalizeRoleId } from "../compatibility/legacy_roles.js";

function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function createInstanceId() {
  return `inst_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeStatus(raw = "", fallback = "ready") {
  const value = normalizeText(raw, { lower: true });
  if (["ready", "running", "done", "error", "disabled", "planned"].includes(value)) {
    return value;
  }
  return fallback;
}

export function normalizeRuntimeAgentInstance(raw = {}, {
  defaultRoleId = "",
  defaultSlotId = "",
  defaultPresetId = "",
  defaultSelectionReason = "",
} = {}) {
  const row = asObject(raw);
  const roleId = normalizeRoleId(
    row.role_id
    || row.roleId
    || row.role_type
    || row.roleType
    || row.role_label
    || row.roleLabel
    || row.display_label
    || row.displayLabel
    || defaultRoleId
  );
  const attachedSkills = normalizeSkillAttachmentList(
    row.attached_skills
    ?? row.attachedSkills
    ?? row.skill_items
    ?? []
  );
  const attachedSkillIds = normalizeStringList([
    ...(Array.isArray(row.attached_skill_ids) ? row.attached_skill_ids : []),
    ...(Array.isArray(row.attachedSkillIds) ? row.attachedSkillIds : []),
    ...attachedSkills.map((entry) => entry.skill_id),
  ], { max: 64, lower: true });
  const hasExplicitTemplateId = Object.prototype.hasOwnProperty.call(row, "template_id")
    || Object.prototype.hasOwnProperty.call(row, "templateId");
  const templateId = normalizeText(
    hasExplicitTemplateId
      ? (row.template_id ?? row.templateId ?? "")
      : (row.template_id || row.templateId || getTransportRoleId(roleId))
  , { lower: true }) || undefined;
  const displayLabel = normalizeText(
    row.display_label
    || row.displayLabel
    || row.role_label
    || row.roleLabel
    || roleId
    || templateId
    || "runtime_agent"
  ) || "runtime_agent";
  const presetId = normalizeText(
    row.preset_id
    || row.presetId
    || defaultPresetId
    || templateId
  , { lower: true }) || undefined;
  const instanceId = normalizeText(
    row.instance_id
    || row.instanceId
    || row.runtime_instance_id
    || row.runtimeInstanceId
  ) || createInstanceId();
  return {
    instance_id: instanceId,
    slot_id: normalizeText(row.slot_id || row.slotId || defaultSlotId) || undefined,
    role_id: roleId || undefined,
    display_label: displayLabel,
    preset_id: presetId,
    synthesized: row.synthesized === true || (!presetId && !templateId),
    attached_skill_ids: attachedSkillIds,
    attached_skills: attachedSkills,
    context_pack_id: normalizeText(row.context_pack_id || row.contextPackId) || undefined,
    authority_profile_id: normalizeText(
      row.authority_profile_id || row.authorityProfileId
    ).toLowerCase() || undefined,
    selection_reason: normalizeText(
      row.selection_reason || row.selectionReason || defaultSelectionReason
    ) || undefined,
    template_id: templateId,
    provider: normalizeText(row.provider, { lower: true }) || undefined,
    model: normalizeText(row.model) || undefined,
    role_label: normalizeText(row.role_label || row.roleLabel || roleId, { lower: true }) || undefined,
    assigned_goal: normalizeText(row.assigned_goal || row.assignedGoal) || undefined,
    run_id: normalizeText(row.run_id || row.runId) || undefined,
    capability_tags: normalizeStringList(
      row.capability_tags ?? row.capabilityTags ?? [],
      { max: 32, lower: true }
    ),
    status: normalizeStatus(
      row.status
      ?? row.runtime_status
      ?? row.runtimeStatus,
      "ready"
    ),
    ephemeral: row.ephemeral === true,
    fallback: row.fallback === true,
    provider_binding: row.provider_binding && typeof row.provider_binding === "object"
      ? row.provider_binding
      : (row.providerBinding && typeof row.providerBinding === "object" ? row.providerBinding : undefined),
    lens_spec: row.lens_spec && typeof row.lens_spec === "object"
      ? row.lens_spec
      : (row.lensSpec && typeof row.lensSpec === "object" ? row.lensSpec : undefined),
    execution_budget: row.execution_budget && typeof row.execution_budget === "object"
      ? row.execution_budget
      : (row.executionBudget && typeof row.executionBudget === "object" ? row.executionBudget : undefined),
  };
}

export function normalizeRuntimeAgentList(list = [], options = {}) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeRuntimeAgentInstance(row, options);
    if (!normalized || seen.has(normalized.instance_id)) continue;
    seen.add(normalized.instance_id);
    out.push(normalized);
  }
  return out;
}

export function createRuntimeAgentInstance(raw = {}) {
  return normalizeRuntimeAgentInstance(raw);
}
