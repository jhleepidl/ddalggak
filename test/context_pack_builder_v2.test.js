import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { LegacyContextPackBuilder } from "../src/control_plane/legacy_context_pack_builder.js";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { SkillLoader } from "../src/application/skill_loader.js";

test("legacy context pack builder emits slot-specific researcher and reviewer packs with v2 aliases", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const builder = new LegacyContextPackBuilder({
    registry,
    skillLoader: new SkillLoader({ registry }),
  });

  const result = builder.build({
    runId: "run_ctx_v2_1",
    goal: "Compare DART filing evidence with market news and audit the claims",
    taskInterpretation: {
      task_summary: "Compare DART filing evidence with market news and audit the claims",
      review_policy: "claim_heavy",
      control_mode: "checkpointed",
    },
    teamPlan: {
      slots: [
        {
          slot_id: "slot_research_1",
          role_id: "researcher",
          purpose: "Collect DART filing and market news evidence",
          required_context_types: ["evidence", "citations"],
          attached_skills: [
            {
              skill_id: "skill.kr_equity_analysis.v1",
              selected_by: "test",
              load_level: "metadata_only",
              status: "selected",
            },
          ],
        },
        {
          slot_id: "slot_review_1",
          role_id: "reviewer",
          purpose: "Audit claims and contradictions",
          required_context_types: ["risk", "contradictions"],
          attached_skills: [
            {
              skill_id: "skill.claim_evidence_audit.v1",
              selected_by: "test",
              load_level: "metadata_only",
              status: "selected",
            },
          ],
        },
      ],
      roles: [],
    },
    runtimeAgents: [
      {
        instance_id: "inst_research_1",
        slot_id: "slot_research_1",
        role_id: "researcher",
        role_label: "researcher",
        attached_skills: [
          {
            skill_id: "skill.kr_equity_analysis.v1",
            selected_by: "test",
            load_level: "metadata_only",
            status: "selected",
          },
        ],
      },
      {
        instance_id: "inst_review_1",
        slot_id: "slot_review_1",
        role_id: "reviewer",
        role_label: "reviewer",
        attached_skills: [
          {
            skill_id: "skill.claim_evidence_audit.v1",
            selected_by: "test",
            load_level: "metadata_only",
            status: "selected",
          },
        ],
      },
    ],
    effectiveActions: [
      {
        type: "agent_run",
        agent: "researcher",
        prompt: "Gather DART filing and market news evidence",
        inputs: {
          runtime_instance_id: "inst_research_1",
          slot_id: "slot_research_1",
          role_id: "researcher",
        },
      },
      {
        type: "agent_run",
        agent: "reviewer",
        prompt: "Audit claims and contradictions",
        inputs: {
          runtime_instance_id: "inst_review_1",
          slot_id: "slot_review_1",
          role_id: "reviewer",
        },
      },
    ],
    routeReason: "generated control-plane route",
  });

  const researchPack = result.context_packs.find((pack) => pack.target_instance_id === "inst_research_1");
  const reviewPack = result.context_packs.find((pack) => pack.target_instance_id === "inst_review_1");

  assert.ok(researchPack);
  assert.ok(reviewPack);
  assert.ok(researchPack.context_types.includes("evidence"));
  assert.ok(researchPack.context_types.includes("citations"));
  assert.ok(researchPack.context_types.includes("news"));
  assert.ok(researchPack.context_types.includes("filings"));
  assert.ok(reviewPack.context_types.includes("contradictions"));
  assert.ok(reviewPack.context_types.includes("claim_check"));
  assert.ok(reviewPack.context_types.includes("risk"));
  assert.equal(researchPack.id, researchPack.context_pack_id);
  assert.equal(reviewPack.target_runtime_agent_instance_id, "inst_review_1");
  assert.ok(Array.isArray(researchPack.skill_items));
  assert.equal(typeof researchPack.token_budget, "object");
});
