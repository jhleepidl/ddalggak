import test from "node:test";
import assert from "node:assert/strict";

import {
  createRuntimeTeamSnapshot,
  normalizeRuntimeMetadataEnvelope,
} from "../src/application/runtime_metadata.js";
import { summarizeRuntimeTeamSnapshotLines } from "../src/application/runtime_snapshot_display.js";
import { buildRuntimeAuthorityMetadataFixture } from "../test_fixtures/runtime_authority_contract.js";

test("runtime metadata envelope preserves supervisor runtime and interrupt-ready graph metadata", () => {
  const snapshot = createRuntimeTeamSnapshot({
    taskInterpretation: {
      task_type: "analysis",
      task_summary: "supervised review",
    },
    teamPlan: {
      slots: [
        { slot_id: "slot_research_1", role_id: "researcher", purpose: "collect evidence", authority_profile_id: "worker_readonly_research" },
      ],
      runtime_agents: [
        { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher", role_label: "researcher", authority_profile_id: "worker_readonly_research" },
      ],
      supervisor_runtime: {
        enabled: true,
        instance_id: "supervisor_runtime",
        interaction_mode: "checkpointed_supervised",
        authority_profile_id: "supervisor_controlled",
      },
      collaboration_cells: [
        {
          cell_id: "cell_manager",
          pattern: "manager_as_tool",
          member_instance_ids: ["inst_research_1"],
          topology: "hub",
          max_rounds: 1,
          termination: { condition: "children_completed_or_interrupted" },
          report_back_to_instance_id: "supervisor_runtime",
        },
      ],
      checkpoints: [
        {
          checkpoint_id: "checkpoint_supervisor_summary",
          trigger_after_instances: ["inst_research_1"],
          human_interrupt_allowed: true,
        },
      ],
      execution_graph: {
        nodes: [{ slot_id: "slot_research_1", role_id: "researcher" }],
        edges: [],
        parallel_groups: [],
        supervisor_edges: [{ supervisor_instance_id: "supervisor_runtime", target_slot_ids: ["slot_research_1"] }],
        interrupt_ready: true,
      },
      authority_graph: [
        { slot_id: "slot_research_1", authority_profile_id: "worker_readonly_research" },
      ],
    },
    runtimeAgents: [
      { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher", role_label: "researcher", authority_profile_id: "worker_readonly_research" },
    ],
    supervisorRuntime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      interaction_mode: "checkpointed_supervised",
      authority_profile_id: "supervisor_controlled",
    },
    runtimeAuthority: buildRuntimeAuthorityMetadataFixture("goc").runtime_authority,
    source: "control_plane",
  });

  const envelope = normalizeRuntimeMetadataEnvelope({
    runtime_team_snapshot: snapshot,
    action_source: "generated_team_actions",
  });

  assert.equal(envelope.supervisor_runtime.instance_id, "supervisor_runtime");
  assert.equal(envelope.execution_graph.interrupt_ready, true);
  assert.equal(envelope.authority_graph.some((entry) => entry.role_id === "supervisor_runtime"), true);

  const lines = summarizeRuntimeTeamSnapshotLines(snapshot, {
    actionSource: envelope.action_source,
  });
  assert.equal(lines.some((line) => line.includes("supervisor: checkpointed_supervised")), true);
  assert.equal(lines.some((line) => line.includes("checkpoints:")), true);
});
