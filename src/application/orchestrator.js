import { buildTeamFromRegistry, rerankResolvedTeamComposition } from "./team_builder.js";
import { normalizeRoutePlan } from "../domain/route_plan.js";
import {
  normalizeTeamPlan,
  reconcileTeamPlanRuntimeBindings,
  validateNormalizedTeamPlan,
} from "../domain/team_plan.js";
import {
  createRuntimeTeamSnapshot,
  attachRuntimeTeamSnapshot,
} from "./runtime_metadata.js";
import {
  normalizeSkillAttachmentList,
  summarizeSkillLoadLevels,
  summarizeSelectedSkillIds,
} from "../domain/skill_attachment.js";
import { SkillRegistry } from "./skill_registry.js";
import { SkillResolver } from "./skill_resolver.js";
import { SkillLoader } from "./skill_loader.js";
import { ScopePlanner } from "../control_plane/scope_planner.js";
import { LegacyContextPackBuilder } from "../control_plane/legacy_context_pack_builder.js";
import { PresetRegistry } from "../catalog/preset_registry.js";
import { PresetResolver } from "../control_plane/preset_resolver.js";
import { interpretTask } from "../control_plane/task_interpreter.js";
import { buildCollaborationCells } from "../control_plane/collaboration_policy.js";
import { buildExecutionCheckpoints } from "../control_plane/checkpoint_policy.js";
import {
  coordinateExecutionPlan,
  createDefaultRunRoute as createDefaultRunRouteV2,
  deriveParallelGroupsFromRouteActions,
  mapTeamPlanToRouteActions as mapTeamPlanToRouteActionsV2,
  shouldUseGeneratedTeamActions as shouldUseGeneratedTeamActionsV2,
} from "../control_plane/execution_coordinator.js";
import {
  createSkillUsageEvent,
  recordSkillUsageEvent,
  summarizeSkillUsageEvents,
} from "./skill_feedback.js";

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeStringList(raw = [], {
  lower = true,
  max = 64,
} = {}) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? raw.split(",") : []);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const text = normalizeText(entry);
    if (!text) continue;
    const value = lower ? text.toLowerCase() : text;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function collectContextHints(goal = "", route = {}) {
  const hints = [goal, String(route?.reason || "").trim()];
  for (const action of asArray(route?.actions)) {
    const type = normalizeText(action?.type, { lower: true });
    if (type !== "agent_run") continue;
    hints.push(String(action?.prompt || action?.goal || "").trim());
  }
  return hints.filter(Boolean);
}

function collectAvailableToolIds({
  registry = null,
  availableToolIds = [],
  toolHints = [],
} = {}) {
  const collected = [];
  for (const toolId of availableToolIds) collected.push(toolId);
  for (const toolId of toolHints) collected.push(toolId);
  for (const agent of asArray(registry?.agents)) {
    for (const toolId of asArray(agent?.tools || agent?.tool_ids || agent?.toolIds)) {
      collected.push(toolId);
    }
  }
  for (const template of asArray(registry?.templates)) {
    for (const toolId of asArray(template?.tools || template?.tool_ids || template?.toolIds)) {
      collected.push(toolId);
    }
  }
  return normalizeStringList(collected, { max: 64, lower: true });
}

