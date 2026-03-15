import {
  buildRuntimeMetadataPatch,
  normalizeRuntimeAuthority,
  resolveRuntimeAgentForAction,
} from "./runtime_metadata.js";
import { AuthorityRegistry } from "../catalog/authority_registry.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(raw = "", { lower = false } = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function pickAuthorityFields(value = {}) {
  const row = asObject(value);
  const nested = row.runtimeAuthority ?? row.runtime_authority;
  if (nested && typeof nested === "object") return pickAuthorityFields(nested);

  const out = {};
  const modeRaw = String(row.mode || "").trim().toLowerCase();
  if (modeRaw === "goc" || modeRaw === "standalone" || modeRaw === "local") {
    out.mode = row.mode;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "plan_source")
    || Object.prototype.hasOwnProperty.call(row, "planSource")
  ) {
    out.plan_source = row.plan_source ?? row.planSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "context_source")
    || Object.prototype.hasOwnProperty.call(row, "contextSource")
  ) {
    out.context_source = row.context_source ?? row.contextSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "agent_catalog_source")
    || Object.prototype.hasOwnProperty.call(row, "agentCatalogSource")
  ) {
    out.agent_catalog_source = row.agent_catalog_source ?? row.agentCatalogSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "conversation_team_source")
    || Object.prototype.hasOwnProperty.call(row, "conversationTeamSource")
  ) {
    out.conversation_team_source = row.conversation_team_source ?? row.conversationTeamSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "skill_catalog_source")
    || Object.prototype.hasOwnProperty.call(row, "skillCatalogSource")
  ) {
    out.skill_catalog_source = row.skill_catalog_source ?? row.skillCatalogSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "degraded_mode")
    || Object.prototype.hasOwnProperty.call(row, "degradedMode")
  ) {
    out.degraded_mode = row.degraded_mode ?? row.degradedMode;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "fallback_reason")
    || Object.prototype.hasOwnProperty.call(row, "fallbackReason")
  ) {
    out.fallback_reason = row.fallback_reason ?? row.fallbackReason;
  }
  return out;
}

export const RUN_AUTHORITY_CONTRACT_FIELDS = Object.freeze([
  "mode",
  "plan_source",
  "context_source",
  "agent_catalog_source",
  "conversation_team_source",
  "skill_catalog_source",
  "degraded_mode",
  "fallback_reason",
]);

export const RUN_AUTHORITY_DEFAULTS = Object.freeze({
  standalone: Object.freeze({
    mode: "standalone",
    plan_source: "local",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: false,
    fallback_reason: null,
  }),
  goc: Object.freeze({
    mode: "goc",
    plan_source: "local",
    context_source: "goc",
    agent_catalog_source: "goc",
    conversation_team_source: "goc",
    skill_catalog_source: "mixed",
    degraded_mode: false,
    fallback_reason: null,
  }),
  local_fallback: Object.freeze({
    mode: "standalone",
    plan_source: "local_fallback",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: true,
    fallback_reason: null,
  }),
});

function pickAuthorityDefaults(input = null) {
  const normalized = normalizeRuntimeAuthority(pickAuthorityFields(input));
  if (normalized?.plan_source === "local_fallback" || normalized?.degraded_mode === true) {
    return RUN_AUTHORITY_DEFAULTS.local_fallback;
  }
  if (normalized?.mode === "goc") return RUN_AUTHORITY_DEFAULTS.goc;
  return RUN_AUTHORITY_DEFAULTS.standalone;
}

function buildAuthorityEnvelope(authority = null, {
  includeRuntimeMode = false,
  includeFlattenedMode = true,
  ...options
} = {}) {
  if (!authority) return {};
  const patch = buildRuntimeMetadataPatch({ runtime_authority: authority }, options);
  if (!includeFlattenedMode) delete patch.mode;
  return {
    ...patch,
    ...(includeRuntimeMode ? { runtime_mode: authority.mode } : {}),
  };
}

export function normalizeRunAuthority(authority = null, { fallback = null } = {}) {
  return normalizeRuntimeAuthority(authority, { fallback });
}

export function createRunAuthorityContract(authority = null, { fallback = null } = {}) {
  const candidate = pickAuthorityFields(authority);
  const base = fallback || pickAuthorityDefaults(candidate);
  return normalizeRunAuthority(candidate, { fallback: base });
}

export function mergeRunAuthority(baseAuthority = null, overrides = null) {
  const base = createRunAuthorityContract(baseAuthority);
  const merged = {
    ...(base || {}),
    ...pickAuthorityFields(overrides),
  };
  return normalizeRunAuthority(merged, { fallback: base || pickAuthorityDefaults(merged) });
}

