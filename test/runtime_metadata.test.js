import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeTeamSnapshot,
  normalizeRuntimeTeamSnapshot,
  normalizeRuntimeMetadataEnvelope,
  normalizeActionSource,
  normalizeRuntimeAuthority,
  buildRuntimeMetadataPatch,
  buildRuntimeRolePayload,
} from "../src/application/runtime_metadata.js";

test("runtime team snapshot has normalized downstream-friendly shape", () => {
  const snapshot = createRuntimeTeamSnapshot({
    teamPlan: {
      mode: "run",
      roles: [{ id: "planner" }],
      dependencies: [],
      execution_order: ["planner"],
      reason: "ok",
      budget: {},
    },
    runtimeAgents: [
      {
        instance_id: "inst_1",
        template_id: "planner",
        role_label: "planner",
        provider: "chatgpt",
        model: "chatgpt",
        assigned_goal: "goal",
        capability_tags: ["planning"],
        lens_spec: { mode: "shared_only", budget_tokens: 900 },
        status: "ready",
      },
    ],
  });

  assert.equal(snapshot.source, "team_builder");
  assert.ok(snapshot.generated_at);
  assert.equal(snapshot.team_plan.mode, "run");
  assert.equal(snapshot.runtime_agents.length, 1);
  assert.equal(snapshot.runtime_agents[0].role_label, "planner");
});

test("runtime metadata normalization accepts camelCase snapshot input", () => {
  const normalized = normalizeRuntimeTeamSnapshot({
    runtimeTeamSnapshot: {
      teamPlan: { mode: "run", roles: [{ id: "coder" }] },
      runtimeAgents: [
        {
          runtimeInstanceId: "inst_coder_1",
          templateId: "Coder",
          roleLabel: "Coder",
          provider: "CoDeX",
          model: "gpt-5-codex",
          capabilityTags: ["Coding"],
          runtimeStatus: "RUNNING",
        },
      ],
      generatedAt: "2026-03-10T00:00:00.000Z",
      source: "team_builder",
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.runtime_agents[0].instance_id, "inst_coder_1");
  assert.equal(normalized.runtime_agents[0].template_id, "coder");
  assert.equal(normalized.runtime_agents[0].role_label, "coder");
  assert.equal(normalized.runtime_agents[0].provider, "codex");
  assert.equal(normalized.runtime_agents[0].status, "running");
});

test("action_source normalization maps legacy aliases to canonical enum", () => {
  assert.equal(normalizeActionSource("explicit"), "explicit_route_plan");
  assert.equal(normalizeActionSource("team_generated"), "generated_team_actions");
  assert.equal(normalizeActionSource("fallback"), "default_fallback_route");
  assert.equal(
    normalizeActionSource("unknown_value", { fallback: "default_fallback_route" }),
    "default_fallback_route"
  );
});

test("runtime metadata envelope normalizes camelCase keys to canonical shape", () => {
  const envelope = normalizeRuntimeMetadataEnvelope({
    runtimeTeamSnapshot: {
      teamPlan: { mode: "run" },
      runtimeAgents: [{ runtimeInstanceId: "inst_1", templateId: "planner", roleLabel: "planner" }],
      generatedAt: "2026-03-10T00:00:00.000Z",
      source: "team_builder",
    },
    actionSource: "generated",
  });

  assert.ok(envelope);
  assert.equal(envelope.action_source, "generated_team_actions");
  assert.ok(envelope.runtime_team_snapshot);
  assert.equal(envelope.runtime_team_snapshot.runtime_agents.length, 1);
});

test("runtime authority normalization emits canonical capability source fields", () => {
  const authority = normalizeRuntimeAuthority({
    mode: "LOCAL",
    planSource: "local_fallback",
    contextSource: "goc",
    agentCatalogSource: "goc",
    conversationTeamSource: "local",
    skillCatalogSource: "mixed",
    degradedMode: true,
    fallbackReason: "goc init failed",
  });

  assert.ok(authority);
  assert.equal(authority.mode, "standalone");
  assert.equal(authority.plan_source, "local_fallback");
  assert.equal(authority.context_source, "goc");
  assert.equal(authority.agent_catalog_source, "goc");
  assert.equal(authority.conversation_team_source, "local");
  assert.equal(authority.skill_catalog_source, "mixed");
  assert.equal(authority.degraded_mode, true);
  assert.equal(authority.fallback_reason, "goc init failed");
});

test("runtime metadata patch carries runtime authority fields additively", () => {
  const patch = buildRuntimeMetadataPatch({
    runtime_authority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
      degraded_mode: false,
      fallback_reason: null,
    },
  });

  assert.ok(patch.runtime_authority);
  assert.equal(patch.mode, "goc");
  assert.equal(patch.plan_source, "local");
  assert.equal(patch.context_source, "goc");
  assert.equal(patch.skill_catalog_source, "mixed");
  assert.equal(patch.degraded_mode, false);
});

test("runtime role payload builder emits canonical runtime_role and flattened fields", () => {
  const payload = buildRuntimeRolePayload({
    runtimeInstanceId: "inst_1",
    templateId: "coder",
    roleLabel: "Coder",
    provider: "CoDeX",
    model: "gpt-5-codex",
    capabilityTags: ["Code"],
    runtimeStatus: "READY",
    ephemeral: true,
    fallback: false,
  });

  assert.equal(payload.runtime_role.role_label, "coder");
  assert.equal(payload.runtime_role.runtime_instance_id, "inst_1");
  assert.equal(payload.runtime_role.template_id, "coder");
  assert.equal(payload.runtime_role.provider, "codex");
  assert.equal(payload.runtime_role.runtime_status, "ready");
  assert.equal(payload.role_label, "coder");
  assert.equal(payload.runtime_instance_id, "inst_1");
});
