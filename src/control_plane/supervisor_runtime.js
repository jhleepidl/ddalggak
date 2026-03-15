function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeInteractionMode(raw = "") {
  const value = normalizeText(raw).toLowerCase();
  if ([
    "manager_as_tool",
    "checkpointed_supervised",
    "passive_observer",
  ].includes(value)) {
    return value;
  }
  if (value === "checkpointed") return "checkpointed_supervised";
  return "manager_as_tool";
}

export function normalizeSupervisorRuntime(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const enabled = row.enabled !== false;
  const interactionMode = normalizeInteractionMode(
    row.interaction_mode || row.interactionMode || row.coordination_mode || row.coordinationMode || row.mode
  );
  return {
    enabled,
    runtime_id: normalizeText(row.runtime_id || row.runtimeId || "local_control_plane") || "local_control_plane",
    instance_id: normalizeText(
      row.instance_id || row.instanceId || row.runtime_id || row.runtimeId || "supervisor_runtime"
    ) || "supervisor_runtime",
    coordination_mode: normalizeText(row.coordination_mode || row.coordinationMode || row.mode || "centralized") || "centralized",
    interaction_mode: interactionMode,
    planner_requested: row.planner_requested === true || row.plannerRequested === true,
    max_parallel_workers: Number.isFinite(Number(row.max_parallel_workers ?? row.maxParallelWorkers))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.max_parallel_workers ?? row.maxParallelWorkers))))
      : 3,
    authority_profile_id: normalizeText(
      row.authority_profile_id || row.authorityProfileId || "supervisor_controlled"
    ).toLowerCase() || "supervisor_controlled",
    user_visible: row.user_visible === true || row.userVisible === true,
    control_actions: Array.isArray(row.control_actions)
      ? row.control_actions.map((entry) => normalizeText(entry).toLowerCase()).filter(Boolean)
      : [
        "launch_children",
        "receive_reports",
        "request_human_approval",
        "pause_children",
        "cancel_child",
        "reroute_child",
        "emit_intermediate_summaries",
      ],
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
  };
}

export function createSupervisorRuntime(raw = {}) {
  return normalizeSupervisorRuntime(raw);
}
