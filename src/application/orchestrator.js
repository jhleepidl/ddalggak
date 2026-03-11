import { buildTeamFromRegistry } from "./team_builder.js";
import { normalizeRoutePlan } from "../domain/route_plan.js";
import { createRuntimeTeamSnapshot, attachRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { normalizeSkillAttachmentList, summarizeSkillLoadLevels } from "../domain/skill_attachment.js";
import { SkillRegistry } from "./skill_registry.js";
import { SkillResolver } from "./skill_resolver.js";
import { SkillLoader } from "./skill_loader.js";
import { ContextPackBuilder } from "./context_pack_builder.js";
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

function roleKey(raw = {}) {
  return normalizeText(raw?.id || raw?.role_type || raw?.role_label, { lower: true });
}

function mapRoleSkillResolution(teamBuild = {}, resolution = {}) {
  const roleSkillMap = resolution?.role_skill_map && typeof resolution.role_skill_map === "object"
    ? resolution.role_skill_map
    : {};
  const roles = asArray(teamBuild?.team_plan?.roles).map((role) => {
    const key = roleKey(role);
    const attached = normalizeSkillAttachmentList(roleSkillMap[key] || role?.attached_skills || []);
    return {
      ...role,
      attached_skills: attached,
    };
  });
  const runtimeAgents = asArray(teamBuild?.runtime_agents).map((agent) => {
    const key = normalizeText(agent?.role_label, { lower: true });
    const attached = normalizeSkillAttachmentList(roleSkillMap[key] || agent?.attached_skills || []);
    return {
      ...agent,
      attached_skills: attached,
    };
  });
  return {
    ...teamBuild,
    team_plan: {
      ...(teamBuild?.team_plan || {}),
      roles,
    },
    runtime_agents: runtimeAgents,
  };
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

function resolveRuntimeAgentForAction(action = {}, runtimeAgents = []) {
  const row = action && typeof action === "object" ? action : {};
  const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
  const runtimeInstanceId = normalizeText(inputs.runtime_instance_id || inputs.runtimeInstanceId);
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
    if (normalizeText(row.type, { lower: true }) !== "agent_run") return row;
    const match = resolveRuntimeAgentForAction(row, runtimeAgents);
    if (!match) return row;
    const attachedSkills = normalizeSkillAttachmentList(match.attached_skills || []);
    const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
    return {
      ...row,
      inputs: {
        ...inputs,
        role_label: normalizeText(match.role_label, { lower: true }) || undefined,
        runtime_instance_id: normalizeText(match.instance_id) || undefined,
        context_pack_id: normalizeText(match.context_pack_id) || undefined,
        selected_skill_ids: attachedSkills.map((skill) => skill.skill_id),
        skill_load_levels: summarizeSkillLoadLevels(attachedSkills),
      },
    };
  });
}

