import { normalizeSkillAttachmentList, summarizeSkillLoadLevels } from "../domain/skill_attachment.js";
import { normalizeContextPackList } from "../domain/context_pack.js";
import { normalizeSkillUsageEvent, summarizeSkillUsageEvents } from "./skill_feedback.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeTagList(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeStringList(value, { lower = true } = {}) {
  const rows = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = String(row || "").trim();
    if (!text) continue;
    const normalized = lower ? text.toLowerCase() : text;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeSkillLoadLevelsMap(value = {}) {
  const row = asObject(value);
  const out = {};
  for (const [key, entry] of Object.entries(row)) {
    const mapKey = String(key || "").trim();
    if (!mapKey) continue;
    const entryObj = asObject(entry);
    const normalized = {};
    for (const [skillId, loadLevel] of Object.entries(entryObj)) {
      const cleanSkillId = String(skillId || "").trim().toLowerCase();
      const cleanLoadLevel = String(loadLevel || "").trim().toLowerCase();
      if (!cleanSkillId || !cleanLoadLevel) continue;
      normalized[cleanSkillId] = cleanLoadLevel;
    }
    if (Object.keys(normalized).length > 0) out[mapKey] = normalized;
  }
  return out;
}

export const ACTION_SOURCE_VALUES = Object.freeze([
  "explicit_route_plan",
  "generated_team_actions",
  "default_fallback_route",
]);

export const PLAN_SOURCE_VALUES = Object.freeze([
  "local",
  "goc",
  "local_fallback",
]);

const ACTION_SOURCE_ALIAS_MAP = {
  explicit: "explicit_route_plan",
  explicit_route: "explicit_route_plan",
  explicit_plan: "explicit_route_plan",
  route_plan: "explicit_route_plan",
  team: "generated_team_actions",
  generated: "generated_team_actions",
  generated_actions: "generated_team_actions",
  team_actions: "generated_team_actions",
  team_generated: "generated_team_actions",
  fallback: "default_fallback_route",
  fallback_route: "default_fallback_route",
  route_fallback: "default_fallback_route",
  default: "default_fallback_route",
  default_route: "default_fallback_route",
};

export function normalizeActionSource(value = "", { fallback = "" } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (ACTION_SOURCE_VALUES.includes(raw)) return raw;
  if (ACTION_SOURCE_ALIAS_MAP[raw]) return ACTION_SOURCE_ALIAS_MAP[raw];
  const fallbackRaw = String(fallback || "").trim().toLowerCase();
  if (!fallbackRaw || fallbackRaw === raw) return "";
  return normalizeActionSource(fallbackRaw);
}

function normalizeSourceMode(value = "", { fallback = "standalone" } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "goc") return "goc";
  if (raw === "standalone" || raw === "local") return "standalone";
  return fallback;
}

function normalizeCapabilitySource(value = "", { fallback = "local" } = {}) {
  return String(value || "").trim().toLowerCase() === "goc" ? "goc" : fallback;
}

function normalizeSkillCatalogSource(value = "", { fallback = "local" } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "goc") return "goc";
  if (raw === "mixed") return "mixed";
  return fallback;
}

export function normalizePlanSource(value = "", { fallback = "local" } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (PLAN_SOURCE_VALUES.includes(raw)) return raw;
  const fallbackRaw = String(fallback || "").trim().toLowerCase();
  if (PLAN_SOURCE_VALUES.includes(fallbackRaw)) return fallbackRaw;
  return "local";
}

function hasRuntimeAuthorityFields(row = {}) {
  return !!(
    row.runtime_authority
    || row.runtimeAuthority
    || row.mode
    || row.plan_source
    || row.planSource
    || row.context_source
    || row.contextSource
    || row.agent_catalog_source
    || row.agentCatalogSource
    || row.conversation_team_source
    || row.conversationTeamSource
    || row.skill_catalog_source
    || row.skillCatalogSource
    || Object.prototype.hasOwnProperty.call(row, "degraded_mode")
    || Object.prototype.hasOwnProperty.call(row, "degradedMode")
    || Object.prototype.hasOwnProperty.call(row, "fallback_reason")
    || Object.prototype.hasOwnProperty.call(row, "fallbackReason")
  );
}

