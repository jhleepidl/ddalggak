function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function wasInterruptedByReplan({
  results = [],
  remainingActions = [],
  pendingApproval = null,
} = {}) {
  if (pendingApproval) return false;
  const interrupted = asArray(results).some((row) => {
    const label = String(row?.label || "").trim().toLowerCase();
    const status = String(row?.status || "").trim().toLowerCase();
    const note = String(row?.note || "").trim().toLowerCase();
    return label === "interrupt" || (status === "skip" && note.includes("replan requested"));
  });
  return interrupted || asArray(remainingActions).length > 0;
}

export async function markActionsSkipped(executionGraph = null, actions = [], {
  reason = "superseded",
} = {}) {
  if (!executionGraph || typeof executionGraph.markStepSkipped !== "function") return;
  for (const action of asArray(actions)) {
    await executionGraph.markStepSkipped(action, {
      reason: String(reason || "superseded"),
    });
  }
}

