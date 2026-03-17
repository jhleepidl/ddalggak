import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { SkillResolver } from "../src/application/skill_resolver.js";
import { SkillLoader } from "../src/application/skill_loader.js";
import { LegacyContextPackBuilder } from "../src/control_plane/legacy_context_pack_builder.js";

test("legacy context pack builder records skill items and upgrades load level for execution", () => {
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
  const builder = new LegacyContextPackBuilder({
    registry,
    skillLoader: loader,
  });

  const resolved = resolver.resolveForRole({
    roleType: "researcher",
    goal: "claim evidence conflict audit",
  });
  assert.ok(resolved.attachments.length >= 1);
  assert.equal(resolved.attachments[0].load_level, "metadata_only");

  const build = builder.build({
    runId: "run_ctx_1",
    goal: "claim evidence conflict audit with checklist",
    teamPlan: {
      mode: "run",
      roles: [{
        id: "researcher",
        role_type: "researcher",
        role_label: "researcher",
        attached_skills: resolved.attachments,
      }],
      dependencies: [],
      execution_order: ["researcher"],
    },
    runtimeAgents: [{
      instance_id: "inst_res_1",
      template_id: "researcher",
      role_label: "researcher",
      attached_skills: resolved.attachments,
      status: "ready",
    }],
    effectiveActions: [{
      type: "agent_run",
      agent: "researcher",
      prompt: "Use checklist and script to audit unsupported claims",
      inputs: {
        runtime_instance_id: "inst_res_1",
        role_label: "researcher",
      },
    }],
    routeReason: "team-generated route",
  });

  assert.equal(build.context_packs.length, 1);
  assert.equal(build.runtime_agents.length, 1);
  assert.ok(build.runtime_agents[0].context_pack_id);
  assert.ok(build.runtime_agents[0].attached_skills.length >= 1);
  assert.equal(build.runtime_agents[0].attached_skills[0].load_level, "resources");
  assert.equal(build.context_packs[0].skill_items[0].load_level, "resources");
});

test("legacy context pack builder remains backward-compatible for roles without skills", () => {
  const builder = new LegacyContextPackBuilder({
    registry: null,
    skillLoader: null,
  });

  const build = builder.build({
    runId: "run_ctx_compat",
    goal: "plain execution",
    teamPlan: {
      mode: "run",
      roles: [{
        id: "coder",
        role_type: "coder",
        role_label: "coder",
      }],
      dependencies: [],
      execution_order: ["coder"],
    },
    runtimeAgents: [{
      instance_id: "inst_coder_compat",
      template_id: "coder",
      role_label: "coder",
      status: "ready",
    }],
    effectiveActions: [{
      type: "agent_run",
      agent: "coder",
      prompt: "implement feature",
      inputs: {
        runtime_instance_id: "inst_coder_compat",
        role_label: "coder",
      },
    }],
    routeReason: "compat path",
  });

  assert.equal(build.runtime_agents.length, 1);
  assert.equal(build.runtime_agents[0].attached_skills.length, 0);
  assert.ok(build.runtime_agents[0].context_pack_id);
  assert.equal(build.context_packs.length, 1);
  assert.equal(build.context_packs[0].skill_items.length, 0);
  assert.ok(Array.isArray(build.context_packs[0].shared_items));
  assert.ok(Array.isArray(build.context_packs[0].role_specific_items));
  assert.ok(Array.isArray(build.context_packs[0].excluded_items));
  assert.ok(Array.isArray(build.context_packs[0].missing_items));
  assert.ok(Array.isArray(build.context_packs[0].conflicts));
});

test("legacy context pack builder records instructions/resources levels and missing skill diagnostics", () => {
  const registry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  registry.load({ refresh: true });
  const loader = new SkillLoader({ registry });
  const builder = new LegacyContextPackBuilder({
    registry,
    skillLoader: loader,
  });

  const build = builder.build({
    runId: "run_ctx_levels",
    goal: "multi role execution",
    teamPlan: {
      mode: "run",
      roles: [
        {
          id: "messenger",
          role_type: "messenger",
          role_label: "messenger",
          attached_skills: [{
            skill_id: "skill.telegram_briefing.v1",
            selected_by: "skill_resolver",
            load_level: "metadata_only",
            status: "selected",
          }],
        },
        {
          id: "reviewer",
          role_type: "reviewer",
          role_label: "reviewer",
          attached_skills: [{
            skill_id: "skill.claim_evidence_audit.v1",
            selected_by: "skill_resolver",
            load_level: "metadata_only",
            status: "selected",
          }],
        },
        {
          id: "context_curator",
          role_type: "context_curator",
          role_label: "context_curator",
          attached_skills: [{
            skill_id: "skill.unknown_missing.v1",
            selected_by: "manual",
            load_level: "metadata_only",
            status: "selected",
          }],
        },
      ],
      dependencies: [],
      execution_order: ["messenger", "reviewer", "context_curator"],
    },
    runtimeAgents: [
      {
        instance_id: "inst_msg_1",
        template_id: "messenger",
        role_label: "messenger",
        attached_skills: [{
          skill_id: "skill.telegram_briefing.v1",
          selected_by: "skill_resolver",
          load_level: "metadata_only",
          status: "selected",
        }],
      },
      {
        instance_id: "inst_rev_1",
        template_id: "reviewer",
        role_label: "reviewer",
        attached_skills: [{
          skill_id: "skill.claim_evidence_audit.v1",
          selected_by: "skill_resolver",
          load_level: "metadata_only",
          status: "selected",
        }],
      },
      {
        instance_id: "inst_ctx_1",
        template_id: "context_curator",
        role_label: "context_curator",
        attached_skills: [{
          skill_id: "skill.unknown_missing.v1",
          selected_by: "manual",
          load_level: "metadata_only",
          status: "selected",
        }],
      },
    ],
    effectiveActions: [
      {
        type: "agent_run",
        agent: "messenger",
        prompt: "Write telegram summary with concise status",
        inputs: { runtime_instance_id: "inst_msg_1", role_label: "messenger" },
      },
      {
        type: "agent_run",
        agent: "reviewer",
        prompt: "Audit claim evidence with checklist script",
        inputs: { runtime_instance_id: "inst_rev_1", role_label: "reviewer" },
      },
      {
        type: "agent_run",
        agent: "context_curator",
        prompt: "curate context",
        inputs: { runtime_instance_id: "inst_ctx_1", role_label: "context_curator" },
      },
    ],
    routeReason: "schema coverage",
  });

  const byRole = new Map(build.runtime_agents.map((row) => [String(row.role_label), row]));
  assert.equal(byRole.get("messenger").attached_skills[0].load_level, "instructions");
  assert.equal(byRole.get("reviewer").attached_skills[0].load_level, "resources");
  assert.equal(byRole.get("context_curator").attached_skills[0].load_level, "metadata_only");

  const ctxByInstance = new Map(build.context_packs.map((row) => [String(row.target_runtime_agent_instance_id), row]));
  assert.equal(ctxByInstance.get("inst_msg_1").skill_items[0].load_level, "instructions");
  assert.equal(ctxByInstance.get("inst_rev_1").skill_items[0].load_level, "resources");
  assert.equal(ctxByInstance.get("inst_ctx_1").missing_items[0].reason, "missing_registry_entry");
});
