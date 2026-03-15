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

function createRuntime(store, {
  jobId = "job_team_1",
  baselineDefaultAgentIds = ["builder", "reviewer"],
  conversationAgents = [],
  agentsCatalog = [
    { id: "builder", role_type: "builder" },
    { id: "reviewer", role_type: "reviewer" },
    { id: "researcher", role_type: "researcher" },
    { id: "market_news_researcher", role_type: "researcher" },
  ],
} = {}) {
  return {
    mode: "local",
    runtimeAuthority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
    },
    map: { threadId: `local:${jobId}` },
    conversation: { id: `local:${jobId}`, thread_id: `local:${jobId}` },
    conversationMembershipTarget: {
      thread_id: `local:${jobId}`,
      conversation_id: `local:${jobId}`,
      source: "local",
    },
    baselineDefaultAgentIds,
    conversationAgents,
    agentsCatalog,
    capabilities: {
      conversationTeamStore: store,
    },
  };
}

test("/agents add on a preset pins it as a conversation preference", async () => {
  const store = createLocalStore();
  const runtime = createRuntime(store, {
    jobId: "job_team_preset_pin",
  });
  await store.ensureTeam({
    jobId: "job_team_preset_pin",
    baselineAgentIds: runtime.baselineDefaultAgentIds,
  });

  const result = await runConversationAgentTeamCommand({
    command: "add",
    runtime,
    jobId: "job_team_preset_pin",
    agentId: "market_news_researcher",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(result.message, /conversation preference 추가 완료/);
  assert.deepEqual(result.conversation_preferences.pinned_preset_ids, ["market_news_researcher"]);
  assert.deepEqual(runtime.conversationPreferences.pinned_preset_ids, ["market_news_researcher"]);

  const listed = await runConversationAgentTeamCommand({
    command: "list",
    runtime,
    jobId: "job_team_preset_pin",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.match(listed.message, /현재 team\/preset 상태/);
  assert.match(listed.message, /pinned_presets: @market_news_researcher/);
  assert.match(listed.message, /baseline_defaults: @builder, @reviewer/);
});

test("/agents remove on a canonical role suppresses that role without mutating membership transport", async () => {
  const store = createLocalStore();
  const runtime = createRuntime(store, {
    jobId: "job_team_role_suppress",
    conversationAgents: [
      { agent_id: "builder", enabled: true },
      { agent_id: "reviewer", enabled: true },
    ],
  });
  await store.ensureTeam({
    jobId: "job_team_role_suppress",
    baselineAgentIds: runtime.baselineDefaultAgentIds,
  });

  const result = await runConversationAgentTeamCommand({
    command: "remove",
    runtime,
    jobId: "job_team_role_suppress",
    agentId: "reviewer",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.deepEqual(result.conversation_preferences.suppressed_role_ids, ["reviewer"]);
  assert.deepEqual(runtime.conversationPreferences.suppressed_role_ids, ["reviewer"]);
  assert.deepEqual(result.enabledAgentIds, ["builder"]);
  assert.deepEqual(runtime.conversationAgents, [
    { agent_id: "builder", enabled: true },
    { agent_id: "reviewer", enabled: true },
  ]);
  assert.match(result.message, /suppressed_roles: @reviewer/);
  assert.match(result.message, /effective_team_view: @builder/);
});

test("legacy coder command resolves to builder preference semantics safely", async () => {
  const store = createLocalStore();
  const runtime = createRuntime(store, {
    jobId: "job_team_legacy_coder",
    baselineDefaultAgentIds: ["builder", "researcher"],
  });
  await store.ensureTeam({
    jobId: "job_team_legacy_coder",
    baselineAgentIds: runtime.baselineDefaultAgentIds,
  });

  const disabled = await runConversationAgentTeamCommand({
    command: "disable",
    runtime,
    jobId: "job_team_legacy_coder",
    agentId: "coder",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.deepEqual(disabled.conversation_preferences.suppressed_role_ids, ["builder"]);
  assert.deepEqual(disabled.enabledAgentIds, ["researcher"]);

  const reenabled = await runConversationAgentTeamCommand({
    command: "enable",
    runtime,
    jobId: "job_team_legacy_coder",
    agentId: "coder",
    source: "test_agents_command",
    agentRegistry: { agents: runtime.agentsCatalog },
    ...createFormatterDeps(),
  });

  assert.deepEqual(reenabled.conversation_preferences.suppressed_role_ids, []);
  assert.deepEqual(reenabled.enabledAgentIds, ["builder", "researcher"]);
});

test("applyConversationAgentMutation preserves local catalog validation", async () => {
  const store = createLocalStore();
  const runtime = createRuntime(store, {
    jobId: "job_team_local_validation",
    baselineDefaultAgentIds: ["builder"],
    agentsCatalog: [{ id: "builder" }],
  });
  await store.ensureTeam({
    jobId: "job_team_local_validation",
    baselineAgentIds: runtime.baselineDefaultAgentIds,
  });

  await assert.rejects(
    () => applyConversationAgentMutation({
      runtime,
      jobId: "job_team_local_validation",
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
    jobId: "job_team_goc_validation",
    actionType: "add",
    agentId: "ghost",
    source: "test_agents_command",
  });

  assert.equal(addCalls, 1);
  assert.equal(mutation.verification.confirmed, true);
  assert.deepEqual(runtime.enabledAgentIds, ["ghost"]);
  assert.deepEqual(runtime.conversationAgents, [{ agent_id: "ghost", enabled: true }]);
});
