import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRegistry } from "../src/application/skill_registry.js";
import { SkillResolver } from "../src/application/skill_resolver.js";
import { SkillLoader } from "../src/application/skill_loader.js";
import { ContextPackBuilder } from "../src/application/context_pack_builder.js";

test("context pack builder records skill items and upgrades load level for execution", () => {
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
  const builder = new ContextPackBuilder({
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

