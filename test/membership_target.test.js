import test from "node:test";
import assert from "node:assert/strict";

import { GocClient } from "../src/goc_client.js";
import {
  normalizeConversationMembershipTarget,
  resolveConversationMembershipTarget,
} from "../src/application/membership_target.js";
import { summarizeConversationReadback } from "../src/application/membership_confirmation.js";

test("normalizeConversationMembershipTarget supports thread/conversation id aliases", () => {
  const normalized = normalizeConversationMembershipTarget({
    threadId: "thread_1",
    conversationId: "conv_1",
    workspaceId: "ws_1",
    accountId: "acct_1",
  });
  assert.equal(normalized.thread_id, "thread_1");
  assert.equal(normalized.conversation_id, "conv_1");
  assert.equal(normalized.workspace_id, "ws_1");
  assert.equal(normalized.account_id, "acct_1");
});

test("resolveConversationMembershipTarget keeps requested thread scope", async () => {
  let capturedOptions = null;
  const client = {
    ensureConversation: async (_threadId, options = {}) => {
      capturedOptions = options;
      return ({
      id: "conv_123",
      thread_id: "thread_123",
      workspace_id: "ws_123",
      account_id: "acct_123",
      });
    },
  };
  const target = await resolveConversationMembershipTarget(client, {
    threadId: "thread_123",
    source: "unit_test",
  });
  assert.equal(target.thread_id, "thread_123");
  assert.equal(target.conversation_id, "conv_123");
  assert.equal(target.ensured_thread_mismatch, false);
  assert.equal(capturedOptions?.bootstrapDefaults, false);
});

test("resolveConversationMembershipTarget can skip ensureConversation for passive reads", async () => {
  let ensureCalls = 0;
  const client = {
    ensureConversation: async () => {
      ensureCalls += 1;
      return { id: "conv_ignored", thread_id: "thread_ignored" };
    },
  };
  const target = await resolveConversationMembershipTarget(client, {
    threadId: "thread_readonly",
    conversationId: "conv_readonly",
    source: "unit_test_readonly",
    ensureConversation: false,
  });
  assert.equal(ensureCalls, 0);
  assert.equal(target.thread_id, "thread_readonly");
  assert.equal(target.conversation_id, "conv_readonly");
  assert.equal(target.ensure_conversation_used, false);
});

test("resolveConversationMembershipTarget detects ensureConversation thread mismatch without switching", async () => {
  const client = {
    ensureConversation: async () => ({
      id: "conv_from_other_thread",
      thread_id: "thread_other",
    }),
  };
  const target = await resolveConversationMembershipTarget(client, {
    threadId: "thread_expected",
    conversationId: "conv_expected",
    source: "unit_test_mismatch",
  });
  assert.equal(target.thread_id, "thread_expected");
  assert.equal(target.conversation_id, "conv_expected");
  assert.equal(target.ensured_thread_mismatch, true);
  assert.equal(target.mismatch_reason, "ensure_conversation_thread_mismatch");
});

test("summarizeConversationReadback exposes readback thread mismatch signal", () => {
  const summary = summarizeConversationReadback([
    { agent_id: "researcher", enabled: true, thread_id: "thread_other" },
  ], {
    targetAgentId: "researcher",
    targetThreadId: "thread_expected",
  });
  assert.equal(summary.target_present, true);
  assert.equal(summary.target_enabled, true);
  assert.equal(summary.expected_thread_seen, false);
  assert.deepEqual(summary.readback_thread_ids, ["thread_other"]);
});

test("goc client listConversationAgents prefers canonical thread team routes", async () => {
  const client = new GocClient({
    apiBase: "https://example.invalid",
    serviceKey: "svc",
  });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return [];
  };

  await client.listConversationAgents({
    thread_id: "thread_1",
    conversation_id: "conv_1",
  });
  const paths = (captured?.attempts || []).map((attempt) => String(attempt.path || ""));
  assert.equal(paths[0], "/api/threads/thread_1/team");
  assert(paths.includes("/api/threads/thread_1/team/members"));
  assert(paths.includes("/api/conversations/conv_1/agents"));
  const queryAttempt = (captured?.attempts || []).find((attempt) => String(attempt.path || "") === "/api/conversation_agents");
  assert.equal(queryAttempt?.query?.thread_id, "thread_1");
  assert.equal(queryAttempt?.query?.conversation_id, "conv_1");
});

