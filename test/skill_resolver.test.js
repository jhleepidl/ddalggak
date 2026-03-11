import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { SkillResolver } from "../src/application/skill_resolver.js";

test("skill resolver selects compatible skills with metadata_only default", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const resolver = new SkillResolver({
    registry,
    maxSkillsPerRole: 2,
    minScore: 5,
  });

  const resolved = resolver.resolveForRole({
    roleType: "messenger",
    goal: "telegram summary for final result",
    contextHints: ["briefing", "operator update"],
  });

  assert.ok(Array.isArray(resolved.attachments));
  assert.ok(resolved.attachments.length >= 1);
  assert.ok(resolved.attachments.some((row) => row.skill_id === "skill.telegram_briefing.v1"));
  for (const row of resolved.attachments) {
    assert.equal(row.load_level, "metadata_only");
  }
});

