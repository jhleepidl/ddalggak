import {
  buildRuntimeOrchestration,
  createDefaultRunRoute,
} from "../application/orchestrator.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeActionSource(raw = "") {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "generated_team_actions" || key === "default_fallback_route" || key === "explicit_route_plan") {
    return key;
  }
  return "";
}

function normalizePlanSource(raw = "", { fallback = "local" } = {}) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "local" || key === "goc" || key === "local_fallback") return key;
  return fallback;
}

export class LocalPlanner {
  constructor({
    resolveAgentId = null,
    source = "local",
  } = {}) {
    this.source = normalizePlanSource(source, { fallback: "local" });
    this.resolveAgentId = typeof resolveAgentId === "function" ? resolveAgentId : null;
  }

  plan({
    mode = "run",
    goal = "",
    seedInstruction = "",
    routePlan = null,
    registry = null,
    preferredRoles = [],
    maxAgents = 6,
    runId = "",
    jobId = "",
    runsDir = "",
    persistSkillEvents = false,
  } = {}) {
    const fallbackRoute = createDefaultRunRoute(mode, goal, seedInstruction);
    const orchestration = buildRuntimeOrchestration({
      mode,
      goal,
      seedInstruction,
      routePlan,
      registry,
      preferredRoles,
      maxAgents,
      resolveAgentId: this.resolveAgentId,
      runId: normalizeText(runId) || `plan_${Date.now().toString(36)}`,
      jobId: normalizeText(jobId),
      runsDir: normalizeText(runsDir),
      persistSkillEvents: persistSkillEvents === true,
    });
    const route = orchestration?.route_plan && typeof orchestration.route_plan === "object"
      ? orchestration.route_plan
      : {};
    const actions = Array.isArray(route.actions) && route.actions.length > 0
      ? route.actions
      : fallbackRoute.actions;
    const actionSource = normalizeActionSource(route.action_source)
      || (routePlan ? "explicit_route_plan" : "default_fallback_route");
    const reason = normalizeText(route.reason)
      || normalizeText(routePlan?.reason)
      || fallbackRoute.reason
      || "planner route";

    return {
      plan_source: this.source,
      route_plan: {
        ...route,
        actions,
        reason,
        action_source: actionSource,
      },
      team_plan: orchestration?.team_plan || null,
      runtime_agents: Array.isArray(orchestration?.runtime_agents) ? orchestration.runtime_agents : [],
      runtime_team_snapshot: orchestration?.runtime_team_snapshot || null,
    };
  }
}

export class RemotePlanner {
  constructor({
    run = null,
    source = "goc",
  } = {}) {
    this.source = normalizePlanSource(source, { fallback: "goc" });
    this.run = typeof run === "function" ? run : null;
  }

  async plan(input = {}) {
    if (!this.run) {
      throw new Error("RemotePlanner requires run()");
    }
    const result = await this.run(input);
    return {
      ...result,
      plan_source: normalizePlanSource(result?.plan_source || this.source, {
        fallback: this.source,
      }),
    };
  }
}

