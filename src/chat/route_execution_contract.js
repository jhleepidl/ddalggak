import { evaluateActionAuthority } from "../application/run_authority.js";
import { createRuntimeTeamSnapshot } from "../application/runtime_metadata.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function isSpawnAction(action = {}) {
  const type = String(action?.type || "").trim().toLowerCase();
  return type === "spawn_agents" || type === "spawn_parallel";
}

function buildSequentialRunActionsFromSpawn(action = {}, reason = "") {
  const type = String(action?.type || "").trim().toLowerCase();
  const summary = String(action?.summary || action?.label || action?.prompt || action?.goal || "").trim();
  const children = Array.isArray(action?.agents) ? action.agents : [];
  const actions = [];

  for (const child of children) {
    const row = asObject(child);
    const agentId = String(row.agent_id || row.agent || row.agentId || "").trim().toLowerCase();
    const goal = String(row.goal || row.prompt || row.task || "").trim();
    if (!agentId || !goal) continue;
    const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
    actions.push({
      type: "run_agent",
      agent_id: agentId,
      goal,
      inputs: {
        ...inputs,
        degraded_from_parallel_spawn: true,
        degraded_from_action_type: type,
        degraded_from_summary: summary || undefined,
        degraded_reason: reason || undefined,
      },
      scope: row.scope ?? row.lens ?? action?.scope ?? action?.lens,
      lens: row.lens ?? row.scope ?? action?.lens ?? action?.scope,
      risk: row.risk || action?.risk || "L1",
      degraded_from_spawn: {
        action_type: type,
        summary: summary || undefined,
        reason: reason || undefined,
      },
    });
  }

  return actions;
}

export function canParallelSpawnInRuntime({
  runtimeSnapshot = null,
  childCount = 2,
} = {}) {
  const safeChildCount = Number.isFinite(Number(childCount))
    ? Math.max(1, Math.min(8, Math.floor(Number(childCount))))
    : 2;
  const action = {
    type: "spawn_agents",
    agents: Array.from({ length: safeChildCount }, (_, index) => ({
      agent_id: `worker_${index + 1}`,
      goal: `parallel child ${index + 1}`,
    })),
  };
  const authority = evaluateActionAuthority({
    action,
    runtimeSnapshot,
  });
  if (!authority.enforced) return true;
  return authority.execute_allowed === true && authority.requires_approval !== true;
}

export function sanitizeExecutablePlan({
  plan = null,
  runtimeSnapshot = null,
} = {}) {
  const sourcePlan = plan && typeof plan === "object" ? plan : {};
  const sourceActions = Array.isArray(sourcePlan.actions) ? sourcePlan.actions : [];
  const sanitizedActions = [];
  const notes = [];

  for (const action of sourceActions) {
    if (!isSpawnAction(action)) {
      sanitizedActions.push(action);
      continue;
    }

    const authority = evaluateActionAuthority({
      action,
      runtimeSnapshot,
    });
    const blocked = authority.enforced && (authority.execute_allowed !== true || authority.requires_approval === true);
    const sequentialActions = buildSequentialRunActionsFromSpawn(
      action,
      authority.reasons.join("; ") || "parallel spawn unavailable"
    );
    if (!blocked || sequentialActions.length === 0) {
      sanitizedActions.push(action);
      continue;
    }

    notes.push({
      type: "parallel_spawn_downgraded",
      action_type: String(action?.type || "").trim().toLowerCase() || "spawn_agents",
      summary: String(action?.summary || action?.label || action?.prompt || action?.goal || "").trim(),
      child_count: sequentialActions.length,
      reason: authority.reasons.join("; ") || "parallel spawn unavailable",
    });
    sanitizedActions.push(...sequentialActions);
  }

  return {
    plan: {
      ...sourcePlan,
      actions: sanitizedActions,
      execution_contract_notes: [
        ...(Array.isArray(sourcePlan.execution_contract_notes) ? sourcePlan.execution_contract_notes : []),
        ...notes,
      ],
    },
    notes,
  };
}

