import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyConversationAgentMutation,
  runConversationAgentTeamCommand,
} from "../src/application/agent_team_commands.js";
import { LocalConversationTeamStore } from "../src/runtime_capabilities/conversation_team_store.js";

function createLocalStore() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-agent-team-"));
  const runsDir = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  return new LocalConversationTeamStore({ baseDir: runsDir });
}

function createFormatterDeps() {
  return {
    buildAgentDisplayIndex: (registry = null) => new Map(
      (Array.isArray(registry?.agents) ? registry.agents : [])
        .map((row) => [String(row.id || "").trim().toLowerCase(), row])
    ),
    formatAgentRef: (agentId) => `@${String(agentId || "").trim().toLowerCase()}`,
  };
}

test("runConversationAgentTeamCommand applies local mutation and formats the result", async () => {
  const store = createLocalStore();
  const runtime = {
    mode: "local",
    runtimeAuthority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
    },
    map: { threadId: "local:job_team_1" },
    conversation: { id: "local:job_team_1", thread_id: "local:job_team_1" },
    conversationMembershipTarget: {
      thread_id: "local:job_team_1",
      conversation_id: "local:job_team_1",
      source: "local",
    },
    agentsCatalog: [
      { id: "planner" },
      { id: "coder" },
      { id: "researcher" },
    ],
    capabilities: {
      conversationTeamStore: store,
    },
  };
  await store.ensureTeam({
    jobId: "job_team_1",
    baselineAgentIds: ["planner"],
  });

  const result = await runConversationAgentTeamCommand({
    command: "add",
    runtime,
    jobId: "job_team_1",
    agentId: "coder",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(result.message, /conversation agent 추가 완료/);
  assert.match(result.message, /@coder/);
  assert.deepEqual(runtime.enabledAgentIds, ["planner", "coder"]);

  const listed = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_1",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(listed.message, /현재 agent\/team 상태/);
  assert.match(listed.message, /explicit_enabled: @planner, @coder/);
  assert.match(listed.message, /optional_members: @researcher/);
});

test("applyConversationAgentMutation preserves local catalog validation", async () => {
  const store = createLocalStore();
  const runtime = {
    mode: "local",
    runtimeAuthority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
    },
    map: { threadId: "local:job_team_2" },
    conversation: { id: "local:job_team_2", thread_id: "local:job_team_2" },
    conversationMembershipTarget: {
      thread_id: "local:job_team_2",
      conversation_id: "local:job_team_2",
      source: "local",
    },
    agentsCatalog: [{ id: "planner" }],
    capabilities: {
      conversationTeamStore: store,
    },
  };
  await store.ensureTeam({
    jobId: "job_team_2",
    baselineAgentIds: ["planner"],
  });

  await assert.rejects(
    () => applyConversationAgentMutation({
      runtime,
      jobId: "job_team_2",
      actionType: "add",
      agentId: "ghost",
      source: "test_agents_command",
    }),
    (error) => error && error.code === "unknown_agent"
  );
});

test("applyConversationAgentMutation skips local catalog validation for goc authority", async () => {
  let addCalls = 0;
  const runtime = {
    mode: "goc",
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
    map: { threadId: "goc-thread" },
    conversation: { id: "goc-conversation", thread_id: "goc-thread" },
    conversationMembershipTarget: {
      thread_id: "goc-thread",
      conversation_id: "goc-conversation",
      source: "goc",
    },
    agentsCatalog: [],
    capabilities: {
      conversationTeamStore: {
        source: "goc",
        async addAgent({ conversationId, threadId, agentId, enabled }) {
          addCalls += 1;
          assert.equal(conversationId, "goc-conversation");
          assert.equal(threadId, "goc-thread");
          assert.equal(agentId, "ghost");
          assert.equal(enabled, true);
          return {
            target: {
              thread_id: "goc-thread",
              conversation_id: "goc-conversation",
              source: "goc",
            },
            rows: [{ agent_id: "ghost", enabled: true }],
            warnings: [],
            mutation_response: { ok: true, agent_id: "ghost", enabled: true },
          };
        },
      },
    },
  };

  const mutation = await applyConversationAgentMutation({
    runtime,
    jobId: "job_team_3",
    actionType: "add",
    agentId: "ghost",
    source: "test_agents_command",
  });

  assert.equal(addCalls, 1);
  assert.equal(mutation.verification.confirmed, true);
  assert.deepEqual(runtime.enabledAgentIds, ["ghost"]);
  assert.deepEqual(runtime.conversationAgents, [{ agent_id: "ghost", enabled: true }]);
});

