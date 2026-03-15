import test from "node:test";
import assert from "node:assert/strict";

import { mapTeamPlanToRouteActions } from "../src/control_plane/execution_coordinator.js";

test("parallel groups compile into spawn_parallel actions with canonical worker ids", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_research_1", role_id: "researcher", purpose: "Collect filings", parallelizable: true },
        { slot_id: "slot_research_2", role_id: "researcher", purpose: "Collect news", parallelizable: true },
        { slot_id: "slot_reviewer_1", role_id: "reviewer", purpose: "Cross-check evidence", parallelizable: false },
      ],
      execution_graph: {
        order: ["slot_research_1", "slot_research_2", "slot_reviewer_1"],
        edges: [
          { from_slot_id: "slot_research_1", to_slot_id: "slot_reviewer_1", relation: "precedes" },
          { from_slot_id: "slot_research_2", to_slot_id: "slot_reviewer_1", relation: "precedes" },
        ],
        parallel_groups: [
          { parallel_group_id: "parallel_group_research", slot_ids: ["slot_research_1", "slot_research_2"] },
        ],
      },
    },
    runtime_agents: [
      { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher" },
      { instance_id: "inst_research_2", slot_id: "slot_research_2", role_id: "researcher" },
      { instance_id: "inst_reviewer_1", slot_id: "slot_reviewer_1", role_id: "reviewer" },
    ],
  }, {
    mode: "run",
    goal: "Gather two independent evidence streams and review them",
  });

  const parallel = actions.find((action) => action.type === "spawn_parallel");
  assert.ok(parallel);
  assert.equal(parallel.inputs.parallel_group_id, "parallel_group_research");
  assert.deepEqual(parallel.agents.map((child) => child.agent), ["researcher", "researcher"]);
  assert.equal(parallel.agents.every((child) => child.inputs.runtime_instance_id.startsWith("inst_research_")), true);
});
