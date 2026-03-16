import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentDisplayIndex,
  formatChatAgentDisplayName,
  formatAgentDisplayName,
} from "../src/shared/agent_labels.js";
import { buildExplicitTeamReconfigurationActions } from "../src/application/team_config_diff.js";
import { isMutationOnlyTeamSetupPlan } from "../src/chat/action_classification.js";
import {
  shouldTriggerPostMutationReroute,
  buildPostMutationRerouteKey,
  summarizeMembershipMutationConfirmation,
} from "../src/application/approval_flow.js";
import {
  verifyConversationMembershipMutation,
  createMembershipConfirmationError,
} from "../src/application/membership_confirmation.js";
import { executeSupervisorActions } from "../src/chat/executor.js";

test("chat-facing agent display labels prefer human-readable names without id suffix", () => {
  const index = buildAgentDisplayIndex([
    {
      id: "00133bba-0f1a-47fe-a111-92fded8f0001",
      name: "시장 분석가",
    },
  ]);
  const chatLabel = formatChatAgentDisplayName("00133bba-0f1a-47fe-a111-92fded8f0001", index);
  const label = formatAgentDisplayName("00133bba-0f1a-47fe-a111-92fded8f0001", index, {
    includeShortId: true,
  });
  assert.equal(chatLabel, "시장 분석가");
  assert.equal(label, "시장 분석가");
});

test("explicit team reconfiguration diff adds missing members and removes obsolete ones", () => {
  const diff = buildExplicitTeamReconfigurationActions({
    currentMembership: new Map([
      ["planner", true],
      ["researcher", true],
      ["coder", false],
    ]),
    desiredAgentIds: ["planner", "reviewer"],
    existingActions: [],
    allowRemoval: true,
    removalMode: "remove",
  });
  const actionKeys = diff.actions
    .map((action) => `${String(action.type)}:${String(action.agent_id)}`)
    .sort();
  assert.deepEqual(actionKeys, [
    "add_agent_to_conversation:reviewer",
    "remove_agent_from_conversation:coder",
    "remove_agent_from_conversation:researcher",
  ]);
});

test("mutation-only team setup plans are detected", () => {
  assert.equal(isMutationOnlyTeamSetupPlan([
    { type: "add_agent_to_conversation", agent_id: "researcher" },
    { type: "enable_agent", agent_id: "coder" },
    { type: "summarize", hint: "done" },
  ]), true);
  assert.equal(isMutationOnlyTeamSetupPlan([
    { type: "add_agent_to_conversation", agent_id: "researcher" },
    { type: "run_agent", agent_id: "researcher", goal: "analyze" },
  ]), false);
});

test("membership mutation verification requires readback confirmation", () => {
  const ok = verifyConversationMembershipMutation({
    actionType: "add_agent_to_conversation",
    threadId: "thread_1",
    targetAgentId: "researcher",
    expectedPresent: true,
    expectedEnabled: true,
    conversationRows: [
      { agent_id: "researcher", enabled: true },
    ],
  });
  assert.equal(ok.confirmed, true);

  const failed = verifyConversationMembershipMutation({
    actionType: "add_agent_to_conversation",
    threadId: "thread_1",
    targetAgentId: "researcher",
    expectedPresent: true,
    expectedEnabled: true,
    conversationRows: [],
  });
  assert.equal(failed.confirmed, false);
  const err = createMembershipConfirmationError(failed);
  assert.equal(err.membershipConfirmationFailed, true);
  assert.equal(err.code, "MEMBERSHIP_CONFIRMATION_FAILED");
});

test("failed membership readback blocks post-mutation reroute", () => {
  const membershipSummary = summarizeMembershipMutationConfirmation({
    actions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    outputs: [],
    results: [{ label: "add_agent_to_conversation", status: "error", note: "team membership readback mismatch" }],
  });
  assert.equal(membershipSummary.all_confirmed, false);
  assert.equal(membershipSummary.failed_count, 1);
  const decision = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    originalUserText: "시장 분석 보고서 작성해줘",
    forceMode: "normal",
    workLikeHint: true,
    membershipConfirmation: membershipSummary,
    rerouteGuard: { count: 0 },
    rerouteLimit: 1,
  });
  assert.equal(decision.should_reroute, false);
  assert.equal(decision.reason, "membership_confirmation_failed");
});

