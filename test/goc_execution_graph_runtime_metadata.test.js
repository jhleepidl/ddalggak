import test from "node:test";
import assert from "node:assert/strict";
import { GocExecutionGraphRecorder } from "../src/chat/goc_execution_graph.js";
import {
  buildRuntimeAuthorityMetadataFixture,
  cloneRuntimeAuthorityFixture,
} from "../test_fixtures/runtime_authority_contract.js";

function createFakeGraphClient() {
  const state = {
    createdNodes: [],
    updatedNodes: [],
    createdEdges: [],
  };
  return {
    state,
    async createNode(threadId, body = {}) {
      state.createdNodes.push({ threadId, body });
      return { id: `node_${state.createdNodes.length}` };
    },
    async updateNode(nodeId, body = {}) {
      state.updatedNodes.push({ nodeId, body });
      return { id: nodeId };
    },
    async createEdge(threadId, fromId, toId, edgeType) {
      state.createdEdges.push({ threadId, fromId, toId, edgeType });
      return { ok: true };
    },
  };
}

function sampleRuntimeSnapshot() {
  return {
    task_interpretation: {
      task_type: "code_change",
      task_summary: "implement feature safely",
      deliverable_type: "patch",
    },
    team_plan: {
      mode: "run",
      roles: [{ id: "coder", role_label: "coder" }],
      dependencies: [],
      execution_order: ["coder"],
      reason: "team selected",
      budget: {},
    },
    runtime_agents: [
      {
        instance_id: "inst_coder_1",
        template_id: "coder",
        role_label: "coder",
        attached_skills: [
          {
            skill_id: "skill.run_trace_debugging.v1",
            selected_by: "skill_resolver",
            selection_reason: "debug support",
            load_level: "instructions",
            status: "selected",
          },
        ],
        context_pack_id: "ctxp_coder_1",
        provider: "codex",
        model: "gpt-5-codex",
        capability_tags: ["coding"],
        status: "ready",
        ephemeral: false,
        fallback: false,
      },
    ],
    context_packs: [
      {
        id: "ctxp_coder_1",
        run_id: "run_1",
        scope: "role",
        target_runtime_agent_instance_id: "inst_coder_1",
        shared_items: [],
        role_specific_items: [],
        skill_items: [
          {
            skill_id: "skill.run_trace_debugging.v1",
            load_level: "instructions",
          },
        ],
        excluded_items: [],
        missing_items: [],
        conflicts: [],
        token_budget: { soft_limit: 1200, hard_limit: 2000 },
      },
    ],
    selected_skill_ids: ["skill.run_trace_debugging.v1"],
    skill_load_levels: {
      inst_coder_1: {
        "skill.run_trace_debugging.v1": "instructions",
      },
    },
    selection_reason_summary: {
      coder: "skill.run_trace_debugging.v1:debug support",
    },
    collaboration_cells: [
      {
        cell_id: "cell_builder_reviewer_reflection",
        pattern: "reflection",
        member_instance_ids: ["inst_coder_1"],
        topology: "pair",
        max_rounds: 2,
        termination: { condition: "review_accepted" },
      },
    ],
    authority_graph: [
      {
        slot_id: "slot_builder_1",
        instance_id: "inst_coder_1",
        role_id: "builder",
        authority_profile_id: "worker_publish_guarded",
      },
    ],
    checkpoints: [
      {
        checkpoint_id: "checkpoint_review_gate",
        target_slot_ids: ["slot_builder_1"],
        trigger_after_instances: ["inst_coder_1"],
        human_interrupt_allowed: true,
      },
    ],
    execution_graph: {
      nodes: [{ slot_id: "slot_builder_1", role_id: "builder" }],
      edges: [],
      parallel_groups: [],
      supervisor_edges: [{ supervisor_instance_id: "supervisor_runtime", target_slot_ids: ["slot_builder_1"] }],
      interrupt_ready: true,
    },
    supervisor_runtime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      interaction_mode: "manager_as_tool",
      authority_profile_id: "supervisor_controlled",
    },
    skill_usage_events: [
      {
        run_id: "run_1",
        runtime_agent_instance_id: "inst_coder_1",
        skill_id: "skill.run_trace_debugging.v1",
        event_type: "attached",
        payload: { load_level: "instructions" },
        created_at: "2026-03-10T00:00:00.000Z",
      },
    ],
    skill_usage_summary: {
      attached: 1,
    },
    generated_at: "2026-03-10T00:00:00.000Z",
    source: "team_builder",
  };
}

