import { normalizeSkillAttachmentList, summarizeSkillLoadLevels } from "../domain/skill_attachment.js";
import { normalizeContextPackList } from "../domain/context_pack.js";
import { normalizeScopeSpecList } from "../domain/scope_spec.js";
import { normalizeMaterializedScopeList } from "../domain/materialized_scope.js";
import { normalizeVisibilityGraph } from "../domain/visibility_graph.js";
import { deriveScopeGrantRecords } from "../domain/scope_grant.js";
import { normalizeRuntimeAgentInstance } from "../domain/runtime_agent.js";
import { normalizeTaskInterpretation } from "../domain/task_interpretation.js";
import { normalizeCollaborationCellList } from "../domain/collaboration_cell.js";
import { normalizeExecutionCheckpointList } from "../domain/execution_checkpoint.js";
import { normalizeTeamPlan } from "../domain/team_plan.js";
import { normalizeContextRuntimeMode, summarizeLegacyContextState } from "../domain/context_runtime.js";
import { normalizeSkillUsageEvent, summarizeSkillUsageEvents } from "./skill_feedback.js";
import { AuthorityRegistry } from "../catalog/authority_registry.js";
import { normalizeTeamStructureV2 } from '../shared/team_structure_v2.js';

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

function omitUndefinedFields(value = {}) {
  return Object.fromEntries(
    Object.entries(asObject(value)).filter(([, entry]) => entry !== undefined)
  );
}

function normalizeSelectionExplanations(value = []) {
  const rows = Array.isArray(value) ? value : [];
  const out = [];
  for (const row of rows) {
    if (typeof row === "string") {
      const reason = String(row || "").trim();
      if (!reason) continue;
      out.push({ subject_id: "team_plan", reason });
      continue;
    }
    const entry = asObject(row);
    const reason = String(entry.reason || entry.selection_reason || entry.selectionReason || "").trim();
    if (!reason) continue;
    out.push({
      subject_id: String(entry.subject_id || entry.subjectId || "team_plan").trim() || "team_plan",
      reason,
    });
  }
  return out.slice(0, 64);
}

function normalizeExecutionGraphValue(value, { teamPlan = null } = {}) {
  const row = asObject(value);
  if (Object.keys(row).length > 0) return row;
  return teamPlan?.execution_graph && typeof teamPlan.execution_graph === "object"
    ? teamPlan.execution_graph
    : {};
}

