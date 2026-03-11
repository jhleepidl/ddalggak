import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamPlan } from "../src/domain/team_plan.js";
import path from "node:path";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { SkillResolver } from "../src/application/skill_resolver.js";

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

test("team plan normalization keeps no-skill roles and canonicalizes attachment fields", () => {
  const plan = normalizeTeamPlan({
    mode: "run",
    roles: [
      {
        id: "planner",
        role_type: "planner",
        role_label: "planner",
        attachedSkills: [
          {
            skillId: "SKILL.THREAD_TEAM_RECONCILIATION.V1",
            selectedBy: "",
            selectionReason: "route safety",
            loadLevel: "bad_level",
            status: "invalid_status",
          },
        ],
      },
      {
        id: "coder",
        role_type: "coder",
        role_label: "coder",
      },
    ],
    execution_order: ["planner", "coder"],
  });

  assert.equal(plan.roles.length, 2);
  assert.equal(plan.roles[0].attached_skills.length, 1);
  assert.equal(plan.roles[0].attached_skills[0].skill_id, "skill.thread_team_reconciliation.v1");
  assert.equal(plan.roles[0].attached_skills[0].load_level, "metadata_only");
  assert.equal(plan.roles[0].attached_skills[0].status, "selected");
  assert.equal(plan.roles[1].attached_skills.length, 0);
});

test("compatible roles receive expected skills while incompatible roles stay clean", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const resolver = new SkillResolver({
    registry,
    maxSkillsPerRole: 2,
    minScore: 5,
  });

  const planner = resolver.resolveForRole({
    roleType: "planner",
    goal: "team membership reconciliation and reroute guard",
  });
  const coder = resolver.resolveForRole({
    roleType: "coder",
    goal: "team membership reconciliation and reroute guard",
  });

  assert.ok(planner.attachments.some((row) => row.skill_id === "skill.thread_team_reconciliation.v1"));
  assert.equal(coder.attachments.some((row) => row.skill_id === "skill.thread_team_reconciliation.v1"), false);
});
