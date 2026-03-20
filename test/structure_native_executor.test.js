import test from "node:test";
import assert from "node:assert/strict";

import { executeSupervisorActions } from "../src/chat/executor.js";

function createSessionStore() {
  const rows = new Map();
  return {
    get(chatId) {
      return rows.get(String(chatId)) || {};
    },
    upsert(chatId, updater) {
      const key = String(chatId);
      const current = rows.get(key) || {};
      const next = typeof updater === 'function' ? updater(current) : { ...current, ...(updater || {}) };
      rows.set(key, next);
      return next;
    },
  };
}

test("gate_wait actions create pending approval state in the supervisor executor", async () => {
  const sessionStore = createSessionStore();
  const result = await executeSupervisorActions({
    chatId: "chat-1",
    userId: "user-1",
    jobId: "job-1",
    plan: {
      actions: [
        {
          type: "gate_wait",
          label: "Approval Gate",
          inputs: {
            gate_type: "approval",
            approval_required: true,
            incoming_conditions: [{ from_slot_id: "builder", condition: "implementation_ready" }],
          },
        },
      ],
    },
    sessionStore,
  });

  assert.ok(result.pendingApproval);
  assert.equal(result.pendingApproval.gate_type, "approval");
  assert.equal(result.pendingApproval.reason.includes("implementation_ready"), true);
  assert.equal(result.results.some((row) => row.status === "blocked"), true);
  assert.equal(sessionStore.get("chat-1").state, "awaiting_approval");
});

test("committee_consensus blocks when quorum is not met", async () => {
  const sessionStore = createSessionStore();
  const result = await executeSupervisorActions({
    chatId: "chat-2",
    userId: "user-2",
    jobId: "job-2",
    plan: {
      actions: [
        { type: "run_agent", agent_id: "researcher", goal: "member a vote", inputs: { slot_id: "slot_member_a" } },
        {
          type: "committee_consensus",
          label: "Committee consensus check",
          inputs: {
            member_slot_ids: ["slot_member_a", "slot_member_b"],
            consensus_mode: "majority",
            committee_quorum: 2,
          },
        },
      ],
    },
    sessionStore,
    callbacks: {
      async runAgent() {
        return { output: "vote: approve", provider: "gemini", mode: "chat" };
      },
    },
  });

  assert.ok(result.pendingApproval);
  assert.equal(result.pendingApproval.gate_type, "committee_consensus");
  assert.equal(result.pendingApproval.reason.includes("responded=1/2"), true);
});

test("committee_consensus continues when quorum is met", async () => {
  const sessionStore = createSessionStore();
  const result = await executeSupervisorActions({
    chatId: "chat-3",
    userId: "user-3",
    jobId: "job-3",
    plan: {
      actions: [
        { type: "run_agent", agent_id: "researcher", goal: "member a vote", inputs: { slot_id: "slot_member_a" } },
        { type: "run_agent", agent_id: "reviewer", goal: "member b vote", inputs: { slot_id: "slot_member_b" } },
        {
          type: "committee_consensus",
          label: "Committee consensus check",
          inputs: {
            member_slot_ids: ["slot_member_a", "slot_member_b"],
            consensus_mode: "majority",
            committee_quorum: 2,
          },
        },
      ],
    },
    sessionStore,
    callbacks: {
      async runAgent({ action }) {
        return { output: `vote from ${action.inputs.slot_id}`, provider: "gemini", mode: "chat" };
      },
    },
  });

  assert.equal(result.pendingApproval, null);
  assert.equal(result.outputs.some((row) => row.mode === "committee_consensus"), true);
  assert.equal(result.results.some((row) => row.note.includes("committee_ready 2/2")), true);
});

test("route signals activate only the matching conditional branch", async () => {
  const seenSlots = [];
  const result = await executeSupervisorActions({
    chatId: "chat-4",
    userId: "user-4",
    jobId: "job-4",
    plan: {
      actions: [
        {
          type: "run_agent",
          agent_id: "builder",
          goal: "decide next branch",
          inputs: {
            slot_id: "builder",
            outgoing_conditions: [
              { condition: "route_to_review", to_slot_id: "reviewer" },
              { condition: "route_to_finalize", to_slot_id: "judge" },
            ],
          },
        },
        {
          type: "run_agent",
          agent_id: "reviewer",
          goal: "review branch",
          inputs: {
            slot_id: "reviewer",
            incoming_conditions: [{ from_slot_id: "builder", condition: "route_to_review" }],
          },
        },
        {
          type: "run_agent",
          agent_id: "judge",
          goal: "final branch",
          inputs: {
            slot_id: "judge",
            incoming_conditions: [{ from_slot_id: "builder", condition: "route_to_finalize" }],
          },
        },
      ],
    },
    callbacks: {
      async runAgent({ action }) {
        seenSlots.push(String(action?.inputs?.slot_id || ""));
        if (action?.inputs?.slot_id === "builder") {
          return {
            output: 'ROUTE_SIGNALS_JSON\n```json\n{"signals":["route_to_finalize"]}\n```',
            provider: "gemini",
            mode: "chat",
          };
        }
        return {
          output: `ran ${String(action?.inputs?.slot_id || "unknown")}`,
          provider: "gemini",
          mode: "chat",
        };
      },
    },
  });

  assert.deepEqual(seenSlots, ["builder", "judge"]);
  assert.equal(result.outputs.some((row) => Array.isArray(row.route_signals) && row.route_signals.includes("route_to_finalize")), true);
  assert.equal(result.results.some((row) => String(row.note || "").includes("route_to_review")), true);
});

