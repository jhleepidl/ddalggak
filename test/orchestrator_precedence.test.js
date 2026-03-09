import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeOrchestration } from "../src/application/orchestrator.js";

const registry = {
  agents: [
    { id: "planner", role_type: "planner", provider: "chatgpt", model: "chatgpt", prompt: "plan" },
    { id: "researcher", role_type: "researcher", provider: "gemini", model: "gemini", prompt: "research" },
    { id: "coder", role_type: "coder", provider: "codex", model: "codex", prompt: "code" },
    { id: "reviewer", role_type: "reviewer", provider: "gemini", model: "gemini", prompt: "review" },
  ],
};

test("explicit route actions take precedence over generated team actions", () => {
  const explicitRoute = {
    reason: "explicit planner route",
    actions: [
      { type: "agent_run", agent: "researcher", prompt: "analyze" },
      { type: "git_summary" },
    ],
  };

  const orchestration = buildRuntimeOrchestration({
    mode: "run",
    goal: "분석 후 구현",
    seedInstruction: "analyze",
    routePlan: explicitRoute,
    registry,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  assert.equal(orchestration.route_plan.action_source, "explicit_route_plan");
  assert.deepEqual(
    orchestration.route_plan.actions.map((a) => a.type),
    ["agent_run", "git_summary"]
  );
});

test("generated team actions are used when no explicit route plan exists", () => {
  const orchestration = buildRuntimeOrchestration({
    mode: "run",
    goal: "코드 구현 진행",
    seedInstruction: "구현해줘",
    routePlan: null,
    registry,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  assert.equal(orchestration.route_plan.action_source, "generated_team_actions");
  assert.ok(Array.isArray(orchestration.route_plan.actions));
  assert.ok(orchestration.route_plan.actions.length > 0);
});

test("default fallback route is used when no explicit route and no team actions are available", () => {
  const orchestration = buildRuntimeOrchestration({
    mode: "chat",
    goal: "아무거나",
    seedInstruction: "",
    routePlan: null,
    registry: { agents: [] },
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  assert.equal(orchestration.route_plan.action_source, "default_fallback_route");
  assert.deepEqual(
    orchestration.route_plan.actions.map((action) => action.type),
    ["agent_run", "agent_run", "git_summary"]
  );
});
