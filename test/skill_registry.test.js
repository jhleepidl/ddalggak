import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistryV2 as SkillRegistry } from "../src/catalog/skill_registry_v2.js";

test("skill registry loads manifests from skills directory", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  const loaded = registry.load({ refresh: true });
  assert.ok(Array.isArray(loaded.skills));
  assert.ok(loaded.skills.length >= 6);

  const threadSkill = registry.getById("skill.thread_team_reconciliation.v1");
  assert.ok(threadSkill);
  assert.equal(threadSkill.skill_id, "skill.thread_team_reconciliation.v1");
  assert.equal(threadSkill.slug, "thread_team_reconciliation");
  assert.equal(threadSkill.title, "Thread Team Reconciliation");
  assert.equal(threadSkill.kind, "method");
  assert.equal(threadSkill.instructions_ref, "SKILL.md");
  assert.ok(threadSkill.resource_refs.includes("checklist.md"));
});

test("skill registry skips invalid manifests and normalizes canonical defaults", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-"));
  const validDir = path.join(tmpRoot, "custom_skill");
  const brokenDir = path.join(tmpRoot, "broken_json");
  const emptyDir = path.join(tmpRoot, "empty_manifest");
  fs.mkdirSync(validDir, { recursive: true });
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  fs.writeFileSync(path.join(validDir, "manifest.json"), JSON.stringify({
    name: "Custom Skill",
    version: "",
    capability_tags: ["Evidence", "evidence", "  "],
    trigger_terms: [" CLAIM ", "claim"],
    compatible_roles: ["Researcher", "reviewer", "researcher"],
  }, null, 2));
  fs.writeFileSync(path.join(brokenDir, "manifest.json"), "{ invalid json");
  fs.writeFileSync(path.join(emptyDir, "manifest.json"), JSON.stringify({}, null, 2));

  const logs = [];
  const registry = new SkillRegistry({
    skillsDir: tmpRoot,
    logger: (line) => logs.push(String(line || "")),
  });
  const loaded = registry.load({ refresh: true });
  assert.equal(loaded.skills.length, 1);
  assert.ok(logs.some((line) => line.includes("[skill-registry] loaded=1")));

  const skill = loaded.skills[0];
  assert.equal(skill.id, "skill.custom_skill.v1");
  assert.equal(skill.skill_id, "skill.custom_skill.v1");
  assert.equal(skill.slug, "custom_skill");
  assert.equal(skill.title, "Custom Skill");
  assert.equal(skill.instructions_ref, "SKILL.md");
  assert.deepEqual(skill.capability_tags, ["evidence"]);
  assert.deepEqual(skill.tags, ["evidence"]);
  assert.deepEqual(skill.trigger_terms, ["claim"]);
  assert.deepEqual(skill.compatible_roles, ["researcher", "reviewer"]);
  assert.equal(skill.visibility, "internal");
  assert.equal(skill.status, "active");
});

test("registry list filters incompatible roles without breaking no-role listing", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });

  const reviewerSkills = registry.list({ roleType: "reviewer" });
  const coderSkills = registry.list({ roleType: "coder" });
  assert.ok(reviewerSkills.some((row) => row.id === "skill.claim_evidence_audit.v1"));
  assert.equal(coderSkills.some((row) => row.id === "skill.claim_evidence_audit.v1"), false);

  const allVisible = registry.list();
  assert.ok(allVisible.length >= reviewerSkills.length);
});