export function normalizeRuntimeAuthority(input = null, { fallback = null } = {}) {
  if (!input || typeof input !== "object") {
    return fallback && typeof fallback === "object" ? normalizeRuntimeAuthority(fallback) : null;
  }
  const row = asObject(input);
  const nested = row.runtime_authority ?? row.runtimeAuthority;
  const src = nested && typeof nested === "object" ? asObject(nested) : row;
  const fallbackRow = fallback && typeof fallback === "object" ? asObject(fallback) : {};
  if (!hasRuntimeAuthorityFields(src) && !hasRuntimeAuthorityFields(fallbackRow)) return null;

  const mode = normalizeSourceMode(
    src.mode
    ?? fallbackRow.mode
    ?? "standalone",
    { fallback: "standalone" }
  );
  const planSource = normalizePlanSource(
    src.plan_source
    ?? src.planSource
    ?? fallbackRow.plan_source
    ?? fallbackRow.planSource
    ?? (mode === "goc" ? "goc" : "local"),
    { fallback: mode === "goc" ? "goc" : "local" }
  );
  const contextSource = normalizeCapabilitySource(
    src.context_source
    ?? src.contextSource
    ?? fallbackRow.context_source
    ?? fallbackRow.contextSource
    ?? (mode === "goc" ? "goc" : "local"),
    { fallback: mode === "goc" ? "goc" : "local" }
  );
  const agentCatalogSource = normalizeCapabilitySource(
    src.agent_catalog_source
    ?? src.agentCatalogSource
    ?? fallbackRow.agent_catalog_source
    ?? fallbackRow.agentCatalogSource
    ?? (mode === "goc" ? "goc" : "local"),
    { fallback: mode === "goc" ? "goc" : "local" }
  );
  const conversationTeamSource = normalizeCapabilitySource(
    src.conversation_team_source
    ?? src.conversationTeamSource
    ?? fallbackRow.conversation_team_source
    ?? fallbackRow.conversationTeamSource
    ?? (mode === "goc" ? "goc" : "local"),
    { fallback: mode === "goc" ? "goc" : "local" }
  );
  const skillCatalogSource = normalizeSkillCatalogSource(
    src.skill_catalog_source
    ?? src.skillCatalogSource
    ?? fallbackRow.skill_catalog_source
    ?? fallbackRow.skillCatalogSource
    ?? (mode === "goc" ? "mixed" : "local"),
    { fallback: mode === "goc" ? "mixed" : "local" }
  );
  const degradedMode = src.degraded_mode === true
    || src.degradedMode === true
    || fallbackRow.degraded_mode === true
    || fallbackRow.degradedMode === true;
  const fallbackReasonRaw = (
    Object.prototype.hasOwnProperty.call(src, "fallback_reason")
      ? src.fallback_reason
      : (Object.prototype.hasOwnProperty.call(src, "fallbackReason")
        ? src.fallbackReason
        : (Object.prototype.hasOwnProperty.call(fallbackRow, "fallback_reason")
          ? fallbackRow.fallback_reason
          : fallbackRow.fallbackReason))
  );
  return {
    mode,
    plan_source: planSource,
    context_source: contextSource,
    agent_catalog_source: agentCatalogSource,
    conversation_team_source: conversationTeamSource,
    skill_catalog_source: skillCatalogSource,
    degraded_mode: degradedMode,
    fallback_reason: fallbackReasonRaw == null ? null : String(fallbackReasonRaw),
  };
}