export function buildRunAuthority(runtime = null, overrides = {}) {
  const row = asObject(runtime);
  return mergeRunAuthority(
    row.runtimeAuthority || row.runtime_authority || row,
    overrides
  );
}

export function buildRunAuthorityPatch(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return {};
  return buildRuntimeMetadataPatch(
    { runtime_authority: authority },
    options
  );
}

export function buildRunAuthorityEnvelope(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return {};
  return {
    ...buildAuthorityEnvelope(authority, {
      includeFlattenedMode: false,
      ...options,
    }),
    runtimeAuthority: authority,
  };
}

export function summarizeRunAuthorityLines(runtime = null, overrides = {}, {
  prefix = "- ",
  includeMode = true,
  modeLabel = "mode",
  includeFallbackReason = true,
  fallbackReasonEmpty = "",
} = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return [];

  const lines = [];
  if (includeMode) lines.push(`${prefix}${modeLabel}: ${authority.mode}`);
  lines.push(`${prefix}plan_source: ${authority.plan_source}`);
  lines.push(`${prefix}context_source: ${authority.context_source}`);
  lines.push(`${prefix}agent_catalog_source: ${authority.agent_catalog_source}`);
  lines.push(`${prefix}conversation_team_source: ${authority.conversation_team_source}`);
  lines.push(`${prefix}skill_catalog_source: ${authority.skill_catalog_source}`);
  lines.push(`${prefix}degraded_mode: ${authority.degraded_mode ? "true" : "false"}`);
  if (includeFallbackReason) {
    const value = authority.fallback_reason || fallbackReasonEmpty;
    if (value) lines.push(`${prefix}fallback_reason: ${value}`);
  }
  return lines;
}

export function applyRunAuthority(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return null;
  if (runtime && typeof runtime === "object") {
    Object.assign(runtime, buildRunAuthorityEnvelope(
      { runtime_authority: authority },
      {},
      options
    ));
  }
  return authority;
}

function resolveRuntimeSnapshot(runtime = null) {
  const row = asObject(runtime);
  const nested = row.runtime_team_snapshot ?? row.runtimeTeamSnapshot;
  return nested && typeof nested === "object" ? nested : row;
}

