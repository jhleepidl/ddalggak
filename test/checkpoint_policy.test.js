import test from "node:test";
import assert from "node:assert/strict";

import { buildExecutionCheckpoints } from "../src/control_plane/checkpoint_policy.js";

test("checkpoint policy emits interrupt-ready review and synthesis checkpoints", () => {
  const checkpoints = buildExecutionCheckpoints({
    slots: [
      { slot_id: "slot_review_1", role_id: "reviewer" },
      { slot_id: "slot_synth_1", role_id: "synthesizer" },
    ],
    runtimeAgents: [
      { instance_id: "inst_review_1", slot_id: "slot_review_1", role_id: "reviewer" },
      { instance_id: "inst_synth_1", slot_id: "slot_synth_1", role_id: "synthesizer" },
    ],
    collaborationCells: [
      {
        cell_id: "cell_reflection",
        pattern: "reflection",
        member_instance_ids: ["inst_review_1"],
      },
    ],
    supervisorRuntime: {
      enabled: true,
      interaction_mode: "checkpointed_supervised",
    },
  });

  const reviewGate = checkpoints.find((checkpoint) => checkpoint.checkpoint_id === "checkpoint_review_gate");
  const outputGate = checkpoints.find((checkpoint) => checkpoint.checkpoint_id === "checkpoint_output_ready");
  const reflectionGate = checkpoints.find((checkpoint) => checkpoint.checkpoint_id === "checkpoint_reflection_round");

  assert.equal(reviewGate.human_interrupt_allowed, true);
  assert.deepEqual(reviewGate.trigger_after_instances, ["inst_review_1"]);
  assert.equal(reviewGate.supervisor_decision.status, "review_gate");

  assert.equal(outputGate.approval_required, true);
  assert.deepEqual(outputGate.trigger_after_instances, ["inst_synth_1"]);

  assert.equal(reflectionGate.supervisor_decision.status, "decide_reflection_continue");
});