export function normalizeRuntimeAgent(agent = {}, { defaultStatus = "ready" } = {}) {
  const row = asObject(agent);
  const statusRaw = (
    row.status
    ?? row.runtime_status
    ?? row.runtimeStatus
    ?? defaultStatus
  );
  return {
    instance_id: String(
      row.instance_id
      || row.runtime_instance_id
      || row.instanceId
      || row.runtimeInstanceId
      || ""
    ).trim(),
    template_id: String(row.template_id || row.templateId || "").trim().toLowerCase() || undefined,
    role_label: String(row.role_label || row.roleLabel || "").trim().toLowerCase() || undefined,
    provider: String(row.provider || "").trim().toLowerCase() || undefined,
    model: String(row.model || "").trim() || undefined,
    assigned_goal: String(row.assigned_goal || row.assignedGoal || "").trim() || undefined,
    run_id: String(row.run_id || row.runId || "").trim() || undefined,
    attached_skills: normalizeSkillAttachmentList(row.attached_skills ?? row.attachedSkills ?? []),
    context_pack_id: String(row.context_pack_id || row.contextPackId || "").trim() || undefined,
    provider_binding: row.provider_binding && typeof row.provider_binding === "object"
      ? row.provider_binding
      : (row.providerBinding && typeof row.providerBinding === "object" ? row.providerBinding : undefined),
    capability_tags: normalizeTagList(row.capability_tags ?? row.capabilityTags),
    lens_spec: row.lens_spec && typeof row.lens_spec === "object"
      ? row.lens_spec
      : (row.lensSpec && typeof row.lensSpec === "object" ? row.lensSpec : undefined),
    execution_budget: row.execution_budget && typeof row.execution_budget === "object"
      ? row.execution_budget
      : (row.executionBudget && typeof row.executionBudget === "object" ? row.executionBudget : undefined),
    status: String(statusRaw || defaultStatus).trim().toLowerCase() || defaultStatus,
    ephemeral: row.ephemeral === true,
    fallback: row.fallback === true,
  };
}

function hasSnapshotFields(row = {}) {
  return !!(
    row.team_plan
    || row.teamPlan
    || Array.isArray(row.runtime_agents)
    || Array.isArray(row.runtimeAgents)
    || Array.isArray(row.context_packs)
    || Array.isArray(row.contextPacks)
    || Array.isArray(row.selected_skill_ids)
    || Array.isArray(row.selectedSkillIds)
    || row.skill_load_levels
    || row.skillLoadLevels
    || row.selection_reason_summary
    || row.selectionReasonSummary
    || Array.isArray(row.skill_usage_events)
    || Array.isArray(row.skillUsageEvents)
    || row.generated_at
    || row.generatedAt
    || row.source
  );
}

export function normalizeRuntimeTeamSnapshot(input = null, {
  defaultSource = "team_builder",
  defaultGeneratedAt = new Date().toISOString(),
} = {}) {
  if (!input || typeof input !== "object") return null;
  const root = asObject(input);
  const explicitSnapshotProvided = Object.prototype.hasOwnProperty.call(root, "runtime_team_snapshot")
    || Object.prototype.hasOwnProperty.call(root, "runtimeTeamSnapshot");
  const snapshotInput = explicitSnapshotProvided
    ? (root.runtime_team_snapshot ?? root.runtimeTeamSnapshot)
    : root;
  if (explicitSnapshotProvided && (!snapshotInput || typeof snapshotInput !== "object")) {
    return null;
  }
  const row = asObject(snapshotInput);
  if (!explicitSnapshotProvided && !hasSnapshotFields(row)) return null;

  const runtimeAgentsRaw = Array.isArray(row.runtime_agents)
    ? row.runtime_agents
    : (Array.isArray(row.runtimeAgents) ? row.runtimeAgents : []);
  const runtimeAgents = runtimeAgentsRaw
    .map((agent) => normalizeRuntimeAgent(agent))
    .filter((agent) => agent.instance_id || agent.template_id || agent.role_label);
  const contextPacks = normalizeContextPackList(
    row.context_packs
    ?? row.contextPacks
    ?? []
  );
  const selectedSkillIds = normalizeStringList(
    row.selected_skill_ids
    ?? row.selectedSkillIds
    ?? [],
    { lower: true }
  );
  const skillLoadLevels = normalizeSkillLoadLevelsMap(
    row.skill_load_levels
    ?? row.skillLoadLevels
    ?? {}
  );
  const selectionReasonSummary = row.selection_reason_summary && typeof row.selection_reason_summary === "object"
    ? row.selection_reason_summary
    : (row.selectionReasonSummary && typeof row.selectionReasonSummary === "object"
      ? row.selectionReasonSummary
      : {});
  const skillUsageEvents = (Array.isArray(row.skill_usage_events)
    ? row.skill_usage_events
    : (Array.isArray(row.skillUsageEvents) ? row.skillUsageEvents : []))
    .map((entry) => normalizeSkillUsageEvent(entry))
    .filter(Boolean);
  const skillUsageSummary = row.skill_usage_summary && typeof row.skill_usage_summary === "object"
    ? row.skill_usage_summary
    : (row.skillUsageSummary && typeof row.skillUsageSummary === "object"
      ? row.skillUsageSummary
      : summarizeSkillUsageEvents(skillUsageEvents));

  return {
    team_plan: row.team_plan && typeof row.team_plan === "object"
      ? row.team_plan
      : (row.teamPlan && typeof row.teamPlan === "object" ? row.teamPlan : null),
    runtime_agents: runtimeAgents,
    context_packs: contextPacks,
    selected_skill_ids: selectedSkillIds,
    skill_load_levels: skillLoadLevels,
    selection_reason_summary: selectionReasonSummary,
    skill_usage_events: skillUsageEvents,
    skill_usage_summary: skillUsageSummary,
    generated_at: String(row.generated_at || row.generatedAt || defaultGeneratedAt || new Date().toISOString()),
    source: String(row.source || defaultSource || "team_builder").trim() || "team_builder",
  };
}

