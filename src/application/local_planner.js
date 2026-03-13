import { buildRuntimeOrchestration } from "./orchestrator.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeMode(raw = "", { fallback = "run" } = {}) {
  const key = normalizeText(raw).toLowerCase();
  return key || fallback;
}

function normalizePlanSource(raw = "", { fallback = "local" } = {}) {
  const key = normalizeText(raw).toLowerCase();
  if (key === "local" || key === "goc" || key === "local_fallback") return key;
  return fallback;
}

function normalizeActionSource(raw = "", { fallback = "" } = {}) {
  const key = normalizeText(raw).toLowerCase();
  if (key === "generated_team_actions" || key === "default_fallback_route" || key === "explicit_route_plan") {
    return key;
  }
  return normalizeText(fallback).toLowerCase() || "";
}

function normalizeBoolean(raw = false) {
  return raw === true;
}

function normalizeInteger(raw, {
  fallback = 6,
  min = 1,
  max = 12,
} = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeStringList(raw = [], {
  lower = true,
  max = 12,
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

function normalizeObjectMap(raw = {}) {
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeRoutePlanInput(raw = null) {
  return raw && typeof raw === "object" ? raw : null;
}

function normalizeRoutePlan(raw = {}) {
  const row = asObject(raw);
  return {
    ...row,
    mode: normalizeMode(row.mode, { fallback: "run" }),
    reason: normalizeText(row.reason),
    action_source: normalizeActionSource(
      row.action_source || row.actionSource || "",
      { fallback: "" }
    ),
    actions: asArray(row.actions),
    done: row.done === true,
    await_user: row.await_user === true || row.awaitUser === true,
    deliverables: asArray(row.deliverables),
    completed_deliverables: asArray(row.completed_deliverables || row.completedDeliverables),
    followup_hint: normalizeText(row.followup_hint || row.followupHint) || undefined,
  };
}

export function normalizePlanningRequest(input = {}) {
  const row = asObject(input);
  return {
    mode: normalizeMode(row.mode, { fallback: "run" }),
    goal: normalizeText(row.goal || row.task || row.message),
    seed_instruction: normalizeText(row.seed_instruction || row.seedInstruction),
    route_plan: normalizeRoutePlanInput(row.route_plan || row.routePlan || null),
    registry: row.registry && typeof row.registry === "object" ? row.registry : null,
    preferred_roles: normalizeStringList(row.preferred_roles ?? row.preferredRoles ?? [], {
      lower: true,
      max: 12,
    }),
    max_agents: normalizeInteger(row.max_agents ?? row.maxAgents, {
      fallback: 6,
      min: 1,
      max: 12,
    }),
    run_id: normalizeText(row.run_id || row.runId),
    job_id: normalizeText(row.job_id || row.jobId),
    runs_dir: normalizeText(row.runs_dir || row.runsDir),
    persist_skill_events: normalizeBoolean(row.persist_skill_events ?? row.persistSkillEvents),
  };
}

function buildInterpretedTask(request = {}) {
  const routePlan = normalizeRoutePlanInput(request.route_plan);
  const requestedActions = asArray(routePlan?.actions);
  return {
    mode: request.mode,
    goal: request.goal,
    seed_instruction: request.seed_instruction || undefined,
    preferred_roles: request.preferred_roles,
    max_agents: request.max_agents,
    has_route_recommendation: !!routePlan,
    requested_action_count: requestedActions.length,
    route_reason_hint: normalizeText(routePlan?.reason) || undefined,
    run_id: request.run_id || undefined,
    job_id: request.job_id || undefined,
  };
}

export function normalizePlanningResult(raw = {}, {
  request = null,
  source = "local",
  planner_type = "local",
} = {}) {
  const row = asObject(raw);
  const normalizedRequest = request ? normalizePlanningRequest(request) : null;
  const routePlan = normalizeRoutePlan(row.route_plan || row.routePlan || {});
  const runtimeAgents = asArray(row.runtime_agents || row.runtimeAgents);
  const contextPacks = asArray(row.context_packs || row.contextPacks);
  const selectedSkillIds = normalizeStringList(
    row.selected_skill_ids || row.selectedSkillIds || [],
    { lower: true, max: 64 }
  );
  const missingRoles = normalizeStringList(row.missing_roles || row.missingRoles || [], {
    lower: true,
    max: 16,
  });
  const planSource = normalizePlanSource(
    row.plan_source || row.planSource || source,
    { fallback: source }
  );
  const interpretedTask = normalizedRequest
    ? buildInterpretedTask(normalizedRequest)
    : {
      mode: routePlan.mode || "run",
      goal: normalizeText(row.goal),
      seed_instruction: undefined,
      preferred_roles: [],
      max_agents: undefined,
      has_route_recommendation: false,
      requested_action_count: 0,
      route_reason_hint: undefined,
      run_id: undefined,
      job_id: undefined,
    };
  const routeSummary = {
    mode: routePlan.mode || interpretedTask.mode || "run",
    reason: routePlan.reason || undefined,
    action_source: normalizeActionSource(routePlan.action_source, {
      fallback: routePlan.actions.length > 0 ? "default_fallback_route" : "",
    }) || undefined,
    action_count: routePlan.actions.length,
    done: routePlan.done === true,
    await_user: routePlan.await_user === true,
  };
  const plannerMetadata = {
    planner_type,
    plan_source: planSource,
    has_route_recommendation: interpretedTask.has_route_recommendation === true,
    selected_skill_count: selectedSkillIds.length,
    context_pack_count: contextPacks.length,
    runtime_agent_count: runtimeAgents.length,
    missing_roles: missingRoles,
    action_count: routeSummary.action_count,
  };

  return {
    plan_source: planSource,
    interpreted_task: interpretedTask,
    route_summary: routeSummary,
    planner_metadata: plannerMetadata,
    route_plan: {
      ...routePlan,
      action_source: routeSummary.action_source || routePlan.action_source || undefined,
    },
    team_plan: row.team_plan && typeof row.team_plan === "object"
      ? row.team_plan
      : (row.teamPlan && typeof row.teamPlan === "object" ? row.teamPlan : null),
    runtime_agents: runtimeAgents,
    runtime_team_snapshot: row.runtime_team_snapshot && typeof row.runtime_team_snapshot === "object"
      ? row.runtime_team_snapshot
      : (row.runtimeTeamSnapshot && typeof row.runtimeTeamSnapshot === "object" ? row.runtimeTeamSnapshot : null),
    context_packs: contextPacks,
    selected_skill_ids: selectedSkillIds,
    skill_load_levels: normalizeObjectMap(row.skill_load_levels || row.skillLoadLevels),
    selection_reason_summary: normalizeObjectMap(row.selection_reason_summary || row.selectionReasonSummary),
    skill_usage_events: asArray(row.skill_usage_events || row.skillUsageEvents),
    skill_usage_summary: normalizeObjectMap(row.skill_usage_summary || row.skillUsageSummary),
    missing_roles: missingRoles,
  };
}

export class LocalPlanner {
  constructor({
    resolveAgentId = null,
    source = "local",
    orchestrationBuilder = buildRuntimeOrchestration,
  } = {}) {
    this.source = normalizePlanSource(source, { fallback: "local" });
    this.resolveAgentId = typeof resolveAgentId === "function" ? resolveAgentId : null;
    this.orchestrationBuilder = typeof orchestrationBuilder === "function"
      ? orchestrationBuilder
      : buildRuntimeOrchestration;
  }

  plan(input = {}) {
    const request = normalizePlanningRequest(input);
    const effectiveRequest = {
      ...request,
      run_id: request.run_id || `plan_${Date.now().toString(36)}`,
    };
    const orchestration = this.orchestrationBuilder({
      mode: effectiveRequest.mode,
      goal: effectiveRequest.goal,
      seedInstruction: effectiveRequest.seed_instruction,
      routePlan: effectiveRequest.route_plan,
      registry: effectiveRequest.registry,
      preferredRoles: effectiveRequest.preferred_roles,
      maxAgents: effectiveRequest.max_agents,
      resolveAgentId: this.resolveAgentId,
      runId: effectiveRequest.run_id,
      jobId: effectiveRequest.job_id,
      runsDir: effectiveRequest.runs_dir,
      persistSkillEvents: effectiveRequest.persist_skill_events,
    });
    return normalizePlanningResult({
      ...orchestration,
      plan_source: this.source,
    }, {
      request: effectiveRequest,
      source: this.source,
      planner_type: "local",
    });
  }
}
