import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentDisplayIndex,
  formatAgentDisplayName,
} from "../src/shared/agent_labels.js";
import { buildExplicitTeamReconfigurationActions } from "../src/application/team_config_diff.js";
import { isMutationOnlyTeamSetupPlan } from "../src/chat/action_classification.js";
import {
  shouldTriggerPostMutationReroute,
  buildPostMutationRerouteKey,
} from "../src/application/approval_flow.js";

test("agent display labels prefer human-readable name with short id suffix", () => {
  const index = buildAgentDisplayIndex([
    {
      id: "00133bba-0f1a-47fe-a111-92fded8f0001",
      name: "시장 분석가",
    },
  ]);
  const label = formatAgentDisplayName("00133bba-0f1a-47fe-a111-92fded8f0001", index, {
    includeShortId: true,
  });
  assert.equal(label, "시장 분석가 [00133bba]");
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

test("normal work requests reroute after mutation-only resumed actions", () => {
  const decision = shouldTriggerPostMutationReroute({
    resumedActions: [
      { type: "add_agent_to_conversation", agent_id: "researcher" },
      { type: "enable_agent", agent_id: "coder" },
      { type: "summarize", hint: "configured" },
    ],
    originalUserText: "시장 분석 보고서 작성해줘",
    forceMode: "normal",
    workLikeHint: true,
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