export function createRuntimeTeamSnapshot({
  teamPlan = null,
  runtimeAgents = [],
  source = "team_builder",
  generatedAt = new Date().toISOString(),
  team_plan = undefined,
  runtime_agents = undefined,
  contextPacks = undefined,
  context_packs = undefined,
  selectedSkillIds = undefined,
  selected_skill_ids = undefined,
  skillLoadLevels = undefined,
  skill_load_levels = undefined,
  selectionReasonSummary = undefined,
  selection_reason_summary = undefined,
  skillUsageEvents = undefined,
  skill_usage_events = undefined,
  skillUsageSummary = undefined,
  skill_usage_summary = undefined,
  generated_at = undefined,
  runtime_team_snapshot = undefined,
  runtimeTeamSnapshot = undefined,
} = {}) {
  const nestedSnapshot = runtime_team_snapshot ?? runtimeTeamSnapshot;
  const normalizedNested = normalizeRuntimeTeamSnapshot(nestedSnapshot, {
    defaultSource: source,
    defaultGeneratedAt: generatedAt,
  });
  if (normalizedNested) return normalizedNested;

  return normalizeRuntimeTeamSnapshot({
    team_plan: team_plan ?? teamPlan,
    runtime_agents: runtime_agents ?? runtimeAgents,
    context_packs: context_packs ?? contextPacks,
    selected_skill_ids: selected_skill_ids ?? selectedSkillIds,
    skill_load_levels: skill_load_levels ?? skillLoadLevels,
    selection_reason_summary: selection_reason_summary ?? selectionReasonSummary,
    skill_usage_events: skill_usage_events ?? skillUsageEvents,
    skill_usage_summary: skill_usage_summary ?? skillUsageSummary,
    generated_at: generated_at ?? generatedAt,
    source,
  }, {
    defaultSource: source,
    defaultGeneratedAt: generatedAt,
  }) || {
    team_plan: null,
    runtime_agents: [],
    generated_at: String(generatedAt || new Date().toISOString()),
    source: String(source || "team_builder").trim() || "team_builder",
  };
}

export function normalizeRuntimeMetadataEnvelope(input = {}) {
  const row = asObject(input);
  const snapshot = normalizeRuntimeTeamSnapshot(row);
  const actionSource = normalizeActionSource(row.action_source || row.actionSource || "");
  const runtimeAuthority = normalizeRuntimeAuthority(row);
  if (!snapshot && !actionSource && !runtimeAuthority) return null;
  return {
    runtime_team_snapshot: snapshot || null,
    runtime_authority: runtimeAuthority || null,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    context_packs: snapshot?.context_packs || [],
    selected_skill_ids: snapshot?.selected_skill_ids || [],
    skill_load_levels: snapshot?.skill_load_levels || {},
    selection_reason_summary: snapshot?.selection_reason_summary || {},
    skill_usage_events: snapshot?.skill_usage_events || [],
    skill_usage_summary: snapshot?.skill_usage_summary || {},
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
    mode: runtimeAuthority?.mode || undefined,
    plan_source: runtimeAuthority?.plan_source || undefined,
    context_source: runtimeAuthority?.context_source || undefined,
    agent_catalog_source: runtimeAuthority?.agent_catalog_source || undefined,
    conversation_team_source: runtimeAuthority?.conversation_team_source || undefined,
    skill_catalog_source: runtimeAuthority?.skill_catalog_source || undefined,
    degraded_mode: runtimeAuthority ? runtimeAuthority.degraded_mode === true : undefined,
    fallback_reason: runtimeAuthority ? runtimeAuthority.fallback_reason : undefined,
    action_source: actionSource || undefined,
  };
}

