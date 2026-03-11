import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamPlan } from "../src/domain/team_plan.js";

test("team plan roles preserve attached_skills and role-level metadata", () => {
  const plan = normalizeTeamPlan({
    mode: "run",
    roles: [
      {
        id: "researcher",
        role_type: "researcher",
        role_label: "researcher",
        template_id: "researcher",
        attached_skills: [
          {
            skill_id: "skill.claim_evidence_audit.v1",
            selected_by: "manual",
            selection_reason: "fact checks required",
            load_level: "instructions",
            status: "selected",
          },
        ],
        depends_on: ["planner"],
        context_policy: { include_evidence: true },
        status: "ready",
      },
    ],
    dependencies: [{ from: "planner", to: "researcher" }],
    execution_order: ["researcher"],
  });

  assert.equal(plan.roles.length, 1);
  assert.equal(plan.roles[0].attached_skills.length, 1);
  assert.equal(plan.roles[0].attached_skills[0].skill_id, "skill.claim_evidence_audit.v1");
  assert.equal(plan.roles[0].attached_skills[0].load_level, "instructions");
  assert.deepEqual(plan.roles[0].depends_on, ["planner"]);
  assert.equal(plan.roles[0].context_policy.include_evidence, true);
  assert.equal(plan.roles[0].status, "ready");
});

