import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeTeamSnapshot } from "../src/application/runtime_metadata.js";

test("runtime team snapshot has normalized downstream-friendly shape", () => {
  const snapshot = createRuntimeTeamSnapshot({
    teamPlan: {
      mode: "run",
      roles: [{ id: "planner" }],
      dependencies: [],
      execution_order: ["planner"],
      reason: "ok",
      budget: {},
    },
    runtimeAgents: [
      {
        instance_id: "inst_1",
        template_id: "planner",
        role_label: "planner",
        provider: "chatgpt",
        model: "chatgpt",
        assigned_goal: "goal",
        capability_tags: ["planning"],
        lens_spec: { mode: "shared_only", budget_tokens: 900 },
        status: "ready",
      },
    ],
  });

  assert.equal(snapshot.source, "team_builder");
  assert.ok(snapshot.generated_at);
  assert.equal(snapshot.team_plan.mode, "run");
  assert.equal(snapshot.runtime_agents.length, 1);
  assert.equal(snapshot.runtime_agents[0].role_label, "planner");
});