function normalizeAuthorityGraphValue(value = [], { teamPlan = null, runtimeAgents = [], supervisorRuntime = null } = {}) {
  const rows = Array.isArray(value)
    ? value
    : (Array.isArray(teamPlan?.authority_graph) ? teamPlan.authority_graph : []);
  const registry = new AuthorityRegistry();
  const normalized = [];
  for (const raw of rows) {
    const row = asObject(raw);
    const authorityProfileId = String(
      row.authority_profile_id || row.authorityProfileId || ""
    ).trim().toLowerCase();
    const slotId = String(row.slot_id || row.slotId || "").trim();
    const instanceId = String(
      row.instance_id || row.instanceId || ""
    ).trim() || undefined;
    const roleId = String(row.role_id || row.roleId || "").trim().toLowerCase() || undefined;
    if (!authorityProfileId && !slotId && !instanceId && !roleId) continue;
    const profile = registry.resolve(authorityProfileId);
    normalized.push({
      slot_id: slotId || undefined,
      instance_id: instanceId,
      role_id: roleId,
      authority_profile_id: authorityProfileId || undefined,
      allowed_actions: normalizeStringList(
        row.allowed_actions ?? row.allowedActions ?? profile?.allowed_actions ?? [],
        { lower: true }
      ),
      denied_actions: normalizeStringList(
        row.denied_actions ?? row.deniedActions ?? profile?.denied_actions ?? [],
        { lower: true }
      ),
      approval_required_for: normalizeStringList(
        row.approval_required_for ?? row.approvalRequiredFor ?? profile?.approval_required_for ?? [],
        { lower: true }
      ),
      tool_allowlist: normalizeStringList(
        row.tool_allowlist ?? row.toolAllowlist ?? profile?.tool_allowlist ?? [],
        { lower: true }
      ),
      max_parallel_children: Number.isFinite(Number(
        row.max_parallel_children ?? row.maxParallelChildren ?? profile?.max_parallel_children
      ))
        ? Math.max(0, Math.min(16, Math.floor(Number(
          row.max_parallel_children ?? row.maxParallelChildren ?? profile?.max_parallel_children
        ))))
        : 0,
    });
  }
  if (supervisorRuntime?.enabled === true && !normalized.some((entry) => String(entry.instance_id || "").trim() === String(supervisorRuntime.instance_id || "").trim())) {
    const profile = registry.resolve(supervisorRuntime.authority_profile_id);
    normalized.push({
      instance_id: String(supervisorRuntime.instance_id || "").trim() || undefined,
      role_id: "supervisor_runtime",
      authority_profile_id: String(supervisorRuntime.authority_profile_id || "").trim().toLowerCase() || undefined,
      allowed_actions: normalizeStringList(profile?.allowed_actions ?? [], { lower: true }),
      denied_actions: normalizeStringList(profile?.denied_actions ?? [], { lower: true }),
      approval_required_for: normalizeStringList(profile?.approval_required_for ?? [], { lower: true }),
      tool_allowlist: normalizeStringList(profile?.tool_allowlist ?? [], { lower: true }),
      max_parallel_children: Number.isFinite(Number(profile?.max_parallel_children))
        ? Math.max(0, Math.min(16, Math.floor(Number(profile.max_parallel_children))))
        : 0,
    });
  }
  if (normalized.length > 0) return normalized;
  return runtimeAgents
    .map((agent) => {
      const authorityProfileId = String(agent?.authority_profile_id || "").trim().toLowerCase();
      if (!authorityProfileId) return null;
      const profile = registry.resolve(authorityProfileId);
      return {
        slot_id: String(agent?.slot_id || "").trim() || undefined,
        instance_id: String(agent?.instance_id || "").trim() || undefined,
        role_id: String(agent?.role_id || agent?.role_label || "").trim().toLowerCase() || undefined,
        authority_profile_id: authorityProfileId,
        allowed_actions: normalizeStringList(profile?.allowed_actions ?? [], { lower: true }),
        denied_actions: normalizeStringList(profile?.denied_actions ?? [], { lower: true }),
        approval_required_for: normalizeStringList(profile?.approval_required_for ?? [], { lower: true }),
        tool_allowlist: normalizeStringList(profile?.tool_allowlist ?? [], { lower: true }),
        max_parallel_children: Number.isFinite(Number(profile?.max_parallel_children))
          ? Math.max(0, Math.min(16, Math.floor(Number(profile.max_parallel_children))))
          : 0,
      };
    })
    .filter(Boolean);
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
  return normalizeRuntimeAgentInstance({
    ...(agent && typeof agent === "object" ? agent : {}),
    status: agent?.status ?? agent?.runtime_status ?? agent?.runtimeStatus ?? defaultStatus,
  }, {
    defaultSelectionReason: "",
  });
}

