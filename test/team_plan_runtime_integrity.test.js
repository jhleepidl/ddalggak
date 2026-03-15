import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileTeamPlanRuntimeBindings,
  validateNormalizedTeamPlan,
} from "../src/domain/team_plan.js";

test("reconciled team plan keeps every runtime instance reference valid", () => {
  const reconciled = reconcileTeamPlanRuntimeBindings({
    team_plan_id: "team_runtime_integrity",
    slots: [
      { slot_id: "slot_researcher_1", role_id: "researcher", authority_profile_id: "worker_readonly_research" },
      { slot_id: "slot_reviewer_1", role_id: "reviewer", authority_profile_id: "worker_readonly_review" },
      { slot_id: "slot_synth_1", role_id: "synthesizer", authority_profile_id: "worker_publish_guarded" },
    ],
    runtime_agents: [
      { instance_id: "inst_pre_research", slot_id: "slot_researcher_1", role_id: "researcher" },
      { instance_id: "inst_pre_review", slot_id: "slot_reviewer_1", role_id: "reviewer" },
      { instance_id: "inst_pre_synth", slot_id: "slot_synth_1", role_id: "synthesizer" },
    ],
    authority_graph: [
      { slot_id: "slot_researcher_1", instance_id: "inst_pre_research", role_id: "researcher", authority_profile_id: "worker_readonly_research" },
      { slot_id: "slot_reviewer_1", instance_id: "inst_pre_review", role_id: "reviewer", authority_profile_id: "worker_readonly_review" },
    ],
    collaboration_cells: [
      {
        cell_id: "cell_research_review_reflection",
        pattern: "reflection",
        member_instance_ids: ["inst_pre_research", "inst_pre_review"],
        topology: "pair",
        max_rounds: 2,
        termination: { condition: "claims_validated" },
      },
    ],
    checkpoints: [
      {
        checkpoint_id: "checkpoint_review_gate",
        target_slot_ids: ["slot_reviewer_1"],
        trigger_after_instances: ["inst_pre_review"],
        human_interrupt_allowed: true,
      },
    ],
    supervisor_runtime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      interaction_mode: "manager_as_tool",
      authority_profile_id: "supervisor_controlled",
    },
    execution_graph: {
      nodes: [
        { slot_id: "slot_researcher_1", role_id: "researcher" },
        { slot_id: "slot_reviewer_1", role_id: "reviewer" },
        { slot_id: "slot_synth_1", role_id: "synthesizer" },
      ],
      edges: [
        { from_slot_id: "slot_researcher_1", to_slot_id: "slot_reviewer_1", relation: "precedes" },
        { from_slot_id: "slot_reviewer_1", to_slot_id: "slot_synth_1", relation: "precedes" },
      ],
      supervisor_edges: [
        { supervisor_instance_id: "supervisor_runtime", target_slot_ids: ["slot_researcher_1", "slot_reviewer_1"] },
      ],
    },
  }, {
    runtimeAgents: [
      { instance_id: "inst_final_research", slot_id: "slot_researcher_1", role_id: "researcher" },
      { instance_id: "inst_final_review", slot_id: "slot_reviewer_1", role_id: "reviewer" },
      { instance_id: "inst_final_synth", slot_id: "slot_synth_1", role_id: "synthesizer" },
    ],
  });

  const runtimeInstanceIds = new Set(reconciled.runtime_agents.map((agent) => agent.instance_id));
  for (const edge of reconciled.authority_graph) {
    if (edge.instance_id && edge.role_id !== "supervisor_runtime") {
      assert.equal(runtimeInstanceIds.has(edge.instance_id), true);
    }
  }
  for (const cell of reconciled.collaboration_cells) {
    assert.equal(cell.member_instance_ids.every((instanceId) => runtimeInstanceIds.has(instanceId)), true);
  }
  for (const checkpoint of reconciled.checkpoints) {
    assert.equal(checkpoint.trigger_after_instances.every((instanceId) => runtimeInstanceIds.has(instanceId)), true);
  }
  for (const edge of reconciled.execution_graph.supervisor_edges) {
    assert.equal(edge.target_instance_ids.every((instanceId) => runtimeInstanceIds.has(instanceId)), true);
  }

  const validation = validateNormalizedTeamPlan(reconciled);
  assert.equal(validation.ok, true);
});