function summarizeSelectionReasonByRole(runtimeAgents = []) {
  const summary = {};
  for (const agent of asArray(runtimeAgents)) {
    const key = normalizeText(agent?.role_label, { lower: true });
    if (!key) continue;
    const reasons = normalizeSkillAttachmentList(agent?.attached_skills || [])
      .map((row) => `${row.skill_id}:${row.selection_reason || "selected"}`);
    if (reasons.length === 0) continue;
    summary[key] = reasons.join("; ");
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

export function createDefaultRunRoute(mode, goal, seedInstruction = "") {
  const cleanMode = String(mode || "run").trim().toLowerCase();
  if (cleanMode === "continue") {
    return {
      actions: [
        {
          type: "agent_run",
          agent: "coder",
          prompt: seedInstruction || "run/shared 문서를 반영해 CODEX_WORKSPACE_ROOT 코드 변경을 진행하라.",
          inputs: {},
        },
        { type: "git_summary" },
      ],
      reason: "fallback: continue default",
      mode: cleanMode,
    };
  }

  return {
    actions: [
      { type: "agent_run", agent: "researcher", prompt: goal, inputs: {} },
      { type: "agent_run", agent: "coder", prompt: goal, inputs: {} },
      { type: "git_summary" },
    ],
    reason: "fallback: run default",
    mode: cleanMode,
  };
}

export function mapTeamPlanToRouteActions(teamBuild = {}, {
  mode = "run",
  goal = "",
  seedInstruction = "",
} = {}) {
  const runtimeAgents = Array.isArray(teamBuild?.runtime_agents) ? teamBuild.runtime_agents : [];
  if (runtimeAgents.length === 0) return [];

  const actions = [];
  for (const role of (teamBuild?.team_plan?.execution_order || [])) {
    const match = runtimeAgents.find((agent) => String(agent.role_label || "").trim().toLowerCase() === String(role || "").trim().toLowerCase());
    if (!match) continue;
    if (["messenger", "context_curator"].includes(String(role || ""))) continue;
    const prompt = String(
      role === "coder"
        ? (seedInstruction || goal)
        : goal
    ).trim();
    if (!prompt) continue;
    actions.push({
      type: "agent_run",
      agent: String(match.template_id || match.role_label || "").trim().toLowerCase(),
      prompt,
      inputs: {
        role_label: String(match.role_label || "").trim().toLowerCase(),
        runtime_instance_id: String(match.instance_id || "").trim(),
      },
    });
    if (actions.length >= 4) break;
  }

  if (String(mode || "").trim().toLowerCase() !== "chat" && actions.length < 4) {
    actions.push({ type: "git_summary" });
  }
  return actions.slice(0, 4);
}

function actionSignature(action = {}) {
  const row = action && typeof action === "object" ? action : {};
  const type = String(row.type || "").trim().toLowerCase();
  if (type === "agent_run") {
    return [
      type,
      String(row.agent || row.agent_id || "").trim().toLowerCase(),
      String(row.prompt || row.goal || "").trim(),
    ].join("|");
  }
  if (type === "chatgpt_prompt") {
    return [type, String(row.question || "").trim()].join("|");
  }
  return type;
}

function sameActionPlan(a = [], b = []) {
  const aList = Array.isArray(a) ? a : [];
  const bList = Array.isArray(b) ? b : [];
  if (aList.length !== bList.length) return false;
  for (let i = 0; i < aList.length; i += 1) {
    if (actionSignature(aList[i]) !== actionSignature(bList[i])) return false;
  }
  return true;
}

export function shouldUseGeneratedTeamActions({
  normalizedRoute = null,
  defaultRoute = null,
  teamActions = [],
  hasExplicitRoutePlan = true,
} = {}) {
  if (!hasExplicitRoutePlan) {
    return Array.isArray(teamActions) && teamActions.length > 0;
  }
  const explicitActions = Array.isArray(normalizedRoute?.actions) ? normalizedRoute.actions : [];
  if (!Array.isArray(teamActions) || teamActions.length === 0) return false;
  if (explicitActions.length === 0) return true;

  const reason = String(normalizedRoute?.reason || "").trim().toLowerCase();
  if (reason.includes("fallback")) return true;

  const fallbackActions = Array.isArray(defaultRoute?.actions) ? defaultRoute.actions : [];
  if (fallbackActions.length > 0 && sameActionPlan(explicitActions, fallbackActions)) return true;

  return false;
}

function classifyActionSource({
  useTeamActions = false,
  explicitActions = [],
} = {}) {
  if (useTeamActions) return "generated_team_actions";
  if (Array.isArray(explicitActions) && explicitActions.length > 0) return "explicit_route_plan";
  return "default_fallback_route";
}

export function buildRuntimeOrchestration({
  mode = "run",
  goal = "",
  seedInstruction = "",
  routePlan = null,
  registry = null,
  preferredRoles = [],
  maxAgents = 6,
  resolveAgentId = null,
  skillRegistry = null,
  skillResolver = null,
  skillLoader = null,
  contextPackBuilder = null,
  runId = "",
  jobId = "",
  runsDir = "",
  persistSkillEvents = false,
} = {}) {
  const defaultRoute = createDefaultRunRoute(mode, goal, seedInstruction);
  const hasExplicitRoutePlan = !!(routePlan && typeof routePlan === "object");
  const normalizedRoute = normalizeRoutePlan(hasExplicitRoutePlan ? routePlan : null, {
    maxActions: 4,
    resolveAgentId,
  });

  const teamBuildBase = buildTeamFromRegistry({
    goal,
    routeContext: normalizedRoute,
    registry,
    preferredRoles,
    maxAgents,
    mode,
  });
  const skillRegistryInstance = skillRegistry || new SkillRegistry();
  if (typeof skillRegistryInstance?.load === "function") {
    skillRegistryInstance.load();
  }
  const skillResolverInstance = skillResolver || new SkillResolver({
    registry: skillRegistryInstance,
    maxSkillsPerRole: 2,
  });
  const skillLoaderInstance = skillLoader || new SkillLoader({
    registry: skillRegistryInstance,
  });
  const contextPackBuilderInstance = contextPackBuilder || new ContextPackBuilder({
    registry: skillRegistryInstance,
    skillLoader: skillLoaderInstance,
  });
  const skillResolution = typeof skillResolverInstance?.resolveForTeam === "function"
    ? skillResolverInstance.resolveForTeam({
      goal,
      teamPlan: teamBuildBase.team_plan,
      contextHints: collectContextHints(goal, normalizedRoute),
    })
    : {
      role_skill_map: {},
      selection_reason_summary: {},
      selected_skill_ids: [],
    };
  let teamBuild = mapRoleSkillResolution(teamBuildBase, skillResolution);

  const teamActions = mapTeamPlanToRouteActions(teamBuild, { mode, goal, seedInstruction });
  const useTeamActions = shouldUseGeneratedTeamActions({
    normalizedRoute,
    defaultRoute,
    teamActions,
    hasExplicitRoutePlan,
  });
  const explicitActions = Array.isArray(normalizedRoute.actions) ? normalizedRoute.actions : [];
  const effectiveActionsBase = useTeamActions
    ? teamActions
    : (explicitActions.length > 0
      ? explicitActions
      : defaultRoute.actions);
  const actionSource = classifyActionSource({
    useTeamActions,
    explicitActions,
  });
  const contextPackResult = typeof contextPackBuilderInstance?.build === "function"
    ? contextPackBuilderInstance.build({
      runId,
      goal,
      teamPlan: teamBuild.team_plan,
      runtimeAgents: teamBuild.runtime_agents,
      effectiveActions: effectiveActionsBase,
      routeReason: normalizeText(normalizedRoute.reason) || normalizeText(defaultRoute.reason),
    })
    : {
      team_plan: teamBuild.team_plan,
      runtime_agents: teamBuild.runtime_agents,
      context_packs: [],
      selected_skill_ids: [],
      skill_load_levels: {},
    };
  teamBuild = {
    ...teamBuild,
    team_plan: contextPackResult.team_plan,
    runtime_agents: contextPackResult.runtime_agents,
  };
  const effectiveActions = enrichRouteActionsWithRuntimeSkills(effectiveActionsBase, teamBuild.runtime_agents);
  const selectionReasonSummary = {
    ...(skillResolution.selection_reason_summary || {}),
    ...summarizeSelectionReasonByRole(teamBuild.runtime_agents),
  };
  const skillUsageEvents = createSkillUsageEventsFromRuntimeAgents({
    runId,
    runtimeAgents: teamBuild.runtime_agents,
    jobId,
    runsDir,
    persist: persistSkillEvents === true,
  });
  const usageSummary = summarizeSkillUsageEvents(skillUsageEvents);
  const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
    teamPlan: teamBuild.team_plan,
    runtimeAgents: teamBuild.runtime_agents,
    contextPacks: contextPackResult.context_packs,
    selectedSkillIds: contextPackResult.selected_skill_ids,
    skillLoadLevels: contextPackResult.skill_load_levels,
    selectionReasonSummary,
    skillUsageEvents,
    skillUsageSummary: usageSummary,
    source: "team_builder",
  });
  const routeReason = actionSource === "default_fallback_route"
    ? String(defaultRoute.reason || "fallback route")
    : String(normalizedRoute.reason || "route plan");

  return {
    team_plan: teamBuild.team_plan,
    runtime_agents: teamBuild.runtime_agents,
    runtime_team_snapshot: runtimeTeamSnapshot,
    context_packs: contextPackResult.context_packs,
    selected_skill_ids: contextPackResult.selected_skill_ids,
    skill_load_levels: contextPackResult.skill_load_levels,
    selection_reason_summary: selectionReasonSummary,
    skill_usage_events: skillUsageEvents,
    missing_roles: teamBuild.missing_roles,
    route_plan: attachRuntimeTeamSnapshot({
      ...normalizedRoute,
      mode: String(mode || "run").trim().toLowerCase(),
      actions: effectiveActions,
      action_source: actionSource,
      selected_skill_ids: contextPackResult.selected_skill_ids,
      skill_load_levels: contextPackResult.skill_load_levels,
      selection_reason_summary: selectionReasonSummary,
      context_packs: contextPackResult.context_packs,
      reason: [
        routeReason,
        String(teamBuild.reason || "team build"),
      ].filter(Boolean).join("; "),
    }, runtimeTeamSnapshot),
  };
}
