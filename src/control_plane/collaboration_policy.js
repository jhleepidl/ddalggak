import { normalizeCollaborationCellList } from "../domain/collaboration_cell.js";

function byRole(runtimeAgents = [], roleId = "") {
  return runtimeAgents.find((agent) => String(agent?.role_id || "").trim().toLowerCase() === roleId);
}

export function buildCollaborationCells({
  runtimeAgents = [],
} = {}) {
  const cells = [];
  const researcher = byRole(runtimeAgents, "researcher");
  const builder = byRole(runtimeAgents, "builder");
  const reviewer = byRole(runtimeAgents, "reviewer");
  const synthesizer = byRole(runtimeAgents, "synthesizer");
  const operator = byRole(runtimeAgents, "operator");

  if (researcher && builder) {
    cells.push({
      cell_id: "cell_research_to_build",
      pattern: "handoff",
      member_instance_ids: [researcher.instance_id, builder.instance_id],
      topology: "pipeline",
      max_rounds: 1,
      termination: { condition: "builder_started" },
    });
  }
  if (builder && reviewer) {
    cells.push({
      cell_id: "cell_build_review_loop",
      pattern: "review_loop",
      member_instance_ids: [builder.instance_id, reviewer.instance_id],
      topology: "pair",
      max_rounds: 2,
      termination: { condition: "review_accepted" },
      visibility: "internal",
    });
  }
  if (reviewer && synthesizer) {
    cells.push({
      cell_id: "cell_review_to_synthesis",
      pattern: "handoff",
      member_instance_ids: [reviewer.instance_id, synthesizer.instance_id],
      topology: "pipeline",
      max_rounds: 1,
      termination: { condition: "summary_ready" },
    });
  }
  if (operator) {
    const others = runtimeAgents
      .filter((agent) => agent.instance_id !== operator.instance_id)
      .map((agent) => agent.instance_id);
    if (others.length > 0) {
      cells.push({
        cell_id: "cell_operator_guardrail",
        pattern: "oversight",
        member_instance_ids: [operator.instance_id, ...others].slice(0, 5),
        topology: "hub",
        max_rounds: 1,
        termination: { condition: "checkpoints_registered" },
        visibility: "internal",
      });
    }
  }

  return normalizeCollaborationCellList(cells);
}