function applyResolvedSkills({
  teamPlan = null,
  runtimeAgents = [],
  resolution = {},
} = {}) {
  const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
  const slotSkillMap = resolution?.slot_skill_map && typeof resolution.slot_skill_map === "object"
    ? resolution.slot_skill_map
    : {};
  const runtimeAgentSkillMap = resolution?.runtime_agent_skill_map && typeof resolution.runtime_agent_skill_map === "object"
    ? resolution.runtime_agent_skill_map
    : {};
  const roleSkillMap = resolution?.role_skill_map && typeof resolution.role_skill_map === "object"
    ? resolution.role_skill_map
    : {};

  const runtimeAgentsOut = asArray(runtimeAgents).map((agent) => {
    const slotKey = normalizeText(agent?.slot_id || agent?.slotId);
    const instanceKey = normalizeText(agent?.instance_id || agent?.instanceId);
    const roleKey = normalizeText(agent?.role_id || agent?.role_label, { lower: true });
    const attachments = normalizeSkillAttachmentList(
      runtimeAgentSkillMap[instanceKey]
      || slotSkillMap[slotKey]
      || roleSkillMap[roleKey]
      || agent?.attached_skills
      || []
    );
    return {
      ...agent,
      attached_skills: attachments,
      attached_skill_ids: summarizeSelectedSkillIds(attachments),
    };
  });

  const slotsOut = asArray(plan.slots).map((slot) => {
    const slotKey = normalizeText(slot?.slot_id || slot?.slotId);
    const roleKey = normalizeText(slot?.role_id || slot?.role_label, { lower: true });
    const runtimeAgent = runtimeAgentsOut.find((agent) => normalizeText(agent?.slot_id) === slotKey);
    const attachments = normalizeSkillAttachmentList(
      slotSkillMap[slotKey]
      || roleSkillMap[roleKey]
      || runtimeAgent?.attached_skills
      || slot?.attached_skills
      || []
    );
    return {
      ...slot,
      attached_skills: attachments,
    };
  });

  const rolesOut = asArray(plan.roles).map((role) => {
    const roleKey = normalizeText(role?.role_id || role?.role_type || role?.id || role?.role_label, { lower: true });
    const runtimeAgent = runtimeAgentsOut.find((agent) => normalizeText(agent?.slot_id) === normalizeText(role?.slot_id))
      || runtimeAgentsOut.find((agent) => normalizeText(agent?.role_id || agent?.role_label, { lower: true }) === roleKey);
    const attachments = normalizeSkillAttachmentList(
      roleSkillMap[roleKey]
      || runtimeAgent?.attached_skills
      || role?.attached_skills
      || []
    );
    return {
      ...role,
      attached_skills: attachments,
    };
  });

  return {
    team_plan: {
      ...plan,
      slots: slotsOut,
      roles: rolesOut,
    },
    runtime_agents: runtimeAgentsOut,
  };
}

function resolveRuntimeAgentForAction(action = {}, runtimeAgents = []) {
  const row = action && typeof action === "object" ? action : {};
  const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
  const runtimeInstanceId = normalizeText(inputs.runtime_instance_id || inputs.runtimeInstanceId);
  const slotId = normalizeText(inputs.slot_id || inputs.slotId);
  const roleLabel = normalizeText(
    inputs.role_label
    || inputs.roleLabel
    || row.role_label
    || row.roleLabel,
    { lower: true }
  );
  const actionAgent = normalizeText(row.agent || row.agent_id || row.agentId, { lower: true });
  if (runtimeInstanceId) {
    const byInstance = runtimeAgents.find((agent) => normalizeText(agent?.instance_id) === runtimeInstanceId);
    if (byInstance) return byInstance;
  }
  if (slotId) {
    const bySlot = runtimeAgents.find((agent) => normalizeText(agent?.slot_id) === slotId);
    if (bySlot) return bySlot;
  }
  if (roleLabel) {
    const byRole = runtimeAgents.find((agent) => normalizeText(agent?.role_label, { lower: true }) === roleLabel);
    if (byRole) return byRole;
  }
  if (actionAgent) {
    const byTemplate = runtimeAgents.find((agent) => normalizeText(agent?.template_id, { lower: true }) === actionAgent);
    if (byTemplate) return byTemplate;
    const byRole = runtimeAgents.find((agent) => normalizeText(agent?.role_label, { lower: true }) === actionAgent);
    if (byRole) return byRole;
  }
  return null;
}