function resolveAuthorityEntryForActor({
  action = {},
  runtimeSnapshot = null,
} = {}) {
  const snapshot = resolveRuntimeSnapshot(runtimeSnapshot);
  const authorityGraph = asArray(snapshot?.authority_graph);
  const supervisorRuntime = snapshot?.supervisor_runtime && typeof snapshot.supervisor_runtime === "object"
    ? snapshot.supervisor_runtime
    : null;
  const type = normalizeText(action?.type, { lower: true });
  const registry = new AuthorityRegistry();
  const runtimeAgent = resolveRuntimeAgentForAction(action, snapshot);

  if (["spawn_parallel", "spawn_agents", "checkpoint", "pause_children", "cancel_child", "reroute_child", "supervisor_decision"].includes(type)) {
    const supervisorInstanceId = normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId);
    const existing = authorityGraph.find((entry) => normalizeText(entry?.instance_id || entry?.instanceId) === supervisorInstanceId)
      || authorityGraph.find((entry) => normalizeText(entry?.role_id || entry?.roleId, { lower: true }) === "supervisor_runtime")
      || null;
    const authorityProfileId = normalizeText(
      existing?.authority_profile_id || existing?.authorityProfileId || supervisorRuntime?.authority_profile_id || "supervisor_controlled",
      { lower: true }
    ) || "supervisor_controlled";
    const profile = registry.resolve(authorityProfileId);
    return {
      actor_kind: "supervisor_runtime",
      actor_instance_id: supervisorInstanceId || undefined,
      role_id: "supervisor_runtime",
      authority_profile_id: authorityProfileId,
      allowed_actions: asArray(existing?.allowed_actions ?? existing?.allowedActions ?? profile?.allowed_actions),
      denied_actions: asArray(existing?.denied_actions ?? existing?.deniedActions ?? profile?.denied_actions),
      approval_required_for: asArray(existing?.approval_required_for ?? existing?.approvalRequiredFor ?? profile?.approval_required_for),
      tool_allowlist: asArray(existing?.tool_allowlist ?? existing?.toolAllowlist ?? profile?.tool_allowlist),
      max_parallel_children: Number.isFinite(Number(
        existing?.max_parallel_children ?? existing?.maxParallelChildren ?? profile?.max_parallel_children
      ))
        ? Math.max(0, Math.floor(Number(
          existing?.max_parallel_children ?? existing?.maxParallelChildren ?? profile?.max_parallel_children
        )))
        : 0,
      actor_present: !!(supervisorRuntime || existing),
      runtime_agent: null,
    };
  }

  if (runtimeAgent) {
    const existing = authorityGraph.find((entry) =>
      normalizeText(entry?.instance_id || entry?.instanceId) === normalizeText(runtimeAgent.instance_id || runtimeAgent.instanceId)
    ) || authorityGraph.find((entry) =>
      normalizeText(entry?.slot_id || entry?.slotId) === normalizeText(runtimeAgent.slot_id || runtimeAgent.slotId)
    ) || authorityGraph.find((entry) =>
      normalizeText(entry?.role_id || entry?.roleId, { lower: true }) === normalizeText(runtimeAgent.role_id || runtimeAgent.role_label, { lower: true })
    ) || null;
    const authorityProfileId = normalizeText(
      existing?.authority_profile_id || existing?.authorityProfileId || runtimeAgent?.authority_profile_id || "worker_publish_guarded",
      { lower: true }
    ) || "worker_publish_guarded";
    const profile = registry.resolve(authorityProfileId);
    return {
      actor_kind: "runtime_agent",
      actor_instance_id: normalizeText(runtimeAgent.instance_id || runtimeAgent.instanceId) || undefined,
      role_id: normalizeText(runtimeAgent.role_id || runtimeAgent.role_label, { lower: true }) || undefined,
      authority_profile_id: authorityProfileId,
      allowed_actions: asArray(existing?.allowed_actions ?? existing?.allowedActions ?? profile?.allowed_actions),
      denied_actions: asArray(existing?.denied_actions ?? existing?.deniedActions ?? profile?.denied_actions),
      approval_required_for: asArray(existing?.approval_required_for ?? existing?.approvalRequiredFor ?? profile?.approval_required_for),
      tool_allowlist: asArray(existing?.tool_allowlist ?? existing?.toolAllowlist ?? profile?.tool_allowlist),
      max_parallel_children: Number.isFinite(Number(
        existing?.max_parallel_children ?? existing?.maxParallelChildren ?? profile?.max_parallel_children
      ))
        ? Math.max(0, Math.floor(Number(
          existing?.max_parallel_children ?? existing?.maxParallelChildren ?? profile?.max_parallel_children
        )))
        : 0,
      actor_present: true,
      runtime_agent: runtimeAgent,
    };
  }

  return null;
}

function describeActionAuthority(action = {}, runtimeAgent = null) {
  const type = normalizeText(action?.type, { lower: true });
  const roleId = normalizeText(
    runtimeAgent?.role_id
    || runtimeAgent?.role_label
    || action?.inputs?.role_id
    || action?.inputs?.role_label
    || action?.agent
    || action?.agent_id,
    { lower: true }
  );

  if (type === "git_summary") {
    return {
      action_tags: ["read"],
      approval_tags: [],
      tools: ["read_only_fs"],
      supervisor_only: false,
    };
  }

  if (["spawn_parallel", "spawn_agents"].includes(type)) {
    return {
      action_tags: ["coordinate", "assign"],
      approval_tags: ["spawn_worker"],
      tools: ["control_plane"],
      supervisor_only: true,
      child_count: asArray(action?.agents).length,
    };
  }

  if (["checkpoint", "pause_children", "cancel_child", "reroute_child", "supervisor_decision"].includes(type)) {
    return {
      action_tags: ["coordinate"],
      approval_tags: [type],
      tools: ["control_plane"],
      supervisor_only: true,
    };
  }

  if (type === "publish_agent") {
    return {
      action_tags: ["publish"],
      approval_tags: ["publish"],
      tools: ["control_plane"],
      supervisor_only: true,
    };
  }

  if (type === "commit_request") {
    return {
      action_tags: ["commit"],
      approval_tags: ["commit"],
      tools: ["workspace_fs"],
      supervisor_only: false,
    };
  }

  if (type === "synthesize_final" || roleId === "synthesizer") {
    return {
      action_tags: ["read", "summarize", "draft"],
      approval_tags: [],
      tools: ["read_only_fs"],
      supervisor_only: false,
    };
  }

  if (roleId === "researcher") {
    return {
      action_tags: ["read", "search", "analyze", "cite"],
      approval_tags: [],
      tools: ["web", "read_only_fs"],
      supervisor_only: false,
    };
  }
  if (roleId === "reviewer") {
    return {
      action_tags: ["read", "search", "review", "comment", "cite"],
      approval_tags: [],
      tools: ["web", "read_only_fs"],
      supervisor_only: false,
    };
  }
  if (roleId === "operator") {
    return {
      action_tags: ["read", "coordinate", "assign", "draft"],
      approval_tags: ["spawn_worker"],
      tools: ["control_plane", "read_only_fs"],
      supervisor_only: false,
    };
  }
  if (roleId === "builder") {
    return {
      action_tags: ["read", "write", "execute", "draft"],
      approval_tags: ["workspace_write", "tool_execute"],
      tools: ["workspace_fs", "shell"],
      supervisor_only: false,
    };
  }
  return {
    action_tags: ["read"],
    approval_tags: [],
    tools: ["read_only_fs"],
    supervisor_only: false,
  };
}