test("committee_consensus can resume from prior outputs passed as initial execution state", async () => {
  const sessionStore = createSessionStore();
  const result = await executeSupervisorActions({
    chatId: "chat-5",
    userId: "user-5",
    jobId: "job-5",
    plan: {
      actions: [
        {
          type: "committee_consensus",
          label: "Committee consensus resume check",
          inputs: {
            member_slot_ids: ["slot_member_a", "slot_member_b"],
            consensus_mode: "majority",
            committee_quorum: 2,
          },
        },
      ],
    },
    sessionStore,
    initialOutputs: [
      { slot_id: "slot_member_a", output: "vote a" },
      { slot_id: "slot_member_b", output: "vote b" },
    ],
  });

  assert.equal(result.pendingApproval, null);
  assert.equal(result.outputs.some((row) => row.mode === "committee_consensus"), true);
  assert.equal(result.results.some((row) => String(row.note || "").includes("committee_ready 2/2")), true);
});


test("tool_proxy_call triggers repair loop and retries verification before downstream review", async () => {
  const seen = [];
  let verificationRuns = 0;
  const result = await executeSupervisorActions({
    chatId: "chat-6",
    userId: "user-6",
    jobId: "job-6",
    plan: {
      actions: [
        {
          type: "tool_proxy_call",
          label: "Run verification",
          inputs: {
            slot_id: "slot_verify",
            repair_target_agent_id: "builder",
            repair_target_slot_id: "slot_builder",
            verifier_agent_id: "reviewer",
            verifier_slot_id: "slot_reviewer",
            repair_attempt_limit: 1,
            outgoing_conditions: [
              { condition: "tests_verified", to_slot_id: "slot_reviewer" },
            ],
          },
        },
        {
          type: "run_agent",
          agent_id: "reviewer",
          goal: "Confirm the repair",
          inputs: {
            slot_id: "slot_reviewer",
            incoming_conditions: [{ from_slot_id: "slot_verify", condition: "tests_verified" }],
          },
        },
      ],
    },
    callbacks: {
      async toolProxyCall() {
        verificationRuns += 1;
        if (verificationRuns === 1) {
          return {
            ok: false,
            text: "tests failed",
            commands: ["npm run test"],
            results: [{ command: "npm run test", ok: false, exitCode: 1, stderr: "expected 2, received 3" }],
            route_signals: ["verification_failed"],
          };
        }
        return {
          ok: true,
          text: "tests passed",
          commands: ["npm run test"],
          results: [{ command: "npm run test", ok: true, exitCode: 0, stdout: "ok" }],
          route_signals: ["tests_verified"],
        };
      },
      async runAgent({ action }) {
        seen.push(String(action?.agent_id || ""));
        return {
          output: `${String(action?.agent_id || "agent")} completed ${String(action?.inputs?.slot_id || "")}`,
          provider: "gemini",
          mode: "chat",
        };
      },
    },
  });

  assert.equal(verificationRuns, 2);
  assert.deepEqual(seen, ["builder", "reviewer", "reviewer"]);
  assert.equal(result.outputs.some((row) => row.agentId === "builder" && row.slot_id === "slot_builder"), true);
  assert.equal(result.outputs.some((row) => row.mode === "tool_proxy_call" && Array.isArray(row.route_signals) && row.route_signals.includes("tests_verified")), true);
  assert.equal(result.results.some((row) => String(row.note || "").includes("tool proxy repaired")), true);
});

test("tool_proxy_call leaves failing verification state when repair loop does not recover", async () => {
  let verificationRuns = 0;
  const result = await executeSupervisorActions({
    chatId: "chat-7",
    userId: "user-7",
    jobId: "job-7",
    plan: {
      actions: [
        {
          type: "tool_proxy_call",
          label: "Run verification",
          inputs: {
            repair_target_agent_id: "builder",
            repair_target_slot_id: "slot_builder",
            repair_attempt_limit: 1,
          },
        },
      ],
    },
    callbacks: {
      async toolProxyCall() {
        verificationRuns += 1;
        return {
          ok: false,
          text: "tests failed again",
          commands: ["npm run test"],
          results: [{ command: "npm run test", ok: false, exitCode: 1, stderr: "still failing" }],
          route_signals: ["verification_failed"],
        };
      },
      async runAgent() {
        return {
          output: "patched once",
          provider: "gemini",
          mode: "chat",
        };
      },
    },
  });

  assert.equal(verificationRuns, 2);
  assert.equal(result.results.some((row) => String(row.note || "").includes("still failing after repair")), true);
  assert.equal(result.outputs.filter((row) => row.mode === "tool_proxy_call").length, 2);
});
