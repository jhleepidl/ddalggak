import test from "node:test";
import assert from "node:assert/strict";

import { reconcileTeamPlanRuntimeBindings } from "../src/domain/team_plan.js";

test("instance reconciliation remaps stale ids by slot onto final runtime agents", () => {
  const reconciled = reconcileTeamPlanRuntimeBindings({
    slots: [
      { slot_id: "slot_builder_1", role_id: "builder", authority_profile_id: "worker_publish_guarded" },
    ],
    runtime_agents: [
      { instance_id: "inst_builder_prelim", slot_id: "slot_builder_1", role_id: "builder", preset_id: "legacy.coder" },
    ],
    authority_graph: [
      { slot_id: "slot_builder_1", instance_id: "inst_builder_prelim", role_id: "builder", authority_profile_id: "worker_publish_guarded" },
    ],
    collaboration_cells: [
      {
        cell_id: "cell_builder_loop",
        pattern: "reflection",
        member_instance_ids: ["inst_builder_prelim"],
        topology: "single",
        max_rounds: 1,
        termination: { condition: "done" },
      },
    ],
    checkpoints: [
      {
        checkpoint_id: "checkpoint_builder_done",
        target_slot_ids: ["slot_builder_1"],
        trigger_after_instances: ["inst_builder_prelim"],
      },
    ],
  }, {
    runtimeAgents: [
      { instance_id: "inst_builder_final", slot_id: "slot_builder_1", role_id: "builder", preset_id: "legacy.coder" },
    ],
  });

  assert.equal(reconciled.runtime_agents[0].instance_id, "inst_builder_final");
  assert.equal(reconciled.authority_graph[0].instance_id, "inst_builder_final");
  assert.deepEqual(reconciled.collaboration_cells[0].member_instance_ids, ["inst_builder_final"]);
  assert.deepEqual(reconciled.checkpoints[0].trigger_after_instances, ["inst_builder_final"]);
  assert.equal(reconciled.instance_id_map.inst_builder_prelim, "inst_builder_final");
});
