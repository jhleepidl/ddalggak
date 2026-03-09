import { buildTeamFromRegistry } from "./team_builder.js";
import { normalizeRoutePlan } from "../domain/route_plan.js";

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
  const effectiveActions = teamActions.length > 0
    ? teamActions
    : (Array.isArray(normalizedRoute.actions) && normalizedRoute.actions.length > 0
      ? normalizedRoute.actions
      : defaultRoute.actions);

  return {
    team_plan: teamBuild.team_plan,
    runtime_agents: teamBuild.runtime_agents,
    missing_roles: teamBuild.missing_roles,
    route_plan: {
      ...normalizedRoute,
      mode: String(mode || "run").trim().toLowerCase(),
      actions: effectiveActions,
      reason: [
        String(normalizedRoute.reason || "route plan"),
        String(teamBuild.reason || "team build"),
      ].filter(Boolean).join("; "),
    },
  };
}