test("repeated unresolved membership mutations remain blocked without reroute loop", () => {
  const membershipSummary = summarizeMembershipMutationConfirmation({
    actions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    outputs: [],
    results: [{ label: "membership_confirmation", status: "blocked", note: "verification failed" }],
  });
  const first = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    originalUserText: "리서치 보고서 작성해줘",
    forceMode: "normal",
    workLikeHint: true,
    membershipConfirmation: membershipSummary,
    rerouteGuard: { count: 0 },
    rerouteLimit: 1,
  });
  const second = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    originalUserText: "리서치 보고서 작성해줘",
    forceMode: "normal",
    workLikeHint: true,
    membershipConfirmation: membershipSummary,
    rerouteGuard: { count: 1 },
    rerouteLimit: 1,
  });
  assert.equal(first.should_reroute, false);
  assert.equal(first.reason, "membership_confirmation_failed");
  assert.equal(second.should_reroute, false);
  assert.equal(second.reason, "membership_confirmation_failed");
});

test("normal work requests reroute after mutation-only resumed actions", () => {
  const membershipSummary = summarizeMembershipMutationConfirmation({
    actions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "enable_agent", agent_id: "coder" },
      { type: "summarize", hint: "configured" },
    ],
    outputs: [
      { membership_change: { action: "add_agent_to_conversation", target_agent_id: "researcher", confirmed: true } },
      { membership_change: { action: "enable_agent", target_agent_id: "coder", confirmed: true } },
    ],
    results: [],
  });
  const decision = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "enable_agent", agent_id: "coder" },
      { type: "summarize", hint: "configured" },
    ],
    originalUserText: "시장 분석 보고서 작성해줘",
    forceMode: "normal",
    workLikeHint: true,
    membershipConfirmation: membershipSummary,
    rerouteGuard: { count: 0 },
    rerouteLimit: 1,
  });
  assert.equal(decision.should_reroute, true);
  assert.equal(decision.reason, "mutation_only_plan_for_work_request");
});

test("pure team setup requests do not reroute into extra execution", () => {
  const decision = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "remove_agent_from_conversation", agent_id: "coder" },
      { type: "summarize", hint: "configured" },
    ],
    originalUserText: "이 스레드 팀을 재구성해줘",
    forceMode: "normal",
    workLikeHint: false,
    rerouteGuard: { count: 0 },
    rerouteLimit: 1,
  });
  assert.equal(decision.should_reroute, false);
  assert.equal(decision.reason, "team_setup_only_request");
});

test("post-mutation reroute guard prevents infinite reroute loops", () => {
  const key = buildPostMutationRerouteKey({
    jobId: "job_1",
    userText: "보고서 작성해줘",
  });
  const decision = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "summarize" },
    ],
    originalUserText: "보고서 작성해줘",
    forceMode: "work",
    workLikeHint: true,
    rerouteGuard: { key, count: 1 },
    rerouteLimit: 1,
  });
  assert.equal(decision.should_reroute, false);
  assert.equal(decision.blocked_by_guard, true);
  assert.equal(decision.reason, "reroute_limit_reached");
});

test("executor membership mutation output prefers human-readable agent labels", async () => {
  const execution = await executeSupervisorActions({
    chatId: "chat_1",
    userId: "user_1",
    jobId: "job_1",
    plan: {
      actions: [{
        type: "add_agent_to_conversation",
        agent_id: "researcher",
        _mutating_confirmed: true,
      }],
    },
    originalUserText: "팀 구성",
    agents: [
      { id: "researcher", name: "KR Market Analyst", provider: "gemini" },
    ],
    callbacks: {
      addAgentToConversation: async () => ({
        agent_id: "researcher",
        enabled_agents: ["researcher"],
        text: "✅ conversation에 @researcher 추가 완료",
        membership_change: {
          action: "add_agent_to_conversation",
          target_agent_id: "researcher",
          confirmed: true,
        },
      }),
    },
  });

  assert.equal(execution.results[0].status, "ok");
  assert.match(String(execution.results[0].note || ""), /KR Market Analyst/);
  assert.match(String(execution.outputs[0].output || ""), /KR Market Analyst/);
  assert.doesNotMatch(String(execution.outputs[0].output || ""), /@researcher/);
});

test("approval preview summaries prefer agent names when known", async () => {
  const execution = await executeSupervisorActions({
    chatId: "chat_2",
    userId: "user_2",
    jobId: "job_2",
    plan: {
      actions: [{
        type: "enable_agent",
        agent_id: "researcher",
      }],
    },
    originalUserText: "팀 켜줘",
    agents: [
      { id: "researcher", name: "KR Market Analyst", provider: "gemini" },
    ],
    callbacks: {},
  });

  assert.ok(execution.pendingApproval);
  const summaryLine = Array.isArray(execution.pendingApproval.actions_summary)
    ? String(execution.pendingApproval.actions_summary[0] || "")
    : "";
  assert.match(summaryLine, /KR Market Analyst/);
  assert.doesNotMatch(summaryLine, /@researcher/);
  assert.match(String(execution.pendingApproval.action_display_label || ""), /KR Market Analyst/);
  assert.doesNotMatch(String(execution.pendingApproval.action_display_label || ""), /@researcher/);
});
