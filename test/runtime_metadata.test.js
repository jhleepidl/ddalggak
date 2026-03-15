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
import {
  buildRuntimeAuthorityMetadataFixture,
  cloneRuntimeAuthorityFixture,
} from "../test_fixtures/runtime_authority_contract.js";

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
  const patch = buildRuntimeMetadataPatch(
    buildRuntimeAuthorityMetadataFixture("goc")
  );

  assert.ok(patch.runtime_authority);
  assert.equal(patch.mode, "goc");
  assert.equal(patch.plan_source, "local");
  assert.equal(patch.context_source, "goc");
  assert.equal(patch.skill_catalog_source, "mixed");
  assert.equal(patch.degraded_mode, false);
});

test("runtime metadata envelope normalizes legacy authority aliases into the canonical contract", () => {
  const envelope = normalizeRuntimeMetadataEnvelope({
    runtimeAuthority: {
      mode: "LOCAL",
      planSource: "local_fallback",
      contextSource: "local",
      agentCatalogSource: "local",
      conversationTeamSource: "local",
      skillCatalogSource: "local",
      degradedMode: true,
      fallbackReason: "goc unavailable",
    },
  });

  assert.deepEqual(
    envelope.runtime_authority,
    cloneRuntimeAuthorityFixture("local_fallback")
  );
  assert.equal(envelope.plan_source, "local_fallback");
  assert.equal(envelope.fallback_reason, "goc unavailable");
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

test("runtime snapshot normalization keeps supervisor, checkpoint, authority, and collaboration metadata", () => {
  const snapshot = createRuntimeTeamSnapshot({
    taskInterpretation: {
      task_type: "analysis",
      task_summary: "review market claims",
      deliverable_type: "brief",
    },
    teamPlan: {
      team_plan_id: "team_meta_1",
      slots: [
        { slot_id: "slot_research_1", role_id: "researcher", purpose: "collect evidence", authority_profile_id: "worker_readonly_research" },
        { slot_id: "slot_review_1", role_id: "reviewer", purpose: "challenge claims", authority_profile_id: "worker_readonly_review" },
      ],
      runtime_agents: [
        { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher", role_label: "researcher", authority_profile_id: "worker_readonly_research" },
        { instance_id: "inst_review_1", slot_id: "slot_review_1", role_id: "reviewer", role_label: "reviewer", authority_profile_id: "worker_readonly_review" },
      ],
      collaboration_cells: [
        {
          cell_id: "cell_reflect",
          pattern: "reflection",
          member_instance_ids: ["inst_research_1", "inst_review_1"],
          topology: "pair",
          max_rounds: 2,
          termination: { condition: "claims_validated" },
        },
      ],
      checkpoints: [
        {
          checkpoint_id: "checkpoint_review_gate",
          target_slot_ids: ["slot_review_1"],
          trigger_after_instances: ["inst_review_1"],
          human_interrupt_allowed: true,
        },
      ],
      execution_graph: {
        nodes: [{ slot_id: "slot_research_1" }, { slot_id: "slot_review_1" }],
        edges: [{ from_slot_id: "slot_research_1", to_slot_id: "slot_review_1" }],
        parallel_groups: [],
      },
      supervisor_runtime: {
        enabled: true,
        instance_id: "supervisor_runtime",
        interaction_mode: "checkpointed_supervised",
        authority_profile_id: "supervisor_controlled",
      },
      authority_graph: [
        { slot_id: "slot_research_1", authority_profile_id: "worker_readonly_research" },
        { slot_id: "slot_review_1", authority_profile_id: "worker_readonly_review" },
      ],
    },
    runtimeAgents: [
      { instance_id: "inst_research_1", slot_id: "slot_research_1", role_id: "researcher", role_label: "researcher", authority_profile_id: "worker_readonly_research" },
      { instance_id: "inst_review_1", slot_id: "slot_review_1", role_id: "reviewer", role_label: "reviewer", authority_profile_id: "worker_readonly_review" },
    ],
    collaborationCells: [
      {
        cell_id: "cell_reflect",
        pattern: "reflection",
        member_instance_ids: ["inst_research_1", "inst_review_1"],
        topology: "pair",
        max_rounds: 2,
        termination: { condition: "claims_validated" },
      },
    ],
    authorityGraph: [
      { slot_id: "slot_research_1", authority_profile_id: "worker_readonly_research" },
      { slot_id: "slot_review_1", authority_profile_id: "worker_readonly_review" },
    ],
    checkpoints: [
      {
        checkpoint_id: "checkpoint_review_gate",
        target_slot_ids: ["slot_review_1"],
        trigger_after_instances: ["inst_review_1"],
        human_interrupt_allowed: true,
      },
    ],
    executionGraph: {
      nodes: [{ slot_id: "slot_research_1" }, { slot_id: "slot_review_1" }],
      edges: [{ from_slot_id: "slot_research_1", to_slot_id: "slot_review_1" }],
      parallel_groups: [],
      supervisor_edges: [{ supervisor_instance_id: "supervisor_runtime", target_slot_ids: ["slot_research_1", "slot_review_1"] }],
      interrupt_ready: true,
    },
    selectionExplanations: [{ subject_id: "slot_review_1", reason: "claim-heavy task" }],
    runtimeAuthority: buildRuntimeAuthorityMetadataFixture("goc").runtime_authority,
    supervisorRuntime: {
      enabled: true,
      instance_id: "supervisor_runtime",
      interaction_mode: "checkpointed_supervised",
      authority_profile_id: "supervisor_controlled",
    },
    source: "control_plane",
  });

  assert.equal(snapshot.task_interpretation.task_type, "analysis");
  assert.equal(snapshot.collaboration_cells[0].pattern, "reflection");
  assert.equal(snapshot.checkpoints[0].checkpoint_id, "checkpoint_review_gate");
  assert.equal(snapshot.execution_graph.supervisor_edges.length, 1);
  assert.equal(snapshot.authority_graph.some((entry) => entry.role_id === "supervisor_runtime"), true);
  assert.equal(snapshot.runtime_authority.mode, "goc");

  const patch = buildRuntimeMetadataPatch({ runtime_team_snapshot: snapshot });
  assert.equal(Array.isArray(patch.collaboration_cells), true);
  assert.equal(Array.isArray(patch.checkpoints), true);
  assert.equal(Array.isArray(patch.authority_graph), true);
  assert.equal(patch.execution_graph.interrupt_ready, true);
  assert.equal(patch.supervisor_runtime.instance_id, "supervisor_runtime");
});
