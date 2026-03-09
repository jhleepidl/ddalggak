import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRouterPlan,
  normalizeRoutePlan,
  sanitizeSupervisorRoutePlan,
} from "../src/domain/route_plan.js";

test("parseRouterPlan normalizes agent aliases", () => {
  const raw = '{"reason":"r","actions":[{"type":"codex","instruction":"fix"},{"type":"git_summary"}]}'
  const plan = parseRouterPlan(raw, {
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });
  assert.equal(plan.actions[0].type, "agent_run");
  assert.equal(plan.actions[0].agent, "coder");
  assert.equal(plan.actions[1].type, "git_summary");
});

test("normalizeRoutePlan limits actions", () => {
  const plan = normalizeRoutePlan({
    reason: "test",
    actions: [
      { type: "git_summary" },
      { type: "git_summary" },
      { type: "git_summary" },
      { type: "git_summary" },
      { type: "git_summary" },
    ],
  }, { maxActions: 3 });
  assert.equal(plan.actions.length, 3);
});

test("sanitizeSupervisorRoutePlan filters disabled agents and falls back", () => {
  const plan = sanitizeSupervisorRoutePlan({
    reason: "x",
    actions: [
      { type: "run_agent", agent_id: "unknown", goal: "do" },
    ],
  }, {
    message: "코드 수정",
    agents: [{ id: "coder" }],
    pickRuntimeDefaultAgentId: () => "coder",
    findDefaultChatAgentId: () => "coder",
    isWorkLikeMessage: () => true,
    isCodeNotebookRequest: () => false,
    hasCoderDelegation: () => false,
    pickCoderAgentId: () => "coder",
    extractDeliverablesFromMessage: () => ["코드 수정"],
  });
  assert.equal(plan.actions[0].agent_id, "coder");
});
