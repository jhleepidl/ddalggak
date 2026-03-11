import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry } from "../src/application/skill_registry.js";

test("skill registry loads manifests from skills directory", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  const loaded = registry.load({ refresh: true });
  assert.ok(Array.isArray(loaded.skills));
  assert.ok(loaded.skills.length >= 6);

  const threadSkill = registry.getById("skill.thread_team_reconciliation.v1");
  assert.ok(threadSkill);
  assert.equal(threadSkill.slug, "thread_team_reconciliation");
  assert.equal(threadSkill.instructions_ref, "SKILL.md");
  assert.ok(threadSkill.resource_refs.includes("checklist.md"));
});