function enrichRouteActionsWithRuntimeSkills(actions = [], runtimeAgents = []) {
  return asArray(actions).map((action) => {
    const row = action && typeof action === "object" ? action : {};
    const type = normalizeText(row.type, { lower: true });
    if (type === "spawn_parallel") {
      return {
        ...row,
        agents: asArray(row.agents).map((child) => enrichRouteActionsWithRuntimeSkills([child], runtimeAgents)[0] || child),
      };
    }
    if (!["agent_run", "synthesize_final"].includes(type)) return row;
    const match = resolveRuntimeAgentForAction(row, runtimeAgents);
    if (!match) return row;
    const attachedSkills = normalizeSkillAttachmentList(match.attached_skills || []);
    const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
    return {
      ...row,
      inputs: {
        ...inputs,
        role_id: normalizeText(match.role_id || inputs.role_id, { lower: true }) || undefined,
        role_label: normalizeText(match.role_label || inputs.role_label, { lower: true }) || undefined,
        runtime_instance_id: normalizeText(match.instance_id || inputs.runtime_instance_id) || undefined,
        slot_id: normalizeText(match.slot_id || inputs.slot_id) || undefined,
        context_pack_id: normalizeText(match.context_pack_id || inputs.context_pack_id) || undefined,
        selected_skill_ids: attachedSkills.map((skill) => skill.skill_id),
        skill_load_levels: summarizeSkillLoadLevels(attachedSkills),
      },
    };
  });
}

function buildSelectionReasonSummary({
  teamPlan = null,
  runtimeAgents = [],
  selectionExplanations = [],
  presetResolution = {},
  skillResolution = {},
} = {}) {
  const summary = {
    ...(skillResolution?.selection_reason_summary || {}),
  };
  for (const row of asArray(selectionExplanations)) {
    const subjectId = normalizeText(row?.subject_id || row?.subjectId);
    const reason = normalizeText(row?.reason || row?.selection_reason || row?.selectionReason);
    if (!subjectId || !reason) continue;
    summary[subjectId] = summary[subjectId]
      ? `${summary[subjectId]}; ${reason}`
      : reason;
  }
  for (const [slotId, presetId] of Object.entries(presetResolution?.slot_preset_map || {})) {
    if (!slotId) continue;
    const reason = presetId ? `preset:${presetId}` : "preset:synthesized";
    summary[slotId] = summary[slotId]
      ? `${summary[slotId]}; ${reason}`
      : reason;
  }
  for (const agent of asArray(runtimeAgents)) {
    const instanceId = normalizeText(agent?.instance_id);
    const roleId = normalizeText(agent?.role_id || agent?.role_label, { lower: true });
    const reason = normalizeText(agent?.selection_reason);
    if (!reason) continue;
    if (instanceId) {
      summary[instanceId] = summary[instanceId]
        ? `${summary[instanceId]}; ${reason}`
        : reason;
    }
    if (roleId && !summary[roleId]) {
      summary[roleId] = reason;
    }
  }
  const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
  for (const slot of asArray(plan.slots)) {
    const slotId = normalizeText(slot?.slot_id);
    const reason = normalizeText(slot?.selection_reason);
    if (!slotId || !reason) continue;
    summary[slotId] = summary[slotId]
      ? `${summary[slotId]}; ${reason}`
      : reason;
  }
  return summary;
}

function createSkillUsageEventsFromRuntimeAgents({
  runId = "",
  runtimeAgents = [],
  jobId = "",
  runsDir = "",
  persist = false,
} = {}) {
  const effectiveRunId = normalizeText(runId) || `runtime_${Date.now().toString(36)}`;
  const events = [];
  for (const agent of asArray(runtimeAgents)) {
    const runtimeAgentInstanceId = normalizeText(agent?.instance_id);
    for (const skill of normalizeSkillAttachmentList(agent?.attached_skills || [])) {
      const event = createSkillUsageEvent({
        runId: effectiveRunId,
        runtimeAgentInstanceId,
        skillId: skill.skill_id,
        eventType: "attached",
        payload: {
          selected_by: skill.selected_by,
          selection_reason: skill.selection_reason || undefined,
          load_level: skill.load_level,
          status: skill.status,
        },
      });
      if (!event) continue;
      recordSkillUsageEvent(event, {
        inMemory: events,
        jobId: persist ? normalizeText(jobId) : "",
        runsDir: persist ? normalizeText(runsDir) : "",
      });
    }
  }
  return events;
}

