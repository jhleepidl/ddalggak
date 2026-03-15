import test from "node:test";
import assert from "node:assert/strict";
import { LocalPlanner } from "../src/runtime_capabilities/planner.js";
import { loadAgents } from "../src/agents.js";

test("local planner emits normalized planning metadata including plan_source", () => {
  const planner = new LocalPlanner({
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    source: "local",
  });
  const result = planner.plan({
    mode: "run",
    goal: "코드 리팩터링과 검토를 진행해줘",
    seedInstruction: "리팩터링",
    routePlan: null,
    registry: loadAgents(),
    runId: "plan_test_1",
    jobId: "job_plan_1",
    runsDir: "runs",
  });

  assert.equal(result.plan_source, "local");
  assert.ok(result.interpreted_task);
  assert.equal(result.interpreted_task.mode, "run");
  assert.equal(result.interpreted_task.job_id, "job_plan_1");
  assert.ok(result.route_summary);
  assert.equal(result.route_summary.action_count, result.route_plan.actions.length);
  assert.ok(result.planner_metadata);
  assert.equal(result.planner_metadata.planner_type, "local");
  assert.equal(result.planner_metadata.pipeline_version, "control_plane_v2");
  assert.equal(typeof result.planner_metadata.control_mode, "string");
  assert.ok(result.route_plan);
  assert.ok(Array.isArray(result.route_plan.actions));
  assert.ok(typeof result.route_plan.action_source === "string");
  assert.ok(Array.isArray(result.context_packs));
  assert.ok(Array.isArray(result.selected_skill_ids));
  assert.ok(result.runtime_team_snapshot && typeof result.runtime_team_snapshot === "object");
});
