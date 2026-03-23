import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamPlan } from "../src/domain/team_plan.js";
import path from "node:path";
import { SkillRegistryV2 as SkillRegistry } from "../src/catalog/skill_registry_v2.js";
import { SkillResolver } from "../src/control_plane/skill_resolver.js";

test("team plan roles preserve attached_skills and role-level metadata", () => {
  const plan = normalizeTeamPlan({
    mode: "run",
    roles: [
      {
        id: "planner",
        role_type: "planner",
        role_label: "planner",
      },
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

  assert.equal(plan.slots.length, 1);
  assert.equal(plan.roles.length, 1);
  assert.equal(plan.roles[0].id, "researcher");
  assert.equal(plan.roles[0].attached_skills.length, 1);
  assert.equal(plan.roles[0].attached_skills[0].skill_id, "skill.claim_evidence_audit.v1");
  assert.equal(plan.roles[0].attached_skills[0].load_level, "instructions");
  assert.deepEqual(plan.roles[0].depends_on, []);
  assert.equal(plan.roles[0].context_policy.include_evidence, true);
  assert.equal(plan.roles[0].status, "ready");
  assert.equal(plan.supervisor_runtime.planner_requested, true);
});

test("team plan normalization keeps no-skill roles, canonicalizes aliases, and removes planner workers", () => {
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

  assert.equal(plan.roles.length, 1);
  assert.equal(plan.roles[0].id, "builder");
  assert.equal(plan.execution_order[0], "builder");
  assert.equal(plan.supervisor_runtime.planner_requested, true);
  assert.equal(plan.selection_explanations.some((row) => row.reason.includes("planner role normalized")), true);
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
