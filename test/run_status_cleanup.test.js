import test from "node:test";
import assert from "node:assert/strict";
import {
  wasInterruptedByReplan,
  markActionsSkipped,
} from "../src/application/run_status_cleanup.js";

test("wasInterruptedByReplan detects interrupt and pending-remaining states", () => {
  assert.equal(wasInterruptedByReplan({
    results: [{ label: "interrupt", status: "skip" }],
    remainingActions: [],
    pendingApproval: null,
  }), true);

  assert.equal(wasInterruptedByReplan({
    results: [],
    remainingActions: [{ type: "run_agent", agent_id: "researcher" }],
    pendingApproval: null,
  }), true);

  assert.equal(wasInterruptedByReplan({
    results: [{ status: "skip", note: "replan requested before run_agent" }],
    remainingActions: [{ type: "run_agent", agent_id: "researcher" }],
    pendingApproval: { id: "appr_1" },
  }), false);
});

test("markActionsSkipped marks all actions with shared reason", async () => {
  const calls = [];
  const recorder = {
    async markStepSkipped(action, meta) {
      calls.push({
        action,
        meta,
      });
    },
  };
  const actions = [
    { type: "run_agent", agent_id: "researcher" },
    { type: "run_agent", agent_id: "coder" },
  ];

  await markActionsSkipped(recorder, actions, {
    reason: "awaiting_approval",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].meta.reason, "awaiting_approval");
  assert.equal(calls[1].meta.reason, "awaiting_approval");
});
