import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeTeamSnapshot,
  buildRuntimeMetadataPatch,
  buildRuntimeRolePayload,
} from "../src/application/runtime_metadata.js";

test("runtime metadata patch exposes additive skill and context-pack fields", () => {
  const snapshot = createRuntimeTeamSnapshot({
    teamPlan: {
      mode: "run",
      roles: [{
        id: "coder",
        role_type: "coder",
        role_label: "coder",
        attached_skills: [{
          skill_id: "skill.run_trace_debugging.v1",
          selected_by: "skill_resolver",
          selection_reason: "debug task",
          load_level: "instructions",
          status: "selected",
        }],
      }],
      dependencies: [],
      execution_order: ["coder"],
      reason: "team selected",
      budget: {},
    },
    runtimeAgents: [{
      instance_id: "inst_coder_1",
      template_id: "coder",
      role_label: "coder",
      attached_skills: [{
        skill_id: "skill.run_trace_debugging.v1",
        selected_by: "skill_resolver",
        selection_reason: "debug task",
        load_level: "instructions",
        status: "selected",
      }],
      context_pack_id: "ctxp_1",
      status: "ready",
    }],
    contextPacks: [{
      id: "ctxp_1",
      run_id: "run_1",
      scope: "role",
      target_runtime_agent_instance_id: "inst_coder_1",
      shared_items: [],
      role_specific_items: [],
      skill_items: [{
        skill_id: "skill.run_trace_debugging.v1",
        load_level: "instructions",
      }],
      excluded_items: [],
      missing_items: [],
      conflicts: [],
      token_budget: { soft_limit: 1200, hard_limit: 2000 },
    }],
    selectedSkillIds: ["skill.run_trace_debugging.v1"],
    skillLoadLevels: {
      inst_coder_1: {
        "skill.run_trace_debugging.v1": "instructions",
      },
    },
    selectionReasonSummary: {
      coder: "skill.run_trace_debugging.v1:debug task",
    },
    skillUsageEvents: [{
      run_id: "run_1",
      runtime_agent_instance_id: "inst_coder_1",
      skill_id: "skill.run_trace_debugging.v1",
      event_type: "attached",
      payload: {},
      created_at: "2026-03-10T00:00:00.000Z",
    }],
    source: "team_builder",
  });

  const patch = buildRuntimeMetadataPatch({
    runtime_team_snapshot: snapshot,
    action_source: "generated_team_actions",
  }, {
    includeFlattened: true,
  });

  assert.ok(Array.isArray(patch.selected_skill_ids));
  assert.ok(patch.selected_skill_ids.includes("skill.run_trace_debugging.v1"));
  assert.equal(patch.context_packs[0].id, "ctxp_1");
  assert.equal(
    patch.skill_load_levels.inst_coder_1["skill.run_trace_debugging.v1"],
    "instructions"
  );
  assert.equal(patch.selection_reason_summary.coder.includes("run_trace_debugging"), true);
  assert.equal(patch.skill_usage_events.length, 1);

  const rolePayload = buildRuntimeRolePayload(snapshot.runtime_agents[0]);
  assert.equal(rolePayload.context_pack_id, "ctxp_1");
  assert.ok(rolePayload.selected_skill_ids.includes("skill.run_trace_debugging.v1"));
});

