import test from "node:test";
import assert from "node:assert/strict";

import { GocConversationTeamStore } from "../src/runtime_capabilities/conversation_team_store.js";

function createStore(client = {}) {
  return new GocConversationTeamStore({
    client,
    resolveMembershipTarget: async (_client, { threadId = "", conversationId = "" } = {}) => ({
      thread_id: String(threadId || "").trim(),
      conversation_id: String(conversationId || "conv_1").trim(),
      source: "goc",
    }),
  });
}

test("goc team store treats baseline defaults as policy and does not auto-persist them", async () => {
  let listCalls = 0;
  let addCalls = 0;
  let bootstrapCalls = 0;
  const store = createStore({
    async listTeamMembers() {
      listCalls += 1;
      return [];
    },
    async addTeamMember() {
      addCalls += 1;
      return {};
    },
    async bootstrapDefaultAgents() {
      bootstrapCalls += 1;
      return {};
    },
  });

  const result = await store.ensureTeam({
    threadId: "thread_1",
    baselineAgentIds: ["planner", "coder"],
  });

  assert.equal(listCalls, 1);
  assert.equal(addCalls, 0);
  assert.equal(bootstrapCalls, 0);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.baseline_agent_ids, ["planner", "coder"]);
  assert.deepEqual(result.warnings, []);
});

test("goc team store add/remove/enable/disable flows prefer canonical team client methods", async () => {
  const state = [];
  const calls = {
    add: 0,
    patch: 0,
    remove: 0,
  };
  const store = createStore({
    async listTeamMembers() {
      return state;
    },
    async addTeamMember(_target, agentId, enabled) {
      calls.add += 1;
      state.push({
        thread_id: "thread_1",
        conversation_id: "conv_1",
        agent_id: agentId,
        enabled,
      });
      return state[state.length - 1];
    },
    async patchTeamMember(_target, agentId, patch = {}) {
      calls.patch += 1;
      const row = state.find((entry) => entry.agent_id === agentId);
      if (row) row.enabled = patch.enabled !== false;
      return row || { thread_id: "thread_1", conversation_id: "conv_1", agent_id: agentId, enabled: patch.enabled !== false };
    },
    async removeTeamMember(_target, agentId) {
      calls.remove += 1;
      const index = state.findIndex((entry) => entry.agent_id === agentId);
      if (index >= 0) state.splice(index, 1);
      return { ok: true, thread_id: "thread_1", conversation_id: "conv_1", agent_id: agentId };
    },
    async addConversationAgent() {
      throw new Error("deprecated addConversationAgent path should not be primary");
    },
    async patchConversationAgent() {
      throw new Error("deprecated patchConversationAgent path should not be primary");
    },
    async removeConversationAgent() {
      throw new Error("deprecated removeConversationAgent path should not be primary");
    },
  });

  const added = await store.addAgent({
    threadId: "thread_1",
    agentId: "planner",
    enabled: true,
  });
  assert.equal(calls.add, 1);
  assert.equal(added.rows.length, 1);
  assert.equal(added.rows[0].agent_id, "planner");

  const disabled = await store.setAgentEnabled({
    threadId: "thread_1",
    agentId: "planner",
    enabled: false,
  });
  assert.equal(calls.patch, 1);
  assert.equal(disabled.rows[0].enabled, false);

  const removed = await store.removeAgent({
    threadId: "thread_1",
    agentId: "planner",
  });
  assert.equal(calls.remove, 1);
  assert.deepEqual(removed.rows, []);
});

test("goc team store warnings distinguish explicit membership sync failures", async () => {
  const store = createStore({
    async listTeamMembers() {
      throw new Error("GoC API GET /api/threads/thread_1/team failed (404)");
    },
  });

  const result = await store.ensureTeam({
    threadId: "thread_1",
    baselineAgentIds: ["planner"],
  });

  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.baseline_agent_ids, ["planner"]);
  assert.match(result.warnings[0] || "", /team_sync:list_explicit_members:/);
  assert.doesNotMatch(result.warnings[0] || "", /add_baseline_agent|bootstrap_default_agents/);
});