function sampleRuntimeSnapshotNoSkills() {
  return {
    team_plan: {
      mode: "run",
      roles: [{ id: "coder", role_label: "coder" }],
      dependencies: [],
      execution_order: ["coder"],
      reason: "team selected",
      budget: {},
    },
    runtime_agents: [
      {
        instance_id: "inst_coder_empty",
        template_id: "coder",
        role_label: "coder",
        attached_skills: [],
        context_pack_id: "ctxp_coder_empty",
        provider: "codex",
        model: "gpt-5-codex",
        capability_tags: ["coding"],
        status: "ready",
      },
    ],
    context_packs: [
      {
        id: "ctxp_coder_empty",
        run_id: "run_empty",
        scope: "role",
        target_runtime_agent_instance_id: "inst_coder_empty",
        shared_items: [],
        role_specific_items: [],
        skill_items: [],
        excluded_items: [],
        missing_items: [],
        conflicts: [],
        token_budget: { soft_limit: 1200, hard_limit: 2000 },
      },
    ],
    selected_skill_ids: [],
    skill_load_levels: {
      inst_coder_empty: {},
    },
    generated_at: "2026-03-10T00:00:00.000Z",
    source: "team_builder",
  };
}

test("runtime_team_snapshot is persisted on GOC Run payloads", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_1",
    contextSetId: "ctx_1",
    sharedContextSetId: "ctx_1",
    runId: "run_1",
    chatId: "chat_1",
    jobId: "job_1",
  });

  await recorder.startRun({
    userText: "hello",
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshot(),
      ...buildRuntimeAuthorityMetadataFixture("goc"),
      actionSource: "team_generated",
    },
  });

  const runNode = client.state.createdNodes[0];
  assert.equal(runNode.body.node_type, "Run");
  assert.equal(runNode.body.payload_json.action_source, "generated_team_actions");
  assert.deepEqual(
    runNode.body.payload_json.runtime_authority,
    cloneRuntimeAuthorityFixture("goc")
  );
  assert.equal(runNode.body.payload_json.plan_source, "local");
  assert.equal(runNode.body.payload_json.context_source, "goc");
  assert.equal(runNode.body.payload_json.runtime_team_snapshot.source, "team_builder");
  assert.equal(runNode.body.payload_json.runtime_team_snapshot.supervisor_runtime.instance_id, "supervisor_runtime");
  assert.equal(runNode.body.payload_json.runtime_team_snapshot.execution_graph.interrupt_ready, true);
  assert.equal(runNode.body.payload_json.runtime_agents[0].template_id, "coder");
  assert.equal(runNode.body.payload_json.collaboration_cells[0].pattern, "reflection");
  assert.equal(runNode.body.payload_json.checkpoints[0].checkpoint_id, "checkpoint_review_gate");
  assert.ok(runNode.body.payload_json.selected_skill_ids.includes("skill.run_trace_debugging.v1"));
  assert.equal(runNode.body.payload_json.context_packs[0].id, "ctxp_coder_1");
  assert.equal(runNode.body.payload_json.skill_load_levels.inst_coder_1["skill.run_trace_debugging.v1"], "instructions");
  assert.equal(runNode.body.payload_json.selection_reason_summary.coder.includes("debug support"), true);
  assert.equal(runNode.body.payload_json.skill_usage_events.length, 1);
});