function hasSnapshotFields(row = {}) {
  return !!(
    row.team_plan
    || row.teamPlan
    || row.task_interpretation
    || row.taskInterpretation
    || Array.isArray(row.runtime_agents)
    || Array.isArray(row.runtimeAgents)
    || Array.isArray(row.context_packs)
    || Array.isArray(row.contextPacks)
    || Array.isArray(row.scope_specs)
    || Array.isArray(row.scopeSpecs)
    || Array.isArray(row.materialized_scopes)
    || Array.isArray(row.materializedScopes)
    || Array.isArray(row.visibility_graph)
    || Array.isArray(row.visibilityGraph)
    || row.context_runtime_mode
    || row.contextRuntimeMode
    || row.legacy_context_pack_count
    || row.legacyContextPackCount
    || row.legacy_context_packs_enabled
    || row.legacyContextPacksEnabled
    || Array.isArray(row.collaboration_cells)
    || Array.isArray(row.collaborationCells)
    || Array.isArray(row.authority_graph)
    || Array.isArray(row.authorityGraph)
    || Array.isArray(row.checkpoints)
    || Array.isArray(row.selection_explanations)
    || Array.isArray(row.selectionExplanations)
    || row.execution_graph
    || row.executionGraph
    || row.runtime_authority
    || row.runtimeAuthority
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
    || row.structure_v2
    || row.structureV2
    || Array.isArray(row.runtime_participants)
    || Array.isArray(row.runtimeParticipants)
    || row.topology_pattern
    || row.topologyPattern
    || Array.isArray(row.non_executable_participants)
    || Array.isArray(row.nonExecutableParticipants)
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
  const structureV2 = (() => {
    const rawStructure = row.structure_v2 ?? row.structureV2 ?? null;
    return rawStructure && typeof rawStructure === 'object' ? normalizeTeamStructureV2(rawStructure) : null;
  })();
  const runtimeParticipants = (Array.isArray(row.runtime_participants) ? row.runtime_participants : (Array.isArray(row.runtimeParticipants) ? row.runtimeParticipants : (Array.isArray(structureV2?.participants) ? structureV2.participants : [])))
    .map((entry) => {
      const item = asObject(entry);
      const participantId = String(item.participant_id || item.participantId || item.id || '').trim().toLowerCase();
      if (!participantId) return null;
      return omitUndefinedFields({
        participant_id: participantId,
        kind: String(item.kind || 'agent').trim().toLowerCase() || 'agent',
        executable: item.executable === true,
        name: String(item.name || item.label || '').trim() || undefined,
        role: String(item.role || '').trim().toLowerCase() || undefined,
        model: String(item.model || '').trim() || undefined,
      });
    })
    .filter(Boolean);
  const nonExecutableParticipants = (Array.isArray(row.non_executable_participants) ? row.non_executable_participants : (Array.isArray(row.nonExecutableParticipants) ? row.nonExecutableParticipants : []))
    .map((entry) => omitUndefinedFields({
      participant_id: String(entry?.participant_id || entry?.participantId || entry?.id || '').trim().toLowerCase() || undefined,
      kind: String(entry?.kind || '').trim().toLowerCase() || undefined,
      name: String(entry?.name || entry?.label || '').trim() || undefined,
    }))
    .filter((entry) => entry.participant_id || entry.kind || entry.name);
  const topologyPattern = String(row.topology_pattern || row.topologyPattern || structureV2?.topology?.pattern || '').trim().toLowerCase() || undefined;
  const teamPlan = (() => {
    const rawPlan = row.team_plan && typeof row.team_plan === "object"
      ? row.team_plan
      : (row.teamPlan && typeof row.teamPlan === "object" ? row.teamPlan : null);
    return rawPlan ? normalizeTeamPlan(rawPlan) : null;
  })();
  const taskInterpretation = normalizeTaskInterpretation(
    row.task_interpretation
    ?? row.taskInterpretation
    ?? teamPlan?.task_interpretation
    ?? {}
  );
  const contextPacks = normalizeContextPackList(
    row.context_packs
    ?? row.contextPacks
    ?? []
  );
  const scopeSpecs = normalizeScopeSpecList(
    row.scope_specs
    ?? row.scopeSpecs
    ?? teamPlan?.scope_specs
    ?? []
  );
  const materializedScopes = normalizeMaterializedScopeList(
    row.materialized_scopes
    ?? row.materializedScopes
    ?? teamPlan?.materialized_scopes
    ?? []
  );
  const visibilityGraph = normalizeVisibilityGraph(
    row.visibility_graph
    ?? row.visibilityGraph
    ?? teamPlan?.visibility_graph
    ?? []
  );
  const scopeGrants = deriveScopeGrantRecords(
    row.scope_grants
    ?? row.scopeGrants
    ?? teamPlan?.scope_grants
    ?? scopeSpecs
  );
  const contextRuntimeMode = normalizeContextRuntimeMode(
    row.context_runtime_mode
    ?? row.contextRuntimeMode
    ?? teamPlan?.context_runtime_mode
    ?? (scopeSpecs.length > 0 ? "scoped_context" : "shared_memory"),
    { fallback: scopeSpecs.length > 0 ? "scoped_context" : "shared_memory" }
  );
  const legacyContextState = summarizeLegacyContextState({
    contextRuntimeMode,
    contextPacks,
    scopeSpecs,
    materializedScopes,
  });
  const supervisorRuntime = (
    row.supervisor_runtime && typeof row.supervisor_runtime === "object"
      ? row.supervisor_runtime
      : (row.supervisorRuntime && typeof row.supervisorRuntime === "object" ? row.supervisorRuntime : teamPlan?.supervisor_runtime)
  ) || null;
  const collaborationCells = normalizeCollaborationCellList(
    row.collaboration_cells
    ?? row.collaborationCells
    ?? teamPlan?.collaboration_cells
    ?? []
  );
  const checkpoints = normalizeExecutionCheckpointList(
    row.checkpoints
    ?? teamPlan?.checkpoints
    ?? []
  );
  const selectionExplanations = normalizeSelectionExplanations(
    row.selection_explanations
    ?? row.selectionExplanations
    ?? teamPlan?.selection_explanations
    ?? []
  );
  const runtimeAuthority = normalizeRuntimeAuthority(
    row.runtime_authority
    ?? row.runtimeAuthority
    ?? null
  );
  const executionGraph = normalizeExecutionGraphValue(
    row.execution_graph
    ?? row.executionGraph
    ?? teamPlan?.execution_graph
    ?? {},
    { teamPlan }
  );
  const authorityGraph = normalizeAuthorityGraphValue(
    row.authority_graph
    ?? row.authorityGraph
    ?? teamPlan?.authority_graph
    ?? [],
    { teamPlan, runtimeAgents, supervisorRuntime }
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
    task_interpretation: taskInterpretation,
    team_plan: teamPlan,
    runtime_agents: runtimeAgents,
    context_packs: contextPacks,
    scope_specs: scopeSpecs,
    materialized_scopes: materializedScopes,
    visibility_graph: visibilityGraph,
    scope_grants: scopeGrants,
    context_runtime_mode: contextRuntimeMode,
    legacy_context_pack_count: Number.isFinite(Number(row.legacy_context_pack_count ?? row.legacyContextPackCount ?? teamPlan?.legacy_context_pack_count))
      ? Math.max(0, Math.floor(Number(row.legacy_context_pack_count ?? row.legacyContextPackCount ?? teamPlan?.legacy_context_pack_count)))
      : legacyContextState.legacy_context_pack_count,
    legacy_context_packs_enabled: row.legacy_context_packs_enabled === true
      || row.legacyContextPacksEnabled === true
      || teamPlan?.legacy_context_packs_enabled === true
      || legacyContextState.legacy_context_packs_enabled === true,
    legacy_context_strategy: String(
      row.legacy_context_strategy
      ?? row.legacyContextStrategy
      ?? teamPlan?.legacy_context_strategy
      ?? legacyContextState.legacy_context_strategy
      ?? "disabled"
    ).trim().toLowerCase() || legacyContextState.legacy_context_strategy,
    collaboration_cells: collaborationCells,
    authority_graph: authorityGraph,
    checkpoints,
    execution_graph: executionGraph,
    selection_explanations: selectionExplanations,
    selected_skill_ids: selectedSkillIds,
    skill_load_levels: skillLoadLevels,
    selection_reason_summary: selectionReasonSummary,
    skill_usage_events: skillUsageEvents,
    skill_usage_summary: skillUsageSummary,
    supervisor_runtime: supervisorRuntime,
    runtime_authority: runtimeAuthority,
    structure_v2: structureV2 || undefined,
    runtime_participants: runtimeParticipants,
    topology_pattern: topologyPattern,
    non_executable_participants: nonExecutableParticipants,
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
  scopeSpecs = undefined,
  scope_specs = undefined,
  materializedScopes = undefined,
  materialized_scopes = undefined,
  visibilityGraph = undefined,
  visibility_graph = undefined,
  scopeGrants = undefined,
  scope_grants = undefined,
  contextRuntimeMode = undefined,
  context_runtime_mode = undefined,
  legacyContextPackCount = undefined,
  legacy_context_pack_count = undefined,
  legacyContextPacksEnabled = undefined,
  legacy_context_packs_enabled = undefined,
  legacyContextStrategy = undefined,
  legacy_context_strategy = undefined,
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
  taskInterpretation = undefined,
  task_interpretation = undefined,
  collaborationCells = undefined,
  collaboration_cells = undefined,
  authorityGraph = undefined,
  authority_graph = undefined,
  checkpoints = undefined,
  executionGraph = undefined,
  execution_graph = undefined,
  selectionExplanations = undefined,
  selection_explanations = undefined,
  supervisorRuntime = undefined,
  supervisor_runtime = undefined,
  runtimeAuthority = undefined,
  runtime_authority = undefined,
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
    task_interpretation: task_interpretation ?? taskInterpretation,
    team_plan: team_plan ?? teamPlan,
    runtime_agents: runtime_agents ?? runtimeAgents,
    context_packs: context_packs ?? contextPacks,
    scope_specs: scope_specs ?? scopeSpecs,
    materialized_scopes: materialized_scopes ?? materializedScopes,
    visibility_graph: visibility_graph ?? visibilityGraph,
    scope_grants: scope_grants ?? scopeGrants,
    context_runtime_mode: context_runtime_mode ?? contextRuntimeMode,
    legacy_context_pack_count: legacy_context_pack_count ?? legacyContextPackCount,
    legacy_context_packs_enabled: legacy_context_packs_enabled ?? legacyContextPacksEnabled,
    legacy_context_strategy: legacy_context_strategy ?? legacyContextStrategy,
    collaboration_cells: collaboration_cells ?? collaborationCells,
    authority_graph: authority_graph ?? authorityGraph,
    checkpoints,
    execution_graph: execution_graph ?? executionGraph,
    selection_explanations: selection_explanations ?? selectionExplanations,
    selected_skill_ids: selected_skill_ids ?? selectedSkillIds,
    skill_load_levels: skill_load_levels ?? skillLoadLevels,
    selection_reason_summary: selection_reason_summary ?? selectionReasonSummary,
    skill_usage_events: skill_usage_events ?? skillUsageEvents,
    skill_usage_summary: skill_usage_summary ?? skillUsageSummary,
    supervisor_runtime: supervisor_runtime ?? supervisorRuntime,
    runtime_authority: runtime_authority ?? runtimeAuthority,
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
  const runtimeAuthority = normalizeRuntimeAuthority(
    row,
    { fallback: snapshot?.runtime_authority || null }
  ) || snapshot?.runtime_authority || null;
  if (!snapshot && !actionSource && !runtimeAuthority) return null;
  return {
    runtime_team_snapshot: snapshot || null,
    runtime_authority: runtimeAuthority || null,
    task_interpretation: snapshot?.task_interpretation || null,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    context_packs: snapshot?.context_packs || [],
    scope_specs: snapshot?.scope_specs || [],
    materialized_scopes: snapshot?.materialized_scopes || [],
    visibility_graph: snapshot?.visibility_graph || [],
    scope_grants: snapshot?.scope_grants || [],
    context_runtime_mode: snapshot?.context_runtime_mode || undefined,
    legacy_context_pack_count: snapshot?.legacy_context_pack_count ?? undefined,
    legacy_context_packs_enabled: snapshot?.legacy_context_packs_enabled ?? undefined,
    legacy_context_strategy: snapshot?.legacy_context_strategy || undefined,
    collaboration_cells: snapshot?.collaboration_cells || [],
    authority_graph: snapshot?.authority_graph || [],
    checkpoints: snapshot?.checkpoints || [],
    execution_graph: snapshot?.execution_graph || {},
    selection_explanations: snapshot?.selection_explanations || [],
    selected_skill_ids: snapshot?.selected_skill_ids || [],
    skill_load_levels: snapshot?.skill_load_levels || {},
    selection_reason_summary: snapshot?.selection_reason_summary || {},
    skill_usage_events: snapshot?.skill_usage_events || [],
    skill_usage_summary: snapshot?.skill_usage_summary || {},
    supervisor_runtime: snapshot?.supervisor_runtime || undefined,
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
      fallback: patchNormalized?.runtime_team_snapshot?.runtime_authority
        || baseNormalized?.runtime_authority
        || baseNormalized?.runtime_team_snapshot?.runtime_authority
        || null,
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
    task_interpretation: snapshot?.task_interpretation || null,
    team_plan: snapshot?.team_plan || null,
    runtime_agents: snapshot?.runtime_agents || [],
    context_packs: snapshot?.context_packs || [],
    scope_specs: snapshot?.scope_specs || [],
    materialized_scopes: snapshot?.materialized_scopes || [],
    visibility_graph: snapshot?.visibility_graph || [],
    scope_grants: snapshot?.scope_grants || [],
    context_runtime_mode: snapshot?.context_runtime_mode || undefined,
    legacy_context_pack_count: snapshot?.legacy_context_pack_count ?? undefined,
    legacy_context_packs_enabled: snapshot?.legacy_context_packs_enabled ?? undefined,
    legacy_context_strategy: snapshot?.legacy_context_strategy || undefined,
    collaboration_cells: snapshot?.collaboration_cells || [],
    authority_graph: snapshot?.authority_graph || [],
    checkpoints: snapshot?.checkpoints || [],
    execution_graph: snapshot?.execution_graph || {},
    selection_explanations: snapshot?.selection_explanations || [],
    selected_skill_ids: snapshot?.selected_skill_ids || [],
    skill_load_levels: snapshot?.skill_load_levels || {},
    selection_reason_summary: snapshot?.selection_reason_summary || {},
    skill_usage_events: snapshot?.skill_usage_events || [],
    skill_usage_summary: snapshot?.skill_usage_summary || {},
    supervisor_runtime: snapshot?.supervisor_runtime || undefined,
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
    task_interpretation: snapshot?.task_interpretation || undefined,
    team_plan: snapshot?.team_plan || undefined,
    runtime_agents: Array.isArray(snapshot?.runtime_agents) && snapshot.runtime_agents.length > 0
      ? snapshot.runtime_agents
      : undefined,
    context_packs: Array.isArray(snapshot?.context_packs) && snapshot.context_packs.length > 0
      ? snapshot.context_packs
      : undefined,
    scope_specs: Array.isArray(snapshot?.scope_specs) && snapshot.scope_specs.length > 0
      ? snapshot.scope_specs
      : undefined,
    materialized_scopes: Array.isArray(snapshot?.materialized_scopes) && snapshot.materialized_scopes.length > 0
      ? snapshot.materialized_scopes
      : undefined,
    visibility_graph: Array.isArray(snapshot?.visibility_graph) && snapshot.visibility_graph.length > 0
      ? snapshot.visibility_graph
      : undefined,
    context_runtime_mode: snapshot?.context_runtime_mode || undefined,
    legacy_context_pack_count: snapshot?.legacy_context_pack_count ?? undefined,
    legacy_context_packs_enabled: snapshot?.legacy_context_packs_enabled ?? undefined,
    legacy_context_strategy: snapshot?.legacy_context_strategy || undefined,
    collaboration_cells: Array.isArray(snapshot?.collaboration_cells) && snapshot.collaboration_cells.length > 0
      ? snapshot.collaboration_cells
      : undefined,
    authority_graph: Array.isArray(snapshot?.authority_graph) && snapshot.authority_graph.length > 0
      ? snapshot.authority_graph
      : undefined,
    checkpoints: Array.isArray(snapshot?.checkpoints) && snapshot.checkpoints.length > 0
      ? snapshot.checkpoints
      : undefined,
    execution_graph: snapshot?.execution_graph && Object.keys(snapshot.execution_graph).length > 0
      ? snapshot.execution_graph
      : undefined,
    selection_explanations: Array.isArray(snapshot?.selection_explanations) && snapshot.selection_explanations.length > 0
      ? snapshot.selection_explanations
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
    supervisor_runtime: snapshot?.supervisor_runtime || undefined,
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
  const authorityRegistry = new AuthorityRegistry();
  const authorityProfile = authorityRegistry.resolve(agent.authority_profile_id);
  const rolePayload = omitUndefinedFields({
    role_id: agent.role_id || undefined,
    role_label: agent.role_label || undefined,
    display_label: agent.display_label || undefined,
    runtime_instance_id: agent.instance_id || undefined,
    slot_id: agent.slot_id || undefined,
    preset_id: agent.preset_id || undefined,
    template_id: agent.template_id || undefined,
    run_id: agent.run_id || undefined,
    provider: agent.provider || undefined,
    model: agent.model || undefined,
    capability_tags: Array.isArray(agent.capability_tags) ? agent.capability_tags : [],
    attached_skills: agent.attached_skills || [],
    attached_skill_ids: Array.isArray(agent.attached_skill_ids) ? agent.attached_skill_ids : [],
    selected_skill_ids: normalizeSkillAttachmentList(agent.attached_skills || []).map((row) => row.skill_id),
    skill_load_levels: summarizeSkillLoadLevels(agent.attached_skills || []),
    context_pack_id: agent.context_pack_id || undefined,
    scope_id: agent.scope_id || undefined,
    visibility_mode: agent.visibility_mode || undefined,
    memory_grants: agent.memory_grants || undefined,
    authority_profile_id: agent.authority_profile_id || undefined,
    allowed_actions: authorityProfile?.allowed_actions || undefined,
    denied_actions: authorityProfile?.denied_actions || undefined,
    approval_required_for: authorityProfile?.approval_required_for || undefined,
    tool_allowlist: authorityProfile?.tool_allowlist || undefined,
    selection_reason: agent.selection_reason || undefined,
    synthesized: agent.synthesized === true,
    provider_binding: agent.provider_binding || undefined,
    execution_budget: agent.execution_budget || undefined,
    runtime_status: agent.status || undefined,
    ephemeral: agent.ephemeral === true,
    fallback: agent.fallback === true,
  });
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
  const slotId = String(
    actionInputs.slot_id
    || actionInputs.slotId
    || actionRow.slot_id
    || actionRow.slotId
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
  if (slotId) {
    const bySlot = agents.find((agent) => String(agent.slot_id || "").trim() === slotId);
    if (bySlot) return bySlot;
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
