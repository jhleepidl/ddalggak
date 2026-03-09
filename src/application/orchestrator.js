import { buildTeamFromRegistry } from "./team_builder.js";
import { normalizeRoutePlan } from "../domain/route_plan.js";
import { createRuntimeTeamSnapshot, attachRuntimeTeamSnapshot } from "./runtime_metadata.js";

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
} = {}) {
  const explicitActions = Array.isArray(normalizedRoute?.actions) ? normalizedRoute.actions : [];
  if (!Array.isArray(teamActions) || teamActions.length === 0) return false;
  if (explicitActions.length === 0) return true;

  const reason = String(normalizedRoute?.reason || "").trim().toLowerCase();
  if (reason.includes("fallback")) return true;

  const fallbackActions = Array.isArray(defaultRoute?.actions) ? defaultRoute.actions : [];
  if (fallbackActions.length > 0 && sameActionPlan(explicitActions, fallbackActions)) return true;

  return false;
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
} = {}) {
  const defaultRoute = createDefaultRunRoute(mode, goal, seedInstruction);
  const normalizedRoute = normalizeRoutePlan(routePlan || defaultRoute, {
    maxActions: 4,
    resolveAgentId,
  });

  const teamBuild = buildTeamFromRegistry({
    goal,
    routeContext: normalizedRoute,
    registry,
    preferredRoles,
    maxAgents,
    mode,
  });

  const teamActions = mapTeamPlanToRouteActions(teamBuild, { mode, goal, seedInstruction });
  const useTeamActions = shouldUseGeneratedTeamActions({
    normalizedRoute,
    defaultRoute,
    teamActions,
  });
  const effectiveActions = useTeamActions
    ? teamActions
    : (Array.isArray(normalizedRoute.actions) && normalizedRoute.actions.length > 0
      ? normalizedRoute.actions
      : defaultRoute.actions);
  const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
    teamPlan: teamBuild.team_plan,
    runtimeAgents: teamBuild.runtime_agents,
    source: "team_builder",
  });

  return {
    team_plan: teamBuild.team_plan,
    runtime_agents: teamBuild.runtime_agents,
    runtime_team_snapshot: runtimeTeamSnapshot,
    missing_roles: teamBuild.missing_roles,
    route_plan: attachRuntimeTeamSnapshot({
      ...normalizedRoute,
      mode: String(mode || "run").trim().toLowerCase(),
      actions: effectiveActions,
      action_source: useTeamActions ? "generated_team_actions" : "explicit_route_plan",
      reason: [
        String(normalizedRoute.reason || "route plan"),
        String(teamBuild.reason || "team build"),
      ].filter(Boolean).join("; "),
    }, runtimeTeamSnapshot),
  };
}
