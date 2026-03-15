import test from "node:test";
import assert from "node:assert/strict";

import { mapTeamPlanToRouteActions } from "../src/control_plane/execution_coordinator.js";

test("sequential preference avoids casual spawn_parallel for near-identical slots", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_research_1", role_id: "researcher", purpose: "Research task", parallelizable: true },
        { slot_id: "slot_research_2", role_id: "researcher", purpose: "Research task", parallelizable: true },
      ],
      execution_graph: {
        order: ["slot_research_1", "slot_research_2"],
        parallel_groups: [{ parallel_group_id: "parallel_group_1", slot_ids: ["slot_research_1", "slot_research_2"] }],
      },
    },
    runtime_agents: [
      { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher" },
      { instance_id: "inst_research_2", slot_id: "slot_research_2", role_id: "researcher" },
    ],
  }, {
    mode: "run",
    goal: "Do the research sequentially",
    taskInterpretation: {
      parallelism_preference: "sequential",
    },
  });

  assert.equal(actions.some((action) => action.type === "spawn_parallel"), false);
});

test("sequential preference override records a reason for differentiated independent slots", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        {
          slot_id: "slot_research_filings",
          role_id: "researcher",
          purpose: "Collect filing evidence",
          required_context_types: ["filings"],
          parallelizable: true,
          selection_reason: "multi-source filing lane",
        },
        {
          slot_id: "slot_research_news",
          role_id: "researcher",
          purpose: "Collect market news evidence",
          required_context_types: ["news"],
          parallelizable: true,
          selection_reason: "multi-source news lane",
        },
      ],
      execution_graph: {
        order: ["slot_research_filings", "slot_research_news"],
        parallel_groups: [{ parallel_group_id: "parallel_group_1", slot_ids: ["slot_research_filings", "slot_research_news"] }],
      },
    },
    runtime_agents: [
      { instance_id: "inst_research_filings", slot_id: "slot_research_filings", role_id: "researcher" },
      { instance_id: "inst_research_news", slot_id: "slot_research_news", role_id: "researcher" },
    ],
  }, {
    mode: "run",
    goal: "Compare filings and market news",
    taskInterpretation: {
      parallelism_preference: "sequential",
    },
  });

  const parallelAction = actions.find((action) => action.type === "spawn_parallel");
  assert.ok(parallelAction);
  assert.equal(
    String(parallelAction.metadata?.parallelism_override_reason || "").includes("parallelism_preference=sequential"),
    true
  );
});
