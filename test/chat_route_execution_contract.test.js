import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSupervisorExecutionCallbacks,
} from "../src/application/telegram_chat_execution.js";
import { sendAgentStatusTransitionMessage } from "../src/application/telegram_route_planning.js";
import { executeSupervisorActions } from "../src/chat/executor.js";
import { Jobs } from "../src/jobs.js";
import { Tracking } from "../src/tracking.js";
import { mergePreferredRuntimeTeamSnapshot } from "../src/chat/route_execution_contract.js";

test("buildSupervisorExecutionCallbacks runAgent no longer crashes on updateAgentStatus lookup", async () => {
  const controller = new AbortController();
  const callbacks = buildSupervisorExecutionCallbacks({
    bot: { sendMessage: async () => null },
    chatId: 4101,
    userId: "user-status",
    jobId: "job-status",
    runtime: {
      agents: [{
        id: "researcher",
        name: "Researcher",
        provider: "unsupported-provider",
        model: "test-model",
        prompt: "test role",
      }],
      agentsCatalog: [{
        id: "researcher",
        name: "Researcher",
        provider: "unsupported-provider",
        model: "test-model",
        prompt: "test role",
      }],
    },
    controller,
    verbose: false,
  });

  await assert.rejects(
    callbacks.runAgent({
      action: {
        type: "run_agent",
        agent_id: "researcher",
        goal: "probe execution helper",
      },
      detailContext: "",
    }),
    /Unsupported provider/
  );
});

test("sendAgentStatusTransitionMessage uses shared status throttle state without ReferenceError", async () => {
  const sent = [];
  await sendAgentStatusTransitionMessage(
    {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return { ok: true };
      },
    },
    4105,
    {
      agentId: "researcher",
      state: "running",
      goal: "status helper probe",
    }
  );

  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].text || "").includes("Researcher"), true);
});

test("executeSupervisorActions degrades spawn_agents to sequential run_agent without supervisor runtime", async () => {
  const runCalls = [];
  const spawnCalls = [];
  const execution = await executeSupervisorActions({
    chatId: 4102,
    userId: "user-spawn",
    jobId: "job-spawn",
    plan: {
      runtime_team_snapshot: {},
      actions: [{
        type: "spawn_agents",
        summary: "parallel research and review",
        agents: [
          { agent_id: "researcher", goal: "collect evidence" },
          { agent_id: "reviewer", goal: "check risks" },
        ],
      }],
    },
    callbacks: {
      runAgent: async ({ action }) => {
        runCalls.push(action);
        return {
          provider: "test",
          mode: "test",
          output: `done:${action.agent_id}:${action.goal}`,
        };
      },
      spawnAgents: async ({ action }) => {
        spawnCalls.push(action);
        return { summary: "should not run" };
      },
    },
  });

  assert.equal(spawnCalls.length, 0);
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].agent_id, "researcher");
  assert.equal(runCalls[1].agent_id, "reviewer");
  assert.equal(execution.pendingApproval, null);
  assert.equal(execution.results.some((row) => String(row?.note || "").includes("downgraded to sequential run_agent")), true);
  assert.equal(execution.outputs.some((row) => row.mode === "execution_contract"), true);
});

test("runtime snapshot merge preserves rich supervisor metadata when route only carries minimal fields", async () => {
  const runtimeTeamSnapshot = {
    source: "team_builder",
    runtime_agents: [
      { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", authority_profile_id: "worker_publish_guarded" },
    ],
    supervisor_runtime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      authority_profile_id: "supervisor_controlled",
    },
    authority_graph: [
      { instance_id: "supervisor_runtime", role_id: "supervisor_runtime", authority_profile_id: "supervisor_controlled" },
      { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", authority_profile_id: "worker_publish_guarded" },
    ],
    execution_graph: {
      interrupt_ready: true,
      nodes: [],
      edges: [],
      parallel_groups: [],
      supervisor_edges: [],
    },
  };

  const merged = mergePreferredRuntimeTeamSnapshot({
    baseSnapshot: runtimeTeamSnapshot,
    routePlan: {
      actions: [],
      runtime_agents: [],
    },
    runtimeAuthority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
      degraded_mode: false,
      fallback_reason: null,
    },
  });

  assert.equal(merged.supervisor_runtime.instance_id, "supervisor_runtime");
  assert.equal(merged.authority_graph.some((entry) => entry.role_id === "supervisor_runtime"), true);
  assert.equal(merged.execution_graph.interrupt_ready, true);
});

test("executeSupervisorActions still blocks true approval-gated actions", async () => {
  const execution = await executeSupervisorActions({
    chatId: 4104,
    userId: "user-approval",
    jobId: "job-approval",
    plan: {
      runtime_team_snapshot: {
        supervisor_runtime: {
          enabled: true,
          instance_id: "supervisor_runtime",
          authority_profile_id: "supervisor_controlled",
        },
        authority_graph: [
          { instance_id: "supervisor_runtime", role_id: "supervisor_runtime", authority_profile_id: "supervisor_controlled" },
        ],
      },
      actions: [{
        type: "checkpoint",
        label: "human gate",
        inputs: {
          approval_required: true,
          checkpoint_id: "cp_1",
        },
      }],
    },
    callbacks: {},
  });

  assert.ok(execution.pendingApproval);
  assert.equal(execution.pendingApproval.gate_type, "checkpoint");
  assert.equal(execution.results.some((row) => row.status === "blocked"), true);
});
