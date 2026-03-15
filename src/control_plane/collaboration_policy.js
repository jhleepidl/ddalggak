import { normalizeCollaborationCellList } from "../domain/collaboration_cell.js";

function byRole(runtimeAgents = [], roleId = "") {
  return runtimeAgents.find((agent) => String(agent?.role_id || "").trim().toLowerCase() === roleId);
}

export function buildCollaborationCells({
  runtimeAgents = [],
  supervisorRuntime = null,
} = {}) {
  const cells = [];
  const researchers = runtimeAgents
    .filter((agent) => String(agent?.role_id || "").trim().toLowerCase() === "researcher");
  const researcher = researchers[0] || null;
  const builder = byRole(runtimeAgents, "builder");
  const reviewer = byRole(runtimeAgents, "reviewer");
  const synthesizer = byRole(runtimeAgents, "synthesizer");

  if (researchers.length > 1) {
    cells.push({
      cell_id: "cell_parallel_research_fanout",
      pattern: "parallel_fanout",
      member_instance_ids: researchers.map((agent) => agent.instance_id).filter(Boolean).slice(0, 6),
      topology: "fanout",
      max_rounds: 1,
      termination: { condition: "research_reports_ready" },
      target_instance_ids: [reviewer?.instance_id, synthesizer?.instance_id].filter(Boolean),
      visibility: "shared",
      selection_reason: "multiple researcher instances present",
    });
  }
  if (researcher && builder && !reviewer) {
    cells.push({
      cell_id: "cell_research_to_build",
      pattern: "handoff",
      member_instance_ids: [researcher.instance_id, builder.instance_id],
      topology: "pipeline",
      max_rounds: 1,
      termination: { condition: "builder_started" },
      selection_reason: "research feeds build execution",
    });
  }
  if (builder && reviewer) {
    cells.push({
      cell_id: "cell_builder_reviewer_reflection",
      pattern: "reflection",
      member_instance_ids: [builder.instance_id, reviewer.instance_id],
      topology: "pair",
      max_rounds: 2,
      termination: { condition: "review_accepted" },
      visibility: "internal",
      selection_reason: "builder changes require bounded review reflection",
    });
  }
  if (researcher && reviewer) {
    cells.push({
      cell_id: "cell_research_review_reflection",
      pattern: "reflection",
      member_instance_ids: [researcher.instance_id, reviewer.instance_id],
      topology: "pair",
      max_rounds: 2,
      termination: { condition: "claims_validated" },
      visibility: "shared",
      selection_reason: "claim-heavy research benefits from skeptical review",
    });
  }
  if (reviewer && synthesizer && !cells.some((cell) => cell.cell_id === "cell_parallel_research_fanout")) {
    cells.push({
      cell_id: "cell_review_to_synthesis",
      pattern: "handoff",
      member_instance_ids: [reviewer.instance_id, synthesizer.instance_id],
      topology: "pipeline",
      max_rounds: 1,
      termination: { condition: "summary_ready" },
      selection_reason: "reviewer output is passed to synthesis",
    });
  }
  if (supervisorRuntime?.enabled === true) {
    const supervisedIds = runtimeAgents.map((agent) => agent.instance_id).filter(Boolean).slice(0, 8);
    if (supervisedIds.length > 0) {
      cells.push({
        cell_id: "cell_supervisor_manager_tool",
        pattern: "manager_as_tool",
        member_instance_ids: supervisedIds,
        topology: "hub",
        max_rounds: 1,
        termination: { condition: "children_completed_or_interrupted" },
        report_back_to_instance_id: supervisorRuntime.instance_id,
        visibility: supervisorRuntime.user_visible === true ? "shared" : "internal",
        selection_reason: `supervisor:${supervisorRuntime.interaction_mode || "manager_as_tool"}`,
      });
    }
  }

  return normalizeCollaborationCellList(cells);
}