function buildPlannerMetadata({
  interpretedTask = {},
  routePlan = {},
  teamPlan = null,
  runtimeAgents = [],
  contextPacks = [],
  scopeSpecs = [],
  materializedScopes = [],
  visibilityGraph = [],
  scopeGrants = [],
  contextRuntimeMode = "shared_memory",
  legacyContextPackCount = undefined,
  legacyContextPacksEnabled = undefined,
  legacyContextStrategy = undefined,
  selectedSkillIds = [],
  missingRoles = [],
  actionSource = "",
  planSource = "local",
  plannerType = "local",
} = {}) {
  return {
    planner_type: plannerType,
    plan_source: planSource,
    pipeline_version: "control_plane_v2",
    control_mode: normalizeText(interpretedTask?.control_mode, { lower: true }) || undefined,
    review_policy: normalizeText(interpretedTask?.review_policy, { lower: true }) || undefined,
    action_source: normalizeText(actionSource || routePlan?.action_source, { lower: true }) || undefined,
    slot_count: asArray(teamPlan?.slots).length,
    runtime_agent_count: asArray(runtimeAgents).length,
    synthesized_agent_count: asArray(runtimeAgents).filter((agent) => agent?.synthesized === true).length,
    context_pack_count: asArray(contextPacks).length,
    scope_count: asArray(scopeSpecs).length,
    materialized_scope_count: asArray(materializedScopes).length,
    visibility_edge_count: asArray(visibilityGraph).length,
    scope_grant_count: asArray(scopeGrants).length,
    context_runtime_mode: normalizeText(contextRuntimeMode, { lower: true }) || undefined,
    legacy_context_pack_count: Number.isFinite(Number(legacyContextPackCount)) ? Number(legacyContextPackCount) : asArray(contextPacks).length,
    legacy_context_packs_enabled: legacyContextPacksEnabled === true,
    legacy_context_strategy: normalizeText(legacyContextStrategy, { lower: true }) || undefined,
    selected_skill_count: asArray(selectedSkillIds).length,
    checkpoint_count: asArray(teamPlan?.checkpoints).length,
    missing_roles: normalizeStringList(missingRoles, { max: 24, lower: true }),
  };
}

export function createDefaultRunRoute(mode, goal, seedInstruction = "") {
  return createDefaultRunRouteV2(mode, goal, seedInstruction);
}

export function mapTeamPlanToRouteActions(teamBuild = {}, {
  mode = "run",
  goal = "",
  seedInstruction = "",
  taskInterpretation = {},
} = {}) {
  return mapTeamPlanToRouteActionsV2(teamBuild, {
    mode,
    goal,
    seedInstruction,
    taskInterpretation,
  });
}

export function shouldUseGeneratedTeamActions({
  normalizedRoute = null,
  defaultRoute = null,
  teamActions = [],
  hasExplicitRoutePlan = true,
} = {}) {
  return shouldUseGeneratedTeamActionsV2({
    normalizedRoute,
    defaultRoute,
    teamActions,
    hasExplicitRoutePlan,
  });
}

