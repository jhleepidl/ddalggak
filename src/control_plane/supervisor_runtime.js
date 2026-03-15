function normalizeText(raw = "") {
  return String(raw || "").trim();
}

export function normalizeSupervisorRuntime(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  return {
    runtime_id: normalizeText(row.runtime_id || row.runtimeId || "local_control_plane") || "local_control_plane",
    coordination_mode: normalizeText(row.coordination_mode || row.coordinationMode || row.mode || "centralized") || "centralized",
    planner_requested: row.planner_requested === true || row.plannerRequested === true,
    max_parallel_workers: Number.isFinite(Number(row.max_parallel_workers ?? row.maxParallelWorkers))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.max_parallel_workers ?? row.maxParallelWorkers))))
      : 3,
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
  };
}

export function createSupervisorRuntime(raw = {}) {
  return normalizeSupervisorRuntime(raw);
}