test("/agents list separates baseline defaults, explicit membership, and last active run team", async () => {
  const runtime = {
    mode: "goc",
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
    map: { threadId: "goc-thread" },
    conversation: { id: "goc-conversation", thread_id: "goc-thread" },
    conversationMembershipTarget: {
      thread_id: "goc-thread",
      conversation_id: "goc-conversation",
      source: "goc",
    },
    baselineDefaultAgentIds: ["planner", "coder"],
    conversationAgents: [
      { agent_id: "researcher", enabled: true },
      { agent_id: "coder", enabled: false },
    ],
    agentsCatalog: [
      { id: "planner" },
      { id: "coder" },
      { id: "researcher" },
      { id: "reviewer" },
    ],
    runtimeTeamSnapshot: {
      runtime_agents: [
        { template_id: "reviewer" },
        { template_id: "coder" },
      ],
    },
  };

  const result = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_4",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(result.message, /baseline_defaults: @planner, @coder/);
  assert.match(result.message, /explicit_enabled: @researcher/);
  assert.match(result.message, /explicit_disabled: @coder/);
  assert.match(result.message, /effective_enabled: @planner, @researcher/);
  assert.match(result.message, /optional_members: @reviewer/);
  assert.match(result.message, /last_active_run_team: @reviewer, @coder/);
  assert.deepEqual(result.baselineDefaultAgentIds, ["planner", "coder"]);
  assert.deepEqual(result.explicitEnabledAgentIds, ["researcher"]);
  assert.deepEqual(result.explicitDisabledAgentIds, ["coder"]);
  assert.deepEqual(result.enabledAgentIds, ["planner", "researcher"]);
});

test("/agents list keeps baseline defaults visible when GoC explicit membership sync is degraded", async () => {
  const runtime = {
    mode: "goc",
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
    map: { threadId: "goc-thread" },
    conversation: { id: "goc-conversation", thread_id: "goc-thread" },
    conversationMembershipTarget: {
      thread_id: "goc-thread",
      conversation_id: "goc-conversation",
      source: "goc",
    },
    baselineDefaultAgentIds: ["planner", "coder"],
    conversationAgents: [],
    conversationMembershipWarning: "team_sync:list_explicit_members:GoC API GET /api/threads/goc-thread/team failed (404)",
    agentsCatalog: [
      { id: "planner" },
      { id: "coder" },
      { id: "researcher" },
    ],
  };

  const result = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_5",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(result.message, /baseline_defaults: @planner, @coder/);
  assert.match(result.message, /explicit_enabled: \(none\)/);
  assert.match(result.message, /effective_enabled: @planner, @coder/);
  assert.match(result.message, /warnings: team_sync:list_explicit_members:/);
  assert.doesNotMatch(result.message, /add_baseline_agent|bootstrap_default_agents/);
});

