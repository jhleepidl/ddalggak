function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeTagList(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
    : [];
}

export const ACTION_SOURCE_VALUES = Object.freeze([
  "explicit_route_plan",
  "generated_team_actions",
  "default_fallback_route",
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
    capability_tags: normalizeTagList(row.capability_tags ?? row.capabilityTags),
    lens_spec: row.lens_spec && typeof row.lens_spec === "object"
      ? row.lens_spec
      : (row.lensSpec && typeof row.lensSpec === "object" ? row.lensSpec : undefined),
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

  return {
    team_plan: row.team_plan && typeof row.team_plan === "object"
      ? row.team_plan
      : (row.teamPlan && typeof row.teamPlan === "object" ? row.teamPlan : null),
    runtime_agents: runtimeAgents,
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
  if (!snapshot && !actionSource) return null;
  return {
    runtime_team_snapshot: snapshot || null,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
    action_source: actionSource || undefined,
  };
}

export function mergeRuntimeMetadataEnvelope(base = null, patch = null) {
  const baseNormalized = normalizeRuntimeMetadataEnvelope(base || {});
  const patchNormalized = normalizeRuntimeMetadataEnvelope(patch || {});
  const snapshot = patchNormalized?.runtime_team_snapshot
    || baseNormalized?.runtime_team_snapshot
    || null;
  const actionSource = normalizeActionSource(
    patchNormalized?.action_source
    || baseNormalized?.action_source
    || ""
  );
  if (!snapshot && !actionSource) return null;
  return {
    runtime_team_snapshot: snapshot,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
    action_source: actionSource || undefined,
  };
}

export function buildRuntimeMetadataPatch(metadata = null, {
  includeFlattened = true,
} = {}) {
  const normalized = normalizeRuntimeMetadataEnvelope(metadata || {});
  if (!normalized) return {};
  const snapshot = normalized.runtime_team_snapshot;
  const patch = {
    runtime_team_snapshot: snapshot || undefined,
    action_source: normalized.action_source || undefined,
  };
  if (!includeFlattened) return patch;
  return {
    ...patch,
    team_plan: snapshot?.team_plan || undefined,
    runtime_agents: Array.isArray(snapshot?.runtime_agents) && snapshot.runtime_agents.length > 0
      ? snapshot.runtime_agents
      : undefined,
    generated_at: snapshot?.generated_at || undefined,
    source: snapshot?.source || undefined,
  };
}

export function buildRuntimeRolePayload(runtimeAgent = null) {
  const agent = normalizeRuntimeAgent(runtimeAgent, { defaultStatus: "" });
  if (!agent.instance_id && !agent.template_id && !agent.role_label) return {};
  const rolePayload = {
    role_label: agent.role_label || undefined,
    runtime_instance_id: agent.instance_id || undefined,
    template_id: agent.template_id || undefined,
    provider: agent.provider || undefined,
    model: agent.model || undefined,
    capability_tags: Array.isArray(agent.capability_tags) ? agent.capability_tags : [],
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