test("step payloads include additive runtime role metadata and update run metadata", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_2",
    contextSetId: "ctx_2",
    sharedContextSetId: "ctx_2",
    runId: "run_2",
    chatId: "chat_2",
    jobId: "job_2",
  });

  await recorder.startRun({ userText: "start" });
  await recorder.queueMainSteps([
    {
      type: "run_agent",
      agent_id: "coder",
      goal: "implement feature",
      inputs: {
        runtimeInstanceId: "inst_coder_1",
        checkpoint_ids: ["checkpoint_review_gate"],
        collaboration_cell_ids: ["cell_builder_reviewer_reflection"],
        supervisor_instance_id: "supervisor_runtime",
      },
    },
  ], {
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshot(),
      actionSource: "explicit",
    },
  });

  assert.equal(client.state.updatedNodes.length, 1);
  assert.equal(client.state.updatedNodes[0].body.payload_json.action_source, "explicit_route_plan");
  assert.equal(client.state.updatedNodes[0].body.payload_json.runtime_team_snapshot.source, "team_builder");

  const stepNode = client.state.createdNodes.find((row) => row.body.node_type === "Step");
  assert.ok(stepNode);
  assert.equal(stepNode.body.payload_json.role_label, "coder");
  assert.equal(stepNode.body.payload_json.runtime_instance_id, "inst_coder_1");
  assert.equal(stepNode.body.payload_json.template_id, "coder");
  assert.equal(stepNode.body.payload_json.runtime_role.role_label, "coder");
  assert.equal(stepNode.body.payload_json.runtime_role.runtime_status, "ready");
  assert.ok(stepNode.body.payload_json.runtime_role.selected_skill_ids.includes("skill.run_trace_debugging.v1"));
  assert.equal(stepNode.body.payload_json.runtime_role.skill_load_levels["skill.run_trace_debugging.v1"], "instructions");
  assert.equal(Array.isArray(stepNode.body.payload_json.runtime_role.attached_skills), true);
  assert.equal(stepNode.body.payload_json.runtime_role.attached_skills.length, 1);
  assert.equal(stepNode.body.payload_json.context_pack_id, "ctxp_coder_1");
  assert.deepEqual(stepNode.body.payload_json.checkpoint_ids, ["checkpoint_review_gate"]);
  assert.deepEqual(stepNode.body.payload_json.collaboration_cell_ids, ["cell_builder_reviewer_reflection"]);
  assert.equal(stepNode.body.payload_json.supervisor_instance_id, "supervisor_runtime");
  assert.equal(stepNode.body.payload_json.action_source, "explicit_route_plan");
});

test("runtime authority transitions are updated on the run payload and reused by subsequent step payloads", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_3",
    contextSetId: "ctx_3",
    sharedContextSetId: "ctx_3",
    runId: "run_3",
    chatId: "chat_3",
    jobId: "job_3",
  });

  await recorder.startRun({
    userText: "start",
    metadata: buildRuntimeAuthorityMetadataFixture("goc"),
  });
  await recorder.queueMainSteps([
    {
      type: "run_agent",
      agent_id: "coder",
      goal: "fallback locally",
      inputs: {
        runtimeInstanceId: "inst_coder_1",
      },
    },
  ], {
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshot(),
      actionSource: "explicit",
      ...buildRuntimeAuthorityMetadataFixture("goc_planner_fallback"),
    },
  });

  const runUpdate = client.state.updatedNodes[0];
  const stepNode = client.state.createdNodes.find((row) => row.body.node_type === "Step");
  assert.ok(runUpdate);
  assert.ok(stepNode);
  assert.deepEqual(
    runUpdate.body.payload_json.runtime_authority,
    cloneRuntimeAuthorityFixture("goc_planner_fallback")
  );
  assert.deepEqual(
    stepNode.body.payload_json.runtime_authority,
    cloneRuntimeAuthorityFixture("goc_planner_fallback")
  );
  assert.equal(runUpdate.body.payload_json.plan_source, "local_fallback");
  assert.equal(stepNode.body.payload_json.plan_source, "local_fallback");
  assert.equal(runUpdate.body.payload_json.context_source, "goc");
  assert.equal(stepNode.body.payload_json.context_source, "goc");
  assert.equal(runUpdate.body.payload_json.degraded_mode, true);
  assert.equal(stepNode.body.payload_json.degraded_mode, true);
  assert.equal(runUpdate.body.payload_json.fallback_reason, "remote planner timeout");
  assert.equal(stepNode.body.payload_json.fallback_reason, "remote planner timeout");
});

