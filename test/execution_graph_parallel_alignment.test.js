import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeOrchestration } from "../src/application/orchestrator.js";

const registry = {
  agents: [
    { id: "researcher", role_type: "researcher", provider: "gemini", model: "gemini", prompt: "research" },
    { id: "reviewer", role_type: "reviewer", provider: "gemini", model: "gemini", prompt: "review" },
    { id: "messenger", role_type: "messenger", provider: "gemini", model: "gemini", prompt: "synthesize" },
  ],
};

test("spawn_parallel route steps imply matching execution_graph.parallel_groups", () => {
  const orchestration = buildRuntimeOrchestration({
    mode: "run",
    goal: "Compare DART filings and market news across sources, then review and summarize",
    registry,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  const parallelAction = orchestration.route_plan.actions.find((action) => action.type === "spawn_parallel");
  assert.ok(parallelAction);
  assert.ok(Array.isArray(orchestration.team_plan.execution_graph.parallel_groups));
  assert.ok(orchestration.team_plan.execution_graph.parallel_groups.length > 0);
  const parallelGroup = orchestration.team_plan.execution_graph.parallel_groups.find((group) =>
    group.parallel_group_id === parallelAction.inputs.parallel_group_id
  );
  assert.ok(parallelGroup);
  assert.deepEqual(
    [...parallelGroup.instance_ids].sort(),
    parallelAction.agents.map((child) => child.inputs.runtime_instance_id).sort()
  );
});
