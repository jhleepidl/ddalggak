import test from "node:test";
import assert from "node:assert/strict";
import { GocExecutionGraphRecorder } from "../src/chat/goc_execution_graph.js";

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
        provider: "codex",
        model: "gpt-5-codex",
        capability_tags: ["coding"],
        status: "ready",
        ephemeral: false,
        fallback: false,
      },
    ],
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
      actionSource: "team_generated",
    },
  });

  const runNode = client.state.createdNodes[0];
  assert.equal(runNode.body.node_type, "Run");
  assert.equal(runNode.body.payload_json.action_source, "generated_team_actions");
  assert.equal(runNode.body.payload_json.runtime_team_snapshot.source, "team_builder");
  assert.equal(runNode.body.payload_json.runtime_agents[0].template_id, "coder");
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
  assert.equal(stepNode.body.payload_json.action_source, "explicit_route_plan");
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
