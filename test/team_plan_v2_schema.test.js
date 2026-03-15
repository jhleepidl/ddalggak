import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamPlan, validateTeamPlan } from "../src/domain/team_plan.js";

test("team plan v2 emits canonical slots, runtime agents, and supervisor runtime", () => {
  const plan = normalizeTeamPlan({
    team_plan_id: "team_plan_v2_1",
    mode: "run",
    reason: "legacy compat",
    roles: [
      { id: "planner", role_type: "planner", role_label: "planner" },
      {
        id: "coder",
        role_type: "coder",
        role_label: "coder",
        attached_skills: [{
          skill_id: "skill.run_trace_debugging.v1",
          selected_by: "manual",
          load_level: "instructions",
          status: "selected",
        }],
      },
      { id: "reviewer", role_type: "reviewer", role_label: "reviewer" },
    ],
    runtime_agents: [
      {
        runtimeInstanceId: "inst_builder_1",
        templateId: "coder",
        roleLabel: "builder",
        attachedSkills: [{
          skillId: "skill.run_trace_debugging.v1",
          selectedBy: "manual",
          loadLevel: "instructions",
          status: "selected",
        }],
      },
    ],
    execution_order: ["planner", "coder", "reviewer"],
    dependencies: [{ from: "coder", to: "reviewer" }],
  });

  assert.equal(plan.team_plan_id, "team_plan_v2_1");
  assert.equal(plan.supervisor_runtime.planner_requested, true);
  assert.deepEqual(plan.slots.map((slot) => slot.role_id), ["builder", "reviewer"]);
  assert.equal(plan.runtime_agents.length, 1);
  assert.equal(plan.runtime_agents[0].role_id, "builder");
  assert.equal(plan.roles.some((role) => role.id === "planner"), false);
  assert.deepEqual(plan.execution_graph.order, ["slot_builder_2", "slot_reviewer_3"]);
  assert.deepEqual(plan.execution_order, ["builder", "reviewer"]);
  assert.equal(plan.authority_graph.length, 2);
  assert.equal(plan.selection_explanations.some((row) => row.reason.includes("planner role normalized")), true);
});

test("team plan validation rejects planner as a runtime worker role", () => {
  const validation = validateTeamPlan({
    slots: [{ slot_id: "slot_planner", role_id: "planner" }],
    runtime_agents: [{
      instance_id: "inst_legacy_planner",
      role_id: "planner",
      role_label: "planner",
      template_id: "planner",
    }],
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("slots_required"));
});
