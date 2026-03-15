import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadAgents } from "../src/agents.js";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { buildRuntimeOrchestration } from "../src/application/orchestrator.js";
import {
  LocalPlanner,
  normalizePlanningRequest,
} from "../src/application/local_planner.js";

test("normalizePlanningRequest canonicalizes planner input aliases", () => {
  const request = normalizePlanningRequest({
    mode: "Run",
    goal: "Implement the feature",
    seedInstruction: "ship it",
    routePlan: {
      reason: "explicit route",
      actions: [{ type: "agent_run", agent: "coder", prompt: "implement", inputs: {} }],
    },
    preferredRoles: ["Coder", "Reviewer", "Coder"],
    maxAgents: 20,
    runId: "run_local_planner_1",
    jobId: "job_local_planner_1",
    runsDir: "runs",
    persistSkillEvents: true,
  });

  assert.equal(request.mode, "run");
  assert.equal(request.goal, "Implement the feature");
  assert.equal(request.seed_instruction, "ship it");
  assert.equal(request.route_plan.reason, "explicit route");
  assert.deepEqual(request.preferred_roles, ["coder", "reviewer"]);
  assert.equal(request.max_agents, 12);
  assert.equal(request.run_id, "run_local_planner_1");
  assert.equal(request.job_id, "job_local_planner_1");
  assert.equal(request.runs_dir, "runs");
  assert.equal(request.persist_skill_events, true);
});

test("LocalPlanner returns canonical normalized planning result", () => {
  const registry = loadAgents();
  const skillRegistry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  const planner = new LocalPlanner({
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    source: "local",
    orchestrationBuilder: (input) => buildRuntimeOrchestration({
      ...input,
      skillRegistry,
    }),
  });

  const result = planner.plan({
    mode: "run",
    goal: "팀 멤버십 검증 후 telegram summary를 작성해줘",
    seedInstruction: "membership and summary",
    routePlan: null,
    registry,
    preferredRoles: ["reviewer"],
    maxAgents: 5,
    runId: "run_local_planner_2",
    jobId: "job_local_planner_2",
    runsDir: "runs",
    persistSkillEvents: true,
  });

  assert.equal(result.plan_source, "local");
  assert.equal(result.interpreted_task.mode, "run");
  assert.equal(result.interpreted_task.goal, "팀 멤버십 검증 후 telegram summary를 작성해줘");
  assert.equal(result.interpreted_task.has_route_recommendation, false);
  assert.equal(result.planner_metadata.planner_type, "local");
  assert.equal(result.planner_metadata.plan_source, "local");
  assert.equal(result.planner_metadata.pipeline_version, "control_plane_v2");
  assert.ok(Array.isArray(result.route_plan.actions));
  assert.ok(Array.isArray(result.team_plan.slots));
  assert.ok(result.team_plan.slots.length > 0);
  assert.ok(Array.isArray(result.runtime_agents));
  assert.equal(result.runtime_agents.some((agent) => agent.role_id === "deprecated_control_plane_only"), false);
  assert.equal(result.runtime_agents.some((agent) => ["coder", "messenger", "planner"].includes(agent.role_id)), false);
  assert.ok(Array.isArray(result.context_packs));
  assert.ok(Array.isArray(result.selected_skill_ids));
  assert.ok(typeof result.skill_load_levels === "object");
  assert.ok(result.runtime_team_snapshot && typeof result.runtime_team_snapshot === "object");
  assert.equal(
    result.route_plan.actions
      .filter((action) => action.type === "agent_run" || action.type === "synthesize_final")
      .every((action) => !["coder", "messenger", "planner"].includes(String(action.agent || "").trim().toLowerCase())),
    true
  );
});

test("LocalPlanner preserves key orchestration behavior while remaining the canonical entry", () => {
  const registry = loadAgents();
  const planner = new LocalPlanner({
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    source: "local_fallback",
  });
  const request = {
    mode: "continue",
    goal: "코드 리팩터링과 검토를 진행해줘",
    seedInstruction: "리팩터링",
    routePlan: {
      reason: "explicit planner route",
      actions: [
        { type: "agent_run", agent: "researcher", prompt: "analyze", inputs: {} },
        { type: "git_summary" },
      ],
    },
    registry,
    runId: "run_local_planner_3",
    jobId: "job_local_planner_3",
    runsDir: "runs",
  };

  const result = planner.plan(request);
  const orchestration = buildRuntimeOrchestration({
    mode: request.mode,
    goal: request.goal,
    seedInstruction: request.seedInstruction,
    routePlan: request.routePlan,
    registry: request.registry,
    preferredRoles: [],
    maxAgents: 6,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    runId: request.runId,
    jobId: request.jobId,
    runsDir: request.runsDir,
    persistSkillEvents: false,
  });

  assert.equal(result.plan_source, "local_fallback");
  assert.equal(result.route_plan.action_source, orchestration.route_plan.action_source);
  assert.equal(result.route_plan.reason, orchestration.route_plan.reason);
  assert.deepEqual(
    result.route_plan.actions.map((action) => action.type),
    orchestration.route_plan.actions.map((action) => action.type)
  );
  assert.deepEqual(result.selected_skill_ids, orchestration.selected_skill_ids);
  assert.equal(result.route_summary.action_count, orchestration.route_plan.actions.length);
});