export function evaluateActionAuthority({
  action = {},
  runtimeSnapshot = null,
} = {}) {
  const snapshot = resolveRuntimeSnapshot(runtimeSnapshot);
  const actor = resolveAuthorityEntryForActor({
    action,
    runtimeSnapshot: snapshot,
  });
  if (!actor) {
    return {
      enforced: false,
      allowed: true,
      execute_allowed: true,
      requires_approval: false,
      reasons: [],
      actor_instance_id: undefined,
      role_id: undefined,
      authority_profile_id: undefined,
      denied_by: [],
      tool_rejections: [],
      required_approval_for: [],
    };
  }

  const descriptor = describeActionAuthority(action, actor.runtime_agent);
  const allowedActions = new Set(asArray(actor.allowed_actions).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  const deniedActions = new Set(asArray(actor.denied_actions).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  const approvalRequiredFor = new Set(asArray(actor.approval_required_for).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  const toolAllowlist = new Set(asArray(actor.tool_allowlist).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  const deniedBy = [];
  const reasons = [];
  const toolRejections = [];
  const requiredApprovalFor = [];

  if (descriptor.supervisor_only && actor.role_id !== "supervisor_runtime") {
    deniedBy.push("supervisor_only_control_action");
    reasons.push("supervisor-only control action cannot be executed by a worker");
  }
  if (descriptor.supervisor_only && actor.actor_present !== true) {
    deniedBy.push("missing_supervisor_runtime");
    reasons.push("supervisor-only control action requires an enabled supervisor runtime");
  }

  for (const actionTag of descriptor.action_tags) {
    if (deniedActions.has(actionTag)) {
      deniedBy.push(`denied_action:${actionTag}`);
      reasons.push(`authority profile denies action=${actionTag}`);
      continue;
    }
    if (allowedActions.size > 0 && !allowedActions.has(actionTag)) {
      deniedBy.push(`not_allowed:${actionTag}`);
      reasons.push(`authority profile does not allow action=${actionTag}`);
    }
  }

  for (const toolId of descriptor.tools) {
    if (toolAllowlist.size > 0 && !toolAllowlist.has(toolId)) {
      toolRejections.push(toolId);
      reasons.push(`tool ${toolId} is not in the authority allowlist`);
    }
  }

  if (descriptor.child_count > 0 && actor.max_parallel_children >= 0 && descriptor.child_count > actor.max_parallel_children) {
    deniedBy.push(`parallel_limit_exceeded:${descriptor.child_count}`);
    reasons.push(`spawn request exceeds max_parallel_children=${actor.max_parallel_children}`);
  }

  for (const approvalTag of descriptor.approval_tags) {
    if (approvalRequiredFor.has(approvalTag)) {
      requiredApprovalFor.push(approvalTag);
      reasons.push(`approval required for ${approvalTag}`);
    }
  }

  const blocked = deniedBy.length > 0 || toolRejections.length > 0;
  const requiresApproval = !blocked && requiredApprovalFor.length > 0;

  return {
    enforced: true,
    allowed: !blocked,
    execute_allowed: !blocked && !requiresApproval,
    requires_approval: requiresApproval,
    reasons,
    actor_instance_id: actor.actor_instance_id,
    role_id: actor.role_id,
    authority_profile_id: actor.authority_profile_id,
    denied_by: deniedBy,
    tool_rejections: toolRejections,
    required_approval_for: requiredApprovalFor,
  };
}

export function createAuthorityDeniedError(evaluation = {}, {
  fallbackMessage = "authority denied",
} = {}) {
  const message = asArray(evaluation?.reasons).filter(Boolean).join("; ") || fallbackMessage;
  const error = new Error(message);
  error.code = evaluation?.requires_approval ? "AUTHORITY_APPROVAL_REQUIRED" : "AUTHORITY_DENIED";
  error.authority = evaluation;
  error.requiresApproval = evaluation?.requires_approval === true;
  error.deniedBy = asArray(evaluation?.denied_by);
  return error;
}