export function mergeRuntimeMetadataEnvelope(base = null, patch = null) {
  const baseNormalized = normalizeRuntimeMetadataEnvelope(base || {});
  const patchNormalized = normalizeRuntimeMetadataEnvelope(patch || {});
  const snapshot = patchNormalized?.runtime_team_snapshot
    || baseNormalized?.runtime_team_snapshot
    || null;
  const runtimeAuthority = normalizeRuntimeAuthority(
    patchNormalized?.runtime_authority || null,
    {
      fallback: baseNormalized?.runtime_authority || null,
    }
  ) || null;
  const actionSource = normalizeActionSource(
    patchNormalized?.action_source
    || baseNormalized?.action_source
    || ""
  );
  if (!snapshot && !actionSource && !runtimeAuthority) return null;
  return {
    runtime_team_snapshot: snapshot,
    runtime_authority: runtimeAuthority,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    context_packs: snapshot?.context_packs || [],
    selected_skill_ids: snapshot?.selected_skill_ids || [],
    skill_load_levels: snapshot?.skill_load_levels || {},
    selection_reason_summary: snapshot?.selection_reason_summary || {},
    skill_usage_events: snapshot?.skill_usage_events || [],
    skill_usage_summary: snapshot?.skill_usage_summary || {},
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
    mode: runtimeAuthority?.mode || undefined,
    plan_source: runtimeAuthority?.plan_source || undefined,
    context_source: runtimeAuthority?.context_source || undefined,
    agent_catalog_source: runtimeAuthority?.agent_catalog_source || undefined,
    conversation_team_source: runtimeAuthority?.conversation_team_source || undefined,
    skill_catalog_source: runtimeAuthority?.skill_catalog_source || undefined,
    degraded_mode: runtimeAuthority ? runtimeAuthority.degraded_mode === true : undefined,
    fallback_reason: runtimeAuthority ? runtimeAuthority.fallback_reason : undefined,
    action_source: actionSource || undefined,
  };
}

export function buildRuntimeMetadataPatch(metadata = null, {
  includeFlattened = true,
} = {}) {
  const normalized = normalizeRuntimeMetadataEnvelope(metadata || {});
  if (!normalized) return {};
  const snapshot = normalized.runtime_team_snapshot;
  const runtimeAuthority = normalized.runtime_authority;
  const patch = {
    runtime_team_snapshot: snapshot || undefined,
    runtime_authority: runtimeAuthority || undefined,
    action_source: normalized.action_source || undefined,
  };
  if (!includeFlattened) return patch;
  return {
    ...patch,
    team_plan: snapshot?.team_plan || undefined,
    runtime_agents: Array.isArray(snapshot?.runtime_agents) && snapshot.runtime_agents.length > 0
      ? snapshot.runtime_agents
      : undefined,
    context_packs: Array.isArray(snapshot?.context_packs) && snapshot.context_packs.length > 0
      ? snapshot.context_packs
      : undefined,
    selected_skill_ids: Array.isArray(snapshot?.selected_skill_ids) && snapshot.selected_skill_ids.length > 0
      ? snapshot.selected_skill_ids
      : undefined,
    skill_load_levels: snapshot?.skill_load_levels && Object.keys(snapshot.skill_load_levels).length > 0
      ? snapshot.skill_load_levels
      : undefined,
    selection_reason_summary: snapshot?.selection_reason_summary && Object.keys(snapshot.selection_reason_summary).length > 0
      ? snapshot.selection_reason_summary
      : undefined,
    skill_usage_events: Array.isArray(snapshot?.skill_usage_events) && snapshot.skill_usage_events.length > 0
      ? snapshot.skill_usage_events
      : undefined,
    skill_usage_summary: snapshot?.skill_usage_summary && Object.keys(snapshot.skill_usage_summary).length > 0
      ? snapshot.skill_usage_summary
      : undefined,
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
    mode: runtimeAuthority?.mode || undefined,
    plan_source: runtimeAuthority?.plan_source || undefined,
    context_source: runtimeAuthority?.context_source || undefined,
    agent_catalog_source: runtimeAuthority?.agent_catalog_source || undefined,
    conversation_team_source: runtimeAuthority?.conversation_team_source || undefined,
    skill_catalog_source: runtimeAuthority?.skill_catalog_source || undefined,
    degraded_mode: runtimeAuthority ? runtimeAuthority.degraded_mode === true : undefined,
    fallback_reason: runtimeAuthority ? runtimeAuthority.fallback_reason : undefined,
  };
}

