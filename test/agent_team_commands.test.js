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

  assert.match(listed.message, /현재 conversation membership/);
  assert.match(listed.message, /@planner, @coder/);
  assert.match(listed.message, /@researcher/);
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
