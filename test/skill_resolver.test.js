import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistryV2 as SkillRegistry } from "../src/catalog/skill_registry_v2.js";
import { SkillResolver } from "../src/control_plane/skill_resolver.js";
import { SkillLoader } from "../src/application/skill_loader.js";

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

test("skill resolver picks representative skills for reconciliation/audit/kr-equity tasks", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const resolver = new SkillResolver({
    registry,
    maxSkillsPerRole: 2,
    minScore: 5,
  });

  const reconciliation = resolver.resolveForRole({
    roleType: "planner",
    goal: "thread team membership reconciliation with add/remove reroute safety",
  });
  assert.ok(reconciliation.attachments.some((row) => row.skill_id === "skill.thread_team_reconciliation.v1"));
  assert.ok(reconciliation.attachments.length <= 2);

  const audit = resolver.resolveForRole({
    roleType: "reviewer",
    goal: "claim evidence audit and conflict detection",
  });
  assert.ok(audit.attachments.some((row) => row.skill_id === "skill.claim_evidence_audit.v1"));
  assert.ok(audit.attachments.length <= 2);

  const krEquity = resolver.resolveForRole({
    roleType: "researcher",
    goal: "KOSPI valuation for Korean stock thesis",
  });
  assert.ok(krEquity.attachments.some((row) => row.skill_id === "skill.kr_equity_analysis.v1"));
  assert.ok(krEquity.attachments.length <= 2);

  const incompatible = resolver.resolveForRole({
    roleType: "coder",
    goal: "KOSPI valuation for Korean stock thesis",
  });
  assert.equal(incompatible.attachments.some((row) => row.skill_id === "skill.kr_equity_analysis.v1"), false);

  const canonicalBuilder = resolver.resolveForRole({
    roleType: "builder",
    goal: "KOSPI valuation for Korean stock thesis",
  });
  assert.equal(canonicalBuilder.attachments.some((row) => row.skill_id === "skill.kr_equity_analysis.v1"), false);
});

test("resolver defaults metadata_only and loader upgrades to instructions/resources when needed", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const resolver = new SkillResolver({
    registry,
    maxSkillsPerRole: 1,
    minScore: 5,
  });
  const loader = new SkillLoader({ registry });

  const resolved = resolver.resolveForRole({
    roleType: "reviewer",
    goal: "claim evidence audit",
  });
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.attachments[0].load_level, "metadata_only");

  const upgraded = loader.resolveLoadLevelForExecution({
    currentLevel: resolved.attachments[0].load_level,
    roleType: "reviewer",
    goal: "claim evidence audit",
    actionPrompt: "Use checklist script and trace debug rules",
    attachment: resolved.attachments[0],
    skillPackage: registry.resolve(resolved.attachments[0].skill_id),
  });
  assert.equal(upgraded, "resources");
});

test("skill resolver resolves attachments per capability slot, not just per legacy role label", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const resolver = new SkillResolver({
    registry,
    maxSkillsPerRole: 2,
    minScore: 5,
  });

  const resolution = resolver.resolveForTeam({
    goal: "한국 주식 리서치 후 claim evidence audit를 해줘",
    taskInterpretation: {
      task_summary: "한국 주식 리서치 후 claim evidence audit를 해줘",
      domain_hints: ["finance", "claims"],
    },
    teamPlan: {
      slots: [
        {
          slot_id: "slot_research_finance",
          role_id: "researcher",
          purpose: "Gather KR equity evidence",
          preferred_skill_ids: ["skill.kr_equity_analysis.v1"],
          required_context_types: ["evidence", "citations"],
        },
        {
          slot_id: "slot_review_claims",
          role_id: "reviewer",
          purpose: "Audit claims and contradictions",
          preferred_skill_ids: ["skill.claim_evidence_audit.v1"],
          required_context_types: ["risk", "contradictions"],
        },
      ],
    },
  });

  assert.ok(Array.isArray(resolution.slot_skill_map.slot_research_finance));
  assert.ok(Array.isArray(resolution.slot_skill_map.slot_review_claims));
  assert.ok(resolution.slot_skill_map.slot_research_finance.some((row) => row.skill_id === "skill.kr_equity_analysis.v1"));
  assert.ok(resolution.slot_skill_map.slot_review_claims.some((row) => row.skill_id === "skill.claim_evidence_audit.v1"));
});