export function mergePreferredRuntimeTeamSnapshot({
  baseSnapshot = null,
  routePlan = null,
  runtimeAuthority = null,
  source = "team_builder",
} = {}) {
  const normalizedBase = baseSnapshot && typeof baseSnapshot === "object"
    ? createRuntimeTeamSnapshot({
      runtime_team_snapshot: baseSnapshot,
      source,
    })
    : null;
  const route = routePlan && typeof routePlan === "object" ? routePlan : {};
  const routeSnapshotPatch = route?.runtime_team_snapshot && typeof route.runtime_team_snapshot === "object"
    ? route.runtime_team_snapshot
    : {
      ...(route?.task_interpretation ? { task_interpretation: route.task_interpretation } : {}),
      ...(route?.team_plan ? { team_plan: route.team_plan } : {}),
      ...(Array.isArray(route?.runtime_agents) && route.runtime_agents.length > 0 ? { runtime_agents: route.runtime_agents } : {}),
      ...(Array.isArray(route?.context_packs) && route.context_packs.length > 0 ? { context_packs: route.context_packs } : {}),
      ...(Array.isArray(route?.scope_specs) && route.scope_specs.length > 0 ? { scope_specs: route.scope_specs } : {}),
      ...(Array.isArray(route?.materialized_scopes) && route.materialized_scopes.length > 0 ? { materialized_scopes: route.materialized_scopes } : {}),
      ...(Array.isArray(route?.visibility_graph) && route.visibility_graph.length > 0 ? { visibility_graph: route.visibility_graph } : {}),
      ...(route?.context_runtime_mode ? { context_runtime_mode: route.context_runtime_mode } : {}),
      ...(Array.isArray(route?.collaboration_cells) && route.collaboration_cells.length > 0 ? { collaboration_cells: route.collaboration_cells } : {}),
      ...(Array.isArray(route?.authority_graph) && route.authority_graph.length > 0 ? { authority_graph: route.authority_graph } : {}),
      ...(Array.isArray(route?.checkpoints) && route.checkpoints.length > 0 ? { checkpoints: route.checkpoints } : {}),
      ...(route?.execution_graph && typeof route.execution_graph === "object" && Object.keys(route.execution_graph).length > 0 ? { execution_graph: route.execution_graph } : {}),
      ...(Array.isArray(route?.selection_explanations) && route.selection_explanations.length > 0 ? { selection_explanations: route.selection_explanations } : {}),
      ...(Array.isArray(route?.selected_skill_ids) && route.selected_skill_ids.length > 0 ? { selected_skill_ids: route.selected_skill_ids } : {}),
      ...(route?.skill_load_levels && typeof route.skill_load_levels === "object" && Object.keys(route.skill_load_levels).length > 0 ? { skill_load_levels: route.skill_load_levels } : {}),
      ...(route?.selection_reason_summary && typeof route.selection_reason_summary === "object" && Object.keys(route.selection_reason_summary).length > 0 ? { selection_reason_summary: route.selection_reason_summary } : {}),
      ...(Array.isArray(route?.skill_usage_events) && route.skill_usage_events.length > 0 ? { skill_usage_events: route.skill_usage_events } : {}),
      ...(route?.skill_usage_summary && typeof route.skill_usage_summary === "object" && Object.keys(route.skill_usage_summary).length > 0 ? { skill_usage_summary: route.skill_usage_summary } : {}),
      ...(route?.supervisor_runtime && typeof route.supervisor_runtime === "object" ? { supervisor_runtime: route.supervisor_runtime } : {}),
    };

  return createRuntimeTeamSnapshot({
    runtime_team_snapshot: {
      ...(normalizedBase && typeof normalizedBase === "object" ? normalizedBase : {}),
      ...(routeSnapshotPatch && typeof routeSnapshotPatch === "object" ? routeSnapshotPatch : {}),
      ...(runtimeAuthority ? { runtime_authority: runtimeAuthority } : {}),
      source,
    },
    source,
  });
}
