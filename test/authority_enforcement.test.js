import test from "node:test";
import assert from "node:assert/strict";

import { evaluateActionAuthority } from "../src/application/run_authority.js";

test("readonly authority blocks patch-like builder execution", () => {
  const evaluation = evaluateActionAuthority({
    action: {
      type: "agent_run",
      agent: "builder",
      prompt: "apply a workspace patch",
      inputs: {
        runtime_instance_id: "inst_builder_1",
        role_id: "builder",
      },
    },
    runtimeSnapshot: {
      runtime_agents: [
        { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", authority_profile_id: "worker_readonly_research" },
      ],
      authority_graph: [
        { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", authority_profile_id: "worker_readonly_research" },
      ],
    },
  });

  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.denied_by.some((entry) => entry.includes("not_allowed:write")), true);
});

test("supervisor-controlled spawn requires approval and rejects worker execution", () => {
  const deniedWorker = evaluateActionAuthority({
    action: {
      type: "spawn_parallel",
      agents: [
        { agent: "researcher", prompt: "collect filing evidence" },
        { agent: "researcher", prompt: "collect market-news evidence" },
      ],
    },
    runtimeSnapshot: {
      runtime_agents: [
        { instance_id: "inst_operator_1", slot_id: "slot_operator_1", role_id: "operator", authority_profile_id: "worker_publish_guarded" },
      ],
      authority_graph: [
        { instance_id: "inst_operator_1", slot_id: "slot_operator_1", role_id: "operator", authority_profile_id: "worker_publish_guarded" },
      ],
    },
  });
  assert.equal(deniedWorker.allowed, false);

  const supervisor = evaluateActionAuthority({
    action: {
      type: "spawn_parallel",
      agents: [
        { agent: "researcher", prompt: "collect filing evidence" },
        { agent: "researcher", prompt: "collect market-news evidence" },
      ],
    },
    runtimeSnapshot: {
      supervisor_runtime: {
        enabled: true,
        instance_id: "supervisor_runtime",
        authority_profile_id: "supervisor_controlled",
      },
      authority_graph: [
        { instance_id: "supervisor_runtime", role_id: "supervisor_runtime", authority_profile_id: "supervisor_controlled" },
      ],
    },
  });
  assert.equal(supervisor.allowed, true);
  assert.equal(supervisor.requires_approval, true);
});