test("goc logical team view dedupes public/private defaults and disables baseline by logical ref", async () => {
  const state = [];
  const setCalls = [];
  const target = {
    thread_id: "goc-thread",
    conversation_id: "goc-conversation",
    source: "goc",
  };
  const runtime = {
    mode: "goc",
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
    map: { threadId: "goc-thread" },
    conversation: { id: "goc-conversation", thread_id: "goc-thread" },
    conversationMembershipTarget: target,
    baselineDefaultAgentIds: ["planner_public", "researcher_public"],
    conversationAgents: [],
    agentsCatalog: [
      { id: "planner_public", name: "Planner", system_key: "planner", visibility: "public", published: true },
      {
        id: "planner_private_12345678",
        name: "Planner",
        system_key: "planner",
        source_agent_id: "planner",
        visibility: "private",
        installed_from_public: true,
        origin: { type: "public", public_node_id: "planner_node" },
      },
      { id: "researcher_public", name: "Researcher", system_key: "researcher", visibility: "public", published: true },
      {
        id: "researcher_private_87654321",
        name: "Researcher",
        system_key: "researcher",
        source_agent_id: "researcher",
        visibility: "private",
        installed_from_public: true,
        origin: { type: "public", public_node_id: "researcher_node" },
      },
    ],
    capabilities: {
      conversationTeamStore: {
        source: "goc",
        async listAgents() {
          return {
            target,
            rows: state.map((row) => ({ ...row })),
            warnings: [],
          };
        },
        async setAgentEnabled({ agentId, enabled }) {
          setCalls.push({ agentId, enabled });
          const index = state.findIndex((row) => row.agent_id === agentId);
          if (index >= 0) state[index] = { ...state[index], enabled };
          else state.push({ agent_id: agentId, enabled });
          return {
            target,
            rows: state.map((row) => ({ ...row })),
            warnings: [],
            mutation_response: { ok: true, agent_id: agentId, enabled },
          };
        },
      },
    },
  };

  const listed = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_6",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(listed.message, /baseline_defaults: @planner, @researcher/);
  assert.match(listed.message, /available_catalog: @planner, @researcher/);
  assert.doesNotMatch(listed.message, /planner_public|planner_private_12345678/);

  const disabled = await runConversationAgentTeamCommand({
    command: "disable",
    runtime,
    jobId: "job_team_6",
    agentId: "planner",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.deepEqual(setCalls, [{ agentId: "planner_private_12345678", enabled: false }]);
  assert.match(disabled.message, /agent: @planner/);
  assert.deepEqual(runtime.enabledAgentRefs, ["researcher"]);
  assert.deepEqual(runtime.enabledAgentIds, ["researcher_private_87654321"]);

  const relisted = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_6",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(relisted.message, /explicit_disabled: @planner/);
  assert.match(relisted.message, /effective_enabled: @researcher/);
});

test("goc logical remove removes explicit specialist regardless of underlying raw membership id", async () => {
  const state = [{ agent_id: "reviewer_public", enabled: true }];
  const removeCalls = [];
  const target = {
    thread_id: "goc-thread",
    conversation_id: "goc-conversation",
    source: "goc",
  };
  const runtime = {
    mode: "goc",
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
    map: { threadId: "goc-thread" },
    conversation: { id: "goc-conversation", thread_id: "goc-thread" },
    conversationMembershipTarget: target,
    baselineDefaultAgentIds: [],
    conversationAgents: state.map((row) => ({ ...row })),
    agentsCatalog: [
      { id: "reviewer_public", name: "Reviewer", system_key: "reviewer", visibility: "public", published: true },
      {
        id: "reviewer_private_abcdef12",
        name: "Reviewer",
        system_key: "reviewer",
        source_agent_id: "reviewer",
        visibility: "private",
        installed_from_public: true,
        origin: { type: "public", public_node_id: "reviewer_node" },
      },
    ],
    capabilities: {
      conversationTeamStore: {
        source: "goc",
        async listAgents() {
          return {
            target,
            rows: state.map((row) => ({ ...row })),
            warnings: [],
          };
        },
        async removeAgent({ agentId }) {
          removeCalls.push(agentId);
          const index = state.findIndex((row) => row.agent_id === agentId);
          if (index >= 0) state.splice(index, 1);
          return {
            target,
            rows: state.map((row) => ({ ...row })),
            warnings: [],
            mutation_response: { ok: true, agent_id: agentId },
          };
        },
      },
    },
  };

  const result = await runConversationAgentTeamCommand({
    command: "remove",
    runtime,
    jobId: "job_team_7",
    agentId: "reviewer",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.deepEqual(removeCalls, ["reviewer_public"]);
  assert.match(result.message, /agent: @reviewer/);
  assert.deepEqual(runtime.conversationAgents, []);
  assert.deepEqual(runtime.explicitConversationAgentRefs, []);
  assert.deepEqual(runtime.enabledAgentRefs, []);
});
