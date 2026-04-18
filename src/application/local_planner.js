import { buildRuntimeOrchestration } from "./orchestrator.js";
import { normalizeRoutePlan as normalizeCanonicalRoutePlan } from "../domain/route_plan.js";

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
  if (!raw || typeof raw !== "object") return null;
  return normalizeCanonicalRoutePlan(raw, {
    maxActions: 8,
  });
}

function buildCompatibilityInterpretedTask({
  interpretedTask = {},
  request = null,
  routePlan = null,
} = {}) {
  const normalizedRequest = request ? normalizePlanningRequest(request) : null;
  const normalizedRoutePlan = routePlan && typeof routePlan === "object"
    ? routePlan
    : normalizeRoutePlanInput(normalizedRequest?.route_plan);
  const requestedActions = asArray(normalizedRoutePlan?.actions);
  return {
    ...(interpretedTask && typeof interpretedTask === "object" ? interpretedTask : {}),
    mode: normalizeMode(
      interpretedTask?.mode || interpretedTask?.operating_mode || normalizedRequest?.mode,
      { fallback: "run" }
    ),
    goal: normalizeText(interpretedTask?.goal || normalizedRequest?.goal),
    has_route_recommendation: !!normalizedRequest?.route_plan,
    requested_action_count: requestedActions.length,
    route_reason_hint: normalizeText(
      interpretedTask?.route_reason_hint || normalizedRoutePlan?.reason
    ) || undefined,
    run_id: normalizeText(interpretedTask?.run_id || normalizedRequest?.run_id) || undefined,
    job_id: normalizeText(interpretedTask?.job_id || normalizedRequest?.job_id) || undefined,
  };
}

export function normalizePlanningRequest(input = {}) {
  const row = asObject(input);
  return {
    mode: normalizeMode(row.mode, { fallback: "run" }),
    goal: normalizeText(row.goal || row.task || row.message),
    task: normalizeText(row.task || row.goal || row.message),
    message: normalizeText(row.message || row.goal || row.task),
    seed_instruction: normalizeText(row.seed_instruction || row.seedInstruction),
    route_plan: normalizeRoutePlanInput(row.route_plan || row.routePlan || null),
    registry: row.registry && typeof row.registry === "object" ? row.registry : null,
    preferred_roles: normalizeStringList(row.preferred_roles ?? row.preferredRoles ?? [], {
      lower: true,
      max: 12,
    }),
    conversation_preferences: row.conversation_preferences && typeof row.conversation_preferences === "object"
      ? row.conversation_preferences
      : (row.conversationPreferences && typeof row.conversationPreferences === "object"
        ? row.conversationPreferences
        : null),
    active_team: row.active_team && typeof row.active_team === "object"
      ? row.active_team
      : (row.activeTeam && typeof row.activeTeam === "object" ? row.activeTeam : null),
    runtime_team_snapshot: row.runtime_team_snapshot && typeof row.runtime_team_snapshot === "object"
      ? row.runtime_team_snapshot
      : (row.runtimeTeamSnapshot && typeof row.runtimeTeamSnapshot === "object" ? row.runtimeTeamSnapshot : null),
    conversation_hints: normalizeStringList(
      row.conversation_hints ?? row.conversationHints ?? [],
      { lower: false, max: 24 }
    ),
    tool_hints: normalizeStringList(
      row.tool_hints ?? row.toolHints ?? row.available_tool_ids ?? row.availableToolIds ?? [],
      { lower: true, max: 24 }
    ),
    max_agents: normalizeInteger(row.max_agents ?? row.maxAgents, {
      fallback: 6,
      min: 1,
      max: 12,
    }),
    run_id: normalizeText(row.run_id || row.runId),
    job_id: normalizeText(row.job_id || row.jobId),
    runs_dir: normalizeText(row.runs_dir || row.runsDir),
    persist_skill_events: normalizeBoolean(row.persist_skill_events ?? row.persistSkillEvents),
    runtime_policy: row.runtime_policy && typeof row.runtime_policy === 'object'
      ? row.runtime_policy
      : (row.runtimePolicy && typeof row.runtimePolicy === 'object' ? row.runtimePolicy : null),
    runtime_behavior: row.runtime_behavior && typeof row.runtime_behavior === 'object'
      ? row.runtime_behavior
      : (row.runtimeBehavior && typeof row.runtimeBehavior === 'object' ? row.runtimeBehavior : null),
    runtime_session_state: row.runtime_session_state && typeof row.runtime_session_state === 'object'
      ? row.runtime_session_state
      : (row.runtimeSessionState && typeof row.runtimeSessionState === 'object' ? row.runtimeSessionState : null),
  };
}

