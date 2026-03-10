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
  const client = {
    ensureConversation: async () => ({
      id: "conv_123",
      thread_id: "thread_123",
      workspace_id: "ws_123",
      account_id: "acct_123",
    }),
  };
  const target = await resolveConversationMembershipTarget(client, {
    threadId: "thread_123",
    source: "unit_test",
  });
  assert.equal(target.thread_id, "thread_123");
  assert.equal(target.conversation_id, "conv_123");
  assert.equal(target.ensured_thread_mismatch, false);
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

test("goc client listConversationAgents uses canonical conversation_id path", async () => {
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
  assert(paths.includes("/api/conversations/conv_1/agents"));
  assert(!paths.includes("/api/conversations/thread_1/agents"));
  const queryAttempt = (captured?.attempts || []).find((attempt) => String(attempt.path || "") === "/api/conversation_agents");
  assert.equal(queryAttempt?.query?.thread_id, "thread_1");
  assert.equal(queryAttempt?.query?.conversation_id, "conv_1");
});

test("goc client addConversationAgent uses canonical conversation_id path", async () => {
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
  assert(paths.includes("/api/conversations/conv_1/agents"));
  assert(!paths.includes("/api/conversations/thread_1/agents"));
  const bodyAttempt = (captured?.attempts || []).find((attempt) => String(attempt.path || "") === "/api/conversation_agents");
  assert.equal(bodyAttempt?.body?.thread_id, "thread_1");
  assert.equal(bodyAttempt?.body?.conversation_id, "conv_1");
  assert.equal(bodyAttempt?.body?.agent_id, "planner");
});