test("goc client addConversationAgent prefers canonical thread team member routes", async () => {
  const client = new GocClient({
    apiBase: "https://example.invalid",
    serviceKey: "svc",
  });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return { id: "membership_1", thread_id: "thread_1", conversation_id: "conv_1", agent_id: "planner", enabled: true };
  };

  await client.addConversationAgent({
    thread_id: "thread_1",
    conversation_id: "conv_1",
  }, "planner", true);
  const paths = (captured?.attempts || []).map((attempt) => String(attempt.path || ""));
  assert.equal(paths[0], "/api/threads/thread_1/team/members");
  assert(paths.includes("/api/conversations/conv_1/agents"));
  const bodyAttempt = (captured?.attempts || []).find((attempt) => String(attempt.path || "") === "/api/conversation_agents");
  assert.equal(bodyAttempt?.body?.thread_id, "thread_1");
  assert.equal(bodyAttempt?.body?.conversation_id, "conv_1");
  assert.equal(bodyAttempt?.body?.agent_id, "planner");
});

test("goc client patchConversationAgent prefers canonical thread team member routes", async () => {
  const client = new GocClient({
    apiBase: "https://example.invalid",
    serviceKey: "svc",
  });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return { id: "membership_1", thread_id: "thread_1", agent_id: "planner", enabled: false };
  };

  await client.patchConversationAgent({
    thread_id: "thread_1",
    conversation_id: "conv_1",
  }, "planner", { enabled: false });
  const paths = (captured?.attempts || []).map((attempt) => String(attempt.path || ""));
  assert.equal(captured?.method, "PATCH");
  assert.equal(paths[0], "/api/threads/thread_1/team/members/planner");
  assert(paths.includes("/api/conversations/conv_1/agents/planner"));
});

test("goc client removeConversationAgent prefers canonical thread team member routes", async () => {
  const client = new GocClient({
    apiBase: "https://example.invalid",
    serviceKey: "svc",
  });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return { ok: true };
  };

  await client.removeConversationAgent({
    thread_id: "thread_1",
    conversation_id: "conv_1",
  }, "planner");
  const paths = (captured?.attempts || []).map((attempt) => String(attempt.path || ""));
  assert.equal(captured?.method, "DELETE");
  assert.equal(paths[0], "/api/threads/thread_1/team/members/planner");
  assert(paths.includes("/api/conversations/conv_1/agents/planner"));
});


test('goc client getTeamConfig prefers canonical thread config routes', async () => {
  const client = new GocClient({
    apiBase: 'https://example.invalid',
    serviceKey: 'svc',
  });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return { ok: true };
  };

  await client.getTeamConfig({ threadId: 'thread_cfg_1' });
  const paths = (captured?.attempts || []).map((attempt) => String(attempt.path || ''));
  assert.equal(captured?.method, 'GET');
  assert.deepEqual(paths, [
    '/api/threads/thread_cfg_1/team/config',
    '/threads/thread_cfg_1/team/config',
  ]);
});

test('goc client getTeamBlueprint unwraps manifest payload', async () => {
  const client = new GocClient({
    apiBase: 'https://example.invalid',
    serviceKey: 'svc',
  });
  client._requestAny = async () => ({
    manifest: {
      kind: 'ddalggak_team_blueprint',
      thread_id: 'thread_bp_1',
    },
  });

  const manifest = await client.getTeamBlueprint({ threadId: 'thread_bp_1' });
  assert.equal(manifest.kind, 'ddalggak_team_blueprint');
  assert.equal(manifest.thread_id, 'thread_bp_1');
});
