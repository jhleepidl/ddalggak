import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentDisplayIndex } from "../src/shared/agent_labels.js";
import {
  formatChatActionLabel,
  buildApprovalActionSummaryLines,
  buildRoutedDashboardText,
} from "../src/adapters/telegram/preview_formatting.js";
import {
  buildGeminiRetryNoticeText,
} from "../src/adapters/telegram/status_messages.js";

test("formatChatActionLabel keeps publish fallback modes explicit", () => {
  const action = {
    type: "publish_agent",
    agent_node_id: "agent_node_123",
  };
  assert.equal(
    formatChatActionLabel(action, { publishFallbackMode: "agent_node_id" }),
    "publish_agent:agent_node_123"
  );
  assert.equal(
    formatChatActionLabel(action, { publishFallbackMode: "unknown" }),
    "publish_agent:unknown"
  );
});

test("approval summary formatter reuses remaining actions with shared label callback", () => {
  const lines = buildApprovalActionSummaryLines(
    {
      remaining_actions: [
        { type: "run_agent", agent_id: "researcher" },
      ],
    },
    {
      actionLabel: (action) => formatChatActionLabel(action),
    }
  );
  assert.equal(lines.length, 1);
  assert.match(String(lines[0] || ""), /^- run_agent:/);
});

test("routed dashboard formatter emits unified plan/status sections", () => {
  const agentIndex = buildAgentDisplayIndex([
    { id: "researcher", name: "KR Market Analyst" },
  ]);
  const text = buildRoutedDashboardText({
    actions: [
      { type: "run_agent", agent_id: "researcher", goal: "시장 분석" },
    ],
    agentStatus: {
      researcher: { state: "running" },
    },
    agentIndex,
  });
  assert.match(text, /🧭 분담/);
  assert.match(text, /📡 상태/);
  assert.match(text, /KR Market Analyst/);
  assert.doesNotMatch(text, /@researcher/);
});

test("gemini retry notice formatter remains stable after extraction", () => {
  const text = buildGeminiRetryNoticeText({
    retryCount: 2,
    maxRetries: 4,
    agentId: "researcher",
    agentLabel: "KR Market Analyst",
  });
  assert.match(text, /2\/4/);
  assert.match(text, /KR Market Analyst/);
  assert.doesNotMatch(text, /@researcher/);
});