export function normalizePlanningResult(raw = {}, {
  request = null,
  source = "local",
  planner_type = "local",
} = {}) {
  const row = asObject(raw);
  const normalizedRequest = request ? normalizePlanningRequest(request) : null;
  const routePlan = normalizeRoutePlanInput(row.route_plan || row.routePlan || normalizedRequest?.route_plan || {});
  const runtimeAgents = asArray(row.runtime_agents || row.runtimeAgents);
  const contextPacks = asArray(row.context_packs || row.contextPacks);
  const selectedSkillIds = normalizeStringList(
    row.selected_skill_ids || row.selectedSkillIds || [],
    { lower: true, max: 128 }
  );
  const missingRoles = normalizeStringList(row.missing_roles || row.missingRoles || [], {
    lower: true,
    max: 24,
  });
  const planSource = normalizePlanSource(
    row.plan_source || row.planSource || source,
    { fallback: source }
  );
  const interpretedTask = buildCompatibilityInterpretedTask({
    interpretedTask: row.interpreted_task || row.interpretedTask || {},
    request: normalizedRequest,
    routePlan,
  });
  const routeSummary = {
    mode: routePlan?.mode || interpretedTask.mode || "run",
    reason: routePlan?.reason || undefined,
    action_source: normalizeActionSource(routePlan?.action_source, {
      fallback: routePlan?.actions?.length > 0 ? "default_fallback_route" : "",
    }) || undefined,
    action_count: asArray(routePlan?.actions).length,
    done: routePlan?.done === true,
    await_user: routePlan?.await_user === true,
  };
  const plannerMetadata = row.planner_metadata && typeof row.planner_metadata === "object"
    ? {
      ...row.planner_metadata,
      planner_type: normalizeText(row.planner_metadata.planner_type || planner_type) || planner_type,
      plan_source: normalizePlanSource(row.planner_metadata.plan_source || planSource, {
        fallback: planSource,
      }),
    }
    : {
      planner_type,
      plan_source: planSource,
      pipeline_version: "control_plane_v2",
      control_mode: normalizeText(interpretedTask.control_mode, { lower: true }) || undefined,
      selected_skill_count: selectedSkillIds.length,
      context_pack_count: contextPacks.length,
      runtime_agent_count: runtimeAgents.length,
      missing_roles: missingRoles,
      action_count: routeSummary.action_count,
      action_source: routeSummary.action_source,
    };

  const result = {
    plan_source: planSource,
    interpreted_task: interpretedTask,
    route_summary: routeSummary,
    planner_metadata: plannerMetadata,
    route_plan: {
      ...routePlan,
      action_source: routeSummary.action_source || routePlan?.action_source || undefined,
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
  };
  if (missingRoles.length > 0) result.missing_roles = missingRoles;
  return result;
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
      task: effectiveRequest.task,
      message: effectiveRequest.message,
      seedInstruction: effectiveRequest.seed_instruction,
      routePlan: effectiveRequest.route_plan,
      registry: effectiveRequest.registry,
      preferredRoles: effectiveRequest.preferred_roles,
      conversationPreferences: effectiveRequest.conversation_preferences,
      activeTeam: effectiveRequest.active_team,
      runtimeTeamSnapshot: effectiveRequest.runtime_team_snapshot,
      conversationHints: effectiveRequest.conversation_hints,
      toolHints: effectiveRequest.tool_hints,
      maxAgents: effectiveRequest.max_agents,
      resolveAgentId: this.resolveAgentId,
      runId: effectiveRequest.run_id,
      jobId: effectiveRequest.job_id,
      runsDir: effectiveRequest.runs_dir,
      persistSkillEvents: effectiveRequest.persist_skill_events,
      planSource: this.source,
      plannerType: "local",
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