test("non-GOC/no-recorder flow remains no-op safe", async () => {
  const recorder = new GocExecutionGraphRecorder({
    client: null,
    threadId: "",
    runId: "run_local",
  });

  await recorder.startRun({
    userText: "local-only",
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshot(),
      actionSource: "fallback",
    },
  });
  await recorder.queueMainSteps([{
    type: "run_agent",
    agent_id: "coder",
    goal: "noop",
  }], {
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshot(),
      actionSource: "fallback",
    },
  });
  await recorder.finishRun({ status: "done" });

  assert.equal(recorder.getRunNodeId(), "");
});

test("GOC payload path remains valid when runtime snapshot has no skills", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_no_skill",
    contextSetId: "ctx_no_skill",
    sharedContextSetId: "ctx_no_skill",
    runId: "run_no_skill",
    chatId: "chat_no_skill",
    jobId: "job_no_skill",
  });

  await recorder.startRun({
    userText: "start",
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshotNoSkills(),
      actionSource: "explicit",
    },
  });
  await recorder.queueMainSteps([
    {
      type: "run_agent",
      agent_id: "coder",
      goal: "implement",
      inputs: {
        runtimeInstanceId: "inst_coder_empty",
      },
    },
  ], {
    metadata: {
      runtimeTeamSnapshot: sampleRuntimeSnapshotNoSkills(),
      actionSource: "explicit",
    },
  });

  const runNode = client.state.createdNodes.find((row) => row.body.node_type === "Run");
  const stepNode = client.state.createdNodes.find((row) => row.body.node_type === "Step");
  assert.ok(runNode);
  assert.ok(stepNode);
  assert.equal(runNode.body.payload_json.action_source, "explicit_route_plan");
  assert.equal(Array.isArray(runNode.body.payload_json.selected_skill_ids), false);
  assert.equal(Array.isArray(stepNode.body.payload_json.runtime_role.selected_skill_ids), true);
  assert.equal(stepNode.body.payload_json.runtime_role.selected_skill_ids.length, 0);
  assert.deepEqual(stepNode.body.payload_json.runtime_role.skill_load_levels, {});
});

test("queued steps can be marked skipped to prevent stale active work", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_3",
    contextSetId: "ctx_3",
    sharedContextSetId: "ctx_3",
    runId: "run_3",
    chatId: "chat_3",
    jobId: "job_3",
  });

  const action = { type: "run_agent", agent_id: "researcher", goal: "analyze" };
  await recorder.startRun({ userText: "start" });
  await recorder.queueMainSteps([action], {
    metadata: {
      actionSource: "explicit",
    },
  });
  await recorder.markStepSkipped(action, {
    reason: "awaiting_approval",
  });

  const stepUpdate = client.state.updatedNodes.find((row) =>
    String(row?.body?.payload_json?.status || "") === "skipped"
  );
  assert.ok(stepUpdate);
  assert.equal(stepUpdate.body.payload_json.skip_reason, "awaiting_approval");
});

test("finishRun marks leftover queued steps as skipped for hygiene", async () => {
  const client = createFakeGraphClient();
  const recorder = new GocExecutionGraphRecorder({
    client,
    threadId: "thread_4",
    contextSetId: "ctx_4",
    sharedContextSetId: "ctx_4",
    runId: "run_4",
    chatId: "chat_4",
    jobId: "job_4",
  });

  await recorder.startRun({ userText: "start" });
  await recorder.queueMainSteps([
    { type: "run_agent", agent_id: "researcher", goal: "analysis" },
    { type: "run_agent", agent_id: "coder", goal: "implement" },
  ]);
  await recorder.finishRun({
    status: "await_user",
    summary: "pending approval",
  });

  const skippedUpdates = client.state.updatedNodes.filter((row) =>
    String(row?.body?.payload_json?.status || "") === "skipped"
  );
  assert.ok(skippedUpdates.length >= 2);
  for (const row of skippedUpdates) {
    assert.equal(row.body.payload_json.skip_reason, "await_user");
  }
});