export function buildRuntimeRolePayload(runtimeAgent = null) {
  const agent = normalizeRuntimeAgent(runtimeAgent, { defaultStatus: "" });
  if (!agent.instance_id && !agent.template_id && !agent.role_label) return {};
  const rolePayload = {
    role_label: agent.role_label || undefined,
    runtime_instance_id: agent.instance_id || undefined,
    template_id: agent.template_id || undefined,
    run_id: agent.run_id || undefined,
    provider: agent.provider || undefined,
    model: agent.model || undefined,
    capability_tags: Array.isArray(agent.capability_tags) ? agent.capability_tags : [],
    attached_skills: agent.attached_skills || [],
    selected_skill_ids: normalizeSkillAttachmentList(agent.attached_skills || []).map((row) => row.skill_id),
    skill_load_levels: summarizeSkillLoadLevels(agent.attached_skills || []),
    context_pack_id: agent.context_pack_id || undefined,
    provider_binding: agent.provider_binding || undefined,
    execution_budget: agent.execution_budget || undefined,
    runtime_status: agent.status || undefined,
    ephemeral: agent.ephemeral === true,
    fallback: agent.fallback === true,
  };
  return {
    runtime_role: rolePayload,
    ...rolePayload,
  };
}

export function resolveRuntimeAgentForAction(action = {}, runtimeSnapshot = null) {
  const snapshot = normalizeRuntimeTeamSnapshot(runtimeSnapshot);
  const agents = Array.isArray(snapshot?.runtime_agents) ? snapshot.runtime_agents : [];
  if (agents.length === 0) return null;

  const actionRow = asObject(action);
  const actionInputs = asObject(actionRow.inputs);
  const runtimeInstanceId = String(
    actionInputs.runtime_instance_id
    || actionInputs.runtimeInstanceId
    || actionRow.runtime_instance_id
    || actionRow.runtimeInstanceId
    || ""
  ).trim();
  const roleLabel = String(
    actionInputs.role_label
    || actionInputs.roleLabel
    || actionRow.role_label
    || actionRow.roleLabel
    || ""
  ).trim().toLowerCase();
  const actionType = String(actionRow.type || "").trim().toLowerCase();
  const actionAgentId = String(
    actionType === "run_agent"
      ? (actionRow.agent_id || actionRow.agent || "")
      : (actionType === "agent_run"
        ? (actionRow.agent || actionRow.agent_id || "")
        : (actionRow.agent_id || actionRow.agent || ""))
  ).trim().toLowerCase();

  if (runtimeInstanceId) {
    const byInstance = agents.find((agent) => String(agent.instance_id || "").trim() === runtimeInstanceId);
    if (byInstance) return byInstance;
  }
  if (roleLabel) {
    const byRole = agents.find((agent) => String(agent.role_label || "").trim().toLowerCase() === roleLabel);
    if (byRole) return byRole;
  }
  if (actionAgentId) {
    const byTemplate = agents.find((agent) => String(agent.template_id || "").trim().toLowerCase() === actionAgentId);
    if (byTemplate) return byTemplate;
    const byRole = agents.find((agent) => String(agent.role_label || "").trim().toLowerCase() === actionAgentId);
    if (byRole) return byRole;
  }
  return null;
}

export function attachRuntimeTeamSnapshot(payload = {}, snapshot = null, {
  key = "runtime_team_snapshot",
} = {}) {
  const row = asObject(payload);
  const next = normalizeRuntimeTeamSnapshot(snapshot);
  return {
    ...row,
    [key]: next,
  };
}
