import test from "node:test";
import assert from "node:assert/strict";

import { buildCollaborationCells } from "../src/control_plane/collaboration_policy.js";

test("collaboration policy emits reflection, parallel fanout, and manager-as-tool cells", () => {
  const cells = buildCollaborationCells({
    runtimeAgents: [
      { instance_id: "inst_research_1", role_id: "researcher" },
      { instance_id: "inst_research_2", role_id: "researcher" },
      { instance_id: "inst_builder_1", role_id: "builder" },
      { instance_id: "inst_reviewer_1", role_id: "reviewer" },
      { instance_id: "inst_synth_1", role_id: "synthesizer" },
    ],
    supervisorRuntime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      interaction_mode: "manager_as_tool",
      user_visible: true,
    },
  });

  assert.equal(cells.some((cell) => cell.pattern === "parallel_fanout"), true);
  assert.equal(cells.some((cell) => cell.pattern === "reflection"), true);
  assert.equal(cells.some((cell) => cell.pattern === "manager_as_tool"), true);

  const managerCell = cells.find((cell) => cell.pattern === "manager_as_tool");
  assert.equal(managerCell.report_back_to_instance_id, "supervisor_runtime");
});