export function buildRuntimeOrchestration({
  mode = "run",
  goal = "",
  task = "",
  message = "",
  seedInstruction = "",
  routePlan = null,
  registry = null,
  preferredRoles = [],
  conversationPreferences = null,
  conversationHints = [],
  toolHints = [],
  availableToolIds = [],
  maxAgents = 6,
  resolveAgentId = null,
  presetRegistry = null,
  presetResolver = null,
  skillRegistry = null,
  skillResolver = null,
  skillLoader = null,
  legacyContextPackBuilder = null,
  contextPackBuilder = null,
  scopePlanner = null,
  runId = "",
  jobId = "",
  runsDir = "",
  persistSkillEvents = false,
  planSource = "local",
  plannerType = "local",
} = {}) {
  const normalizedRoute = normalizeRoutePlan(routePlan, {
    maxActions: 8,
    resolveAgentId,
  });
  const effectiveGoal = normalizeText(goal || task || message);
  const collectedToolIds = collectAvailableToolIds({
    registry,
    availableToolIds,
    toolHints,
  });
  const taskInterpretation = interpretTask({
    goal: effectiveGoal,
    task,
    message,
    mode,
    seedInstruction,
    preferredRoles,
    conversationPreferences,
    conversationHints,
    routeContext: normalizedRoute,
    registry,
    toolHints: collectedToolIds,
  });

  const teamBuild = buildTeamFromRegistry({
    goal: effectiveGoal,
    routeContext: normalizedRoute,
    registry,
    preferredRoles,
    maxAgents,
    mode,
    taskInterpretation,
  });

  const presetRegistryInstance = presetRegistry || new PresetRegistry();
  if (typeof presetRegistryInstance?.load === "function") {
    presetRegistryInstance.load();
  }
  const presetResolverInstance = presetResolver || new PresetResolver({
    presetRegistry: presetRegistryInstance,
    registry,
  });
  const presetResolution = typeof presetResolverInstance?.resolveForTeam === "function"
    ? presetResolverInstance.resolveForTeam({
      teamPlan: teamBuild.team_plan,
      taskInterpretation,
      goal: effectiveGoal,
      registry,
      availableToolIds: collectedToolIds,
    })
    : {
      runtime_agents: teamBuild.runtime_agents,
      selection_explanations: [],
      slot_preset_map: {},
      missing_roles: teamBuild.missing_roles || [],
    };

  let combinedSelectionExplanations = [
    ...asArray(teamBuild.team_plan?.selection_explanations),
    ...asArray(presetResolution.selection_explanations),
  ];

  let teamPlan = normalizeTeamPlan({
    ...(teamBuild.team_plan || {}),
    task_interpretation: taskInterpretation,
    conversation_preferences: conversationPreferences || undefined,
    runtime_agents: presetResolution.runtime_agents,
    selection_explanations: combinedSelectionExplanations,
  });
  let runtimeAgents = asArray(presetResolution.runtime_agents);

  const skillRegistryInstance = skillRegistry || new SkillRegistry();
  if (typeof skillRegistryInstance?.load === "function") {
    skillRegistryInstance.load();
  }
  const skillResolverInstance = skillResolver || new SkillResolver({
    registry: skillRegistryInstance,
    maxSkillsPerRole: 3,
  });
  const skillResolution = typeof skillResolverInstance?.resolveForTeam === "function"
    ? skillResolverInstance.resolveForTeam({
      goal: effectiveGoal,
      teamPlan,
      runtimeAgents,
      contextHints: collectContextHints(effectiveGoal, normalizedRoute),
      taskInterpretation,
      availableToolIds: collectedToolIds,
    })
    : {
      slot_skill_map: {},
      role_skill_map: {},
      runtime_agent_skill_map: {},
      selection_reason_summary: {},
      selected_skill_ids: [],
    };

  const skillApplied = applyResolvedSkills({
    teamPlan,
    runtimeAgents,
    resolution: skillResolution,
  });
  teamPlan = normalizeTeamPlan({
    ...(skillApplied.team_plan || {}),
    conversation_preferences: conversationPreferences || undefined,
    runtime_agents: skillApplied.runtime_agents,
    selection_explanations: combinedSelectionExplanations,
  });
  runtimeAgents = asArray(skillApplied.runtime_agents);

  const coordinated = coordinateExecutionPlan({
    mode,
    goal: effectiveGoal,
    seedInstruction,
    routePlan: normalizedRoute,
    teamPlan,
    runtimeAgents,
    taskInterpretation,
  });

  const skillLoaderInstance = skillLoader || new SkillLoader({
    registry: skillRegistryInstance,
  });
  const legacyContextPackBuilderInstance = legacyContextPackBuilder || contextPackBuilder || new LegacyContextPackBuilder({
    registry: skillRegistryInstance,
    skillLoader: skillLoaderInstance,
  });
  const legacyContextResult = typeof legacyContextPackBuilderInstance?.build === "function"
    ? legacyContextPackBuilderInstance.build({
      runId,
      goal: effectiveGoal,
      teamPlan,
      runtimeAgents,
      effectiveActions: coordinated.route_plan.actions,
      routeReason: coordinated.route_plan.reason,
      taskInterpretation,
    })
    : {
      team_plan: teamPlan,
      runtime_agents: runtimeAgents,
      context_packs: [],
      selected_skill_ids: skillResolution.selected_skill_ids || [],
      skill_load_levels: {},
    };

  teamPlan = normalizeTeamPlan({
    ...(legacyContextResult.team_plan || teamPlan),
    task_interpretation: taskInterpretation,
    conversation_preferences: conversationPreferences || undefined,
    runtime_agents: legacyContextResult.runtime_agents,
    selection_explanations: combinedSelectionExplanations,
  });
  runtimeAgents = asArray(legacyContextResult.runtime_agents);

  const scopePlannerInstance = scopePlanner || new ScopePlanner();
  const scopePlan = typeof scopePlannerInstance?.build === "function"
    ? scopePlannerInstance.build({
      goal: effectiveGoal,
      teamPlan,
      runtimeAgents,
      effectiveActions: coordinated.route_plan.actions,
      taskInterpretation,
      legacyContextPacks: legacyContextResult.context_packs,
    })
    : {
      context_runtime_mode: "shared_memory",
      scope_specs: [],
      materialized_scopes: [],
      visibility_graph: [],
      scope_grants: [],
      legacy_context_pack_count: Array.isArray(legacyContextResult.context_packs) ? legacyContextResult.context_packs.length : 0,
      legacy_context_packs_enabled: false,
      legacy_context_strategy: "disabled",
    };

  const runtimeAgentsWithScopes = asArray(runtimeAgents).map((agent) => {
    const instanceId = normalizeText(agent?.instance_id || agent?.instanceId);
    const slotId = normalizeText(agent?.slot_id || agent?.slotId);
    const matchingScope = asArray(scopePlan.scope_specs).find((scope) => normalizeText(scope?.target_instance_id || scope?.targetInstanceId) === instanceId)
      || asArray(scopePlan.scope_specs).find((scope) => normalizeText(scope?.target_slot_id || scope?.targetSlotId) === slotId)
      || null;
    if (!matchingScope) return agent;
    return {
      ...agent,
      scope_id: matchingScope.scope_id,
      visibility_mode: matchingScope.visibility_mode,
      memory_grants: matchingScope.memory_grants,
    };
  });

  const planningResult = {
    team_plan: {
      ...teamPlan,
      context_runtime_mode: scopePlan.context_runtime_mode,
      scope_specs: scopePlan.scope_specs,
      materialized_scopes: scopePlan.materialized_scopes,
      visibility_graph: scopePlan.visibility_graph,
      scope_grants: scopePlan.scope_grants,
      legacy_context_pack_count: scopePlan.legacy_context_pack_count,
      legacy_context_packs_enabled: scopePlan.legacy_context_packs_enabled,
      legacy_context_strategy: scopePlan.legacy_context_strategy,
    },
    runtime_agents: runtimeAgentsWithScopes,
    context_packs: legacyContextResult.context_packs || [],
    selected_skill_ids: legacyContextResult.selected_skill_ids || skillResolution.selected_skill_ids || [],
    skill_load_levels: legacyContextResult.skill_load_levels || {},
    scope_specs: scopePlan.scope_specs || [],
    materialized_scopes: scopePlan.materialized_scopes || [],
    visibility_graph: scopePlan.visibility_graph || [],
    scope_grants: scopePlan.scope_grants || [],
    context_runtime_mode: scopePlan.context_runtime_mode || "shared_memory",
    legacy_context_pack_count: scopePlan.legacy_context_pack_count,
    legacy_context_packs_enabled: scopePlan.legacy_context_packs_enabled,
    legacy_context_strategy: scopePlan.legacy_context_strategy,
  };

  teamPlan = normalizeTeamPlan({
    ...(planningResult.team_plan || teamPlan),
    task_interpretation: taskInterpretation,
    conversation_preferences: conversationPreferences || undefined,
    runtime_agents: planningResult.runtime_agents,
    selection_explanations: combinedSelectionExplanations,
  });
  runtimeAgents = asArray(planningResult.runtime_agents);

  const rerankedTeam = rerankResolvedTeamComposition({
    teamPlan,
    runtimeAgents,
    taskInterpretation,
    scoredCandidatesBySlot: presetResolution.scored_candidates_by_slot || {},
  });
  combinedSelectionExplanations = [
    ...combinedSelectionExplanations,
    ...asArray(rerankedTeam.selection_explanations),
  ];

  const rebuiltCollaborationCells = buildCollaborationCells({
    runtimeAgents,
    supervisorRuntime: teamPlan?.supervisor_runtime,
  });
  const rebuiltCheckpoints = buildExecutionCheckpoints({
    slots: teamPlan?.slots || [],
    runtimeAgents,
    supervisorRuntime: teamPlan?.supervisor_runtime,
    collaborationCells: rebuiltCollaborationCells,
  });

  teamPlan = reconcileTeamPlanRuntimeBindings({
    ...teamPlan,
    collaboration_cells: rebuiltCollaborationCells,
    checkpoints: rebuiltCheckpoints,
    runtime_agents: runtimeAgents,
    selection_explanations: combinedSelectionExplanations,
    conversation_preferences: conversationPreferences || undefined,
  }, {
    runtimeAgents,
  });
  runtimeAgents = asArray(teamPlan.runtime_agents);

  const validation = validateNormalizedTeamPlan(teamPlan);
  if (!validation.ok) {
    throw new Error(`invalid_team_plan_runtime:${validation.errors.join(",")}`);
  }

  let finalizedCoordination = coordinateExecutionPlan({
    mode,
    goal: effectiveGoal,
    seedInstruction,
    routePlan: normalizedRoute,
    teamPlan,
    runtimeAgents,
    taskInterpretation,
  });
  const alignedParallelGroups = deriveParallelGroupsFromRouteActions(finalizedCoordination.route_plan.actions);
  const parallelismExplanations = asArray(finalizedCoordination.route_plan.actions)
    .filter((action) => normalizeText(action?.type, { lower: true }) === "spawn_parallel")
    .map((action) => normalizeText(action?.metadata?.parallelism_override_reason))
    .filter(Boolean)
    .map((reason) => ({
      subject_id: "execution_graph",
      reason: `route_alignment:${reason}`,
    }));

  if (
    JSON.stringify(asArray(teamPlan?.execution_graph?.parallel_groups)) !== JSON.stringify(alignedParallelGroups)
    || parallelismExplanations.length > 0
  ) {
    combinedSelectionExplanations = [
      ...combinedSelectionExplanations,
      ...parallelismExplanations.filter((entry) =>
        !combinedSelectionExplanations.some((existing) =>
          normalizeText(existing?.subject_id || existing?.subjectId) === entry.subject_id
          && normalizeText(existing?.reason) === entry.reason
        )
      ),
    ];
    teamPlan = reconcileTeamPlanRuntimeBindings({
      ...teamPlan,
      execution_graph: {
        ...(teamPlan?.execution_graph || {}),
        parallel_groups: alignedParallelGroups,
      },
      selection_explanations: combinedSelectionExplanations,
    }, {
      runtimeAgents,
    });
    const alignmentValidation = validateNormalizedTeamPlan(teamPlan);
    if (!alignmentValidation.ok) {
      throw new Error(`invalid_team_plan_route_alignment:${alignmentValidation.errors.join(",")}`);
    }
    finalizedCoordination = coordinateExecutionPlan({
      mode,
      goal: effectiveGoal,
      seedInstruction,
      routePlan: normalizedRoute,
      teamPlan,
      runtimeAgents,
      taskInterpretation,
    });
  }

  const selectedSkillIds = normalizeStringList(
    planningResult.selected_skill_ids || skillResolution.selected_skill_ids || [],
    { max: 128, lower: true }
  );
  const selectionReasonSummary = buildSelectionReasonSummary({
    teamPlan,
    runtimeAgents,
    selectionExplanations: combinedSelectionExplanations,
    presetResolution,
    skillResolution,
  });
  const skillUsageEvents = createSkillUsageEventsFromRuntimeAgents({
    runId,
    runtimeAgents,
    jobId,
    runsDir,
    persist: persistSkillEvents === true,
  });
  const skillUsageSummary = summarizeSkillUsageEvents(skillUsageEvents);
  const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
    taskInterpretation,
    teamPlan,
    runtimeAgents,
    contextPacks: planningResult.context_packs,
    scopeSpecs: planningResult.scope_specs,
    materializedScopes: planningResult.materialized_scopes,
    visibilityGraph: planningResult.visibility_graph,
    scopeGrants: planningResult.scope_grants,
    contextRuntimeMode: planningResult.context_runtime_mode,
    legacyContextPackCount: planningResult.legacy_context_pack_count,
    legacyContextPacksEnabled: planningResult.legacy_context_packs_enabled,
    legacyContextStrategy: planningResult.legacy_context_strategy,
    collaborationCells: teamPlan?.collaboration_cells,
    authorityGraph: teamPlan?.authority_graph,
    checkpoints: teamPlan?.checkpoints,
    executionGraph: teamPlan?.execution_graph,
    selectionExplanations: combinedSelectionExplanations,
    supervisorRuntime: teamPlan?.supervisor_runtime,
    selectedSkillIds,
    skillLoadLevels: planningResult.skill_load_levels,
    selectionReasonSummary,
    skillUsageEvents,
    skillUsageSummary,
    source: "control_plane",
  });
  const routePlanWithSkills = attachRuntimeTeamSnapshot({
    ...finalizedCoordination.route_plan,
    actions: enrichRouteActionsWithRuntimeSkills(finalizedCoordination.route_plan.actions, runtimeAgents),
    selected_skill_ids: selectedSkillIds,
    skill_load_levels: planningResult.skill_load_levels,
    selection_reason_summary: selectionReasonSummary,
    context_packs: planningResult.context_packs,
    scope_specs: planningResult.scope_specs,
    materialized_scopes: planningResult.materialized_scopes,
    visibility_graph: planningResult.visibility_graph,
    scope_grants: planningResult.scope_grants,
    context_runtime_mode: planningResult.context_runtime_mode,
    task_interpretation: taskInterpretation,
    collaboration_cells: teamPlan?.collaboration_cells,
    authority_graph: teamPlan?.authority_graph,
    checkpoints: teamPlan?.checkpoints,
    execution_graph: teamPlan?.execution_graph,
    supervisor_runtime: teamPlan?.supervisor_runtime,
    selection_explanations: combinedSelectionExplanations,
  }, runtimeTeamSnapshot);
  const missingRoles = normalizeStringList(
    presetResolution.missing_roles || teamBuild.missing_roles || [],
    { max: 24, lower: true }
  );
  const plannerMetadata = buildPlannerMetadata({
    interpretedTask: taskInterpretation,
    routePlan: routePlanWithSkills,
    teamPlan,
    runtimeAgents,
    contextPacks: planningResult.context_packs,
    scopeSpecs: planningResult.scope_specs,
    materializedScopes: planningResult.materialized_scopes,
    visibilityGraph: planningResult.visibility_graph,
    scopeGrants: planningResult.scope_grants,
    contextRuntimeMode: planningResult.context_runtime_mode,
    legacyContextPackCount: planningResult.legacy_context_pack_count,
    legacyContextPacksEnabled: planningResult.legacy_context_packs_enabled,
    legacyContextStrategy: planningResult.legacy_context_strategy,
    selectedSkillIds,
    missingRoles,
    actionSource: finalizedCoordination.action_source,
    planSource,
    plannerType,
  });

  return {
    interpreted_task: taskInterpretation,
    team_plan: teamPlan,
    runtime_agents: runtimeAgents,
    context_packs: planningResult.context_packs,
    scope_specs: planningResult.scope_specs,
    materialized_scopes: planningResult.materialized_scopes,
    visibility_graph: planningResult.visibility_graph,
    scope_grants: planningResult.scope_grants,
    context_runtime_mode: planningResult.context_runtime_mode,
    legacy_context_pack_count: planningResult.legacy_context_pack_count,
    legacy_context_packs_enabled: planningResult.legacy_context_packs_enabled,
    legacy_context_strategy: planningResult.legacy_context_strategy,
    selected_skill_ids: selectedSkillIds,
    skill_load_levels: planningResult.skill_load_levels || {},
    selection_reason_summary: selectionReasonSummary,
    skill_usage_events: skillUsageEvents,
    skill_usage_summary: skillUsageSummary,
    route_plan: routePlanWithSkills,
    runtime_team_snapshot: runtimeTeamSnapshot,
    planner_metadata: plannerMetadata,
    missing_roles: missingRoles,
  };
}
