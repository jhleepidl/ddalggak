import test from "node:test";
import assert from "node:assert/strict";

import { mapTeamPlanToRouteActions } from "../src/control_plane/execution_coordinator.js";

test("checkpoints and final synthesis compile into executable route steps", () => {
  const actions = mapTeamPlanToRouteActions({
    team_plan: {
      slots: [
        { slot_id: "slot_builder_1", role_id: "builder", purpose: "Implement fix", parallelizable: false },
        { slot_id: "slot_reviewer_1", role_id: "reviewer", purpose: "Review fix", parallelizable: false },
        { slot_id: "slot_synth_1", role_id: "synthesizer", purpose: "Summarize final result", parallelizable: false },
      ],
      checkpoints: [
        {
          checkpoint_id: "checkpoint_review_gate",
          label: "Review Gate",
          target_slot_ids: ["slot_reviewer_1"],
          trigger_after_instances: ["inst_reviewer_1"],
          approval_required: true,
          human_interrupt_allowed: true,
        },
      ],
      supervisor_runtime: {
        enabled: true,
        instance_id: "supervisor_runtime",
        interaction_mode: "checkpointed_supervised",
        authority_profile_id: "supervisor_controlled",
      },
      execution_graph: {
        order: ["slot_builder_1", "slot_reviewer_1", "slot_synth_1"],
        edges: [
          { from_slot_id: "slot_builder_1", to_slot_id: "slot_reviewer_1", relation: "precedes" },
          { from_slot_id: "slot_reviewer_1", to_slot_id: "slot_synth_1", relation: "precedes" },
        ],
      },
    },
    runtime_agents: [
      { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder" },
      { instance_id: "inst_reviewer_1", slot_id: "slot_reviewer_1", role_id: "reviewer" },
      { instance_id: "inst_synth_1", slot_id: "slot_synth_1", role_id: "synthesizer" },
    ],
  }, {
    mode: "run",
    goal: "Implement, review, then summarize",
  });

  assert.equal(actions.some((action) => action.type === "checkpoint"), true);
  assert.equal(actions.some((action) => action.type === "supervisor_decision"), true);
  const synthesis = actions.find((action) => action.type === "synthesize_final");
  assert.ok(synthesis);
  assert.equal(synthesis.agent, "synthesizer");
});
