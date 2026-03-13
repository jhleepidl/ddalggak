import test from "node:test";
import assert from "node:assert/strict";
import { GocContextEngine } from "../src/context_engine/goc_engine.js";
import {
  buildRuntimeAuthorityMetadataFixture,
  cloneRuntimeAuthorityFixture,
} from "../test_fixtures/runtime_authority_contract.js";

function createFakeClient() {
  const state = {
    resources: [],
    edges: [],
  };
  return {
    state,
    async getCompiledContextWithMeta() {
      return {
        text: "compiled-context",
        token_estimate: 120,
        active_node_ids: ["n1"],
        context_version: "v1",
        node_type_breakdown: { "message:user": 1 },
      };
    },
    async getContextSet() {
      return {
        version: "v1",
        activeNodeIds: ["n1"],
      };
    },
    async listNodes() {
      return [{ id: "n1", type: "message", role: "user" }];
    },
    async cloneContextSet() {
      return { id: "ctx_lens" };
    },
    async unfoldPlan() {
      return {};
    },
    async applyUnfoldPlan() {
      return { added_node_ids: ["n2"] };
    },
    async activateNodes() {
      return { ok: true };
    },
    async deactivateNodes() {
      return { ok: true };
    },
    async createResource(threadId, payload = {}) {
      state.resources.push({ threadId, payload });
      return { id: `res_${state.resources.length}` };
    },
    async createEdge(threadId, fromId, toId, edgeType) {
      state.edges.push({ threadId, fromId, toId, edgeType });
      return { ok: true };
    },
  };
}

test("goc_engine lens handling follows shared domain normalization", async () => {
  const engine = new GocContextEngine({
    client: createFakeClient(),
    runtime: {
      map: { threadId: "thread_1", ctxSharedId: "ctx_shared_1" },
      recentArtifactNodeIds: ["a1", "a2"],
      jobConfig: {},
    },
  });

  const prepared = await engine.prepareStepContext({
    jobId: "job_1",
    chatId: "chat_1",
    threadId: "thread_1",
    agentId: "planner",
    goal: "route it",
    budgetTokens: 2000,
    lensSpec: {
      mode: "invalid_mode",
      query: "focus",
      budget_tokens: 99999,
    },
  });

  assert.equal(prepared.meta.lensSpec.mode, "unfold_query");
  assert.equal(prepared.meta.lensSpec.budget_tokens, 12000);

  const defaultPrepared = await engine.prepareStepContext({
    jobId: "job_1",
    chatId: "chat_1",
    threadId: "thread_1",
    agentId: "planner",
    goal: "plan",
  });

  assert.equal(defaultPrepared.meta.lensSpec.mode, "shared_only");
  assert.equal(defaultPrepared.meta.lensSpec.budget_tokens, 900);
});

test("goc_engine recordMeta persists additive metadata to GOC when run/step info exists", async () => {
  const fakeClient = createFakeClient();
  const engine = new GocContextEngine({
    client: fakeClient,
    runtime: {
      map: { threadId: "thread_2", ctxSharedId: "ctx_shared_2" },
      jobConfig: {},
    },
  });

  await engine.recordMeta({
    jobId: "job_meta",
    chatId: "chat_meta",
    agentId: "coder",
    stepKind: "agent",
    goal: "implement",
    runMeta: {
      runId: "run_meta_1",
      threadId: "thread_2",
      sharedContextSetId: "ctx_shared_2",
      stepNodeId: "step_node_1",
      ...buildRuntimeAuthorityMetadataFixture("goc"),
      runtime_team_snapshot: {
        team_plan: { mode: "run", roles: [] },
        runtime_agents: [{
          instance_id: "inst_1",
          template_id: "researcher",
          role_label: "researcher",
          attached_skills: [{
            skill_id: "skill.claim_evidence_audit.v1",
            selected_by: "skill_resolver",
            load_level: "instructions",
            status: "selected",
          }],
          context_pack_id: "ctxp_1",
        }],
        context_packs: [{
          id: "ctxp_1",
          run_id: "run_meta_1",
          scope: "role",
          target_runtime_agent_instance_id: "inst_1",
          shared_items: [],
          role_specific_items: [],
          skill_items: [{
            skill_id: "skill.claim_evidence_audit.v1",
            load_level: "instructions",
          }],
          excluded_items: [],
          missing_items: [],
          conflicts: [],
          token_budget: { soft_limit: 1000, hard_limit: 2000 },
        }],
        selected_skill_ids: ["skill.claim_evidence_audit.v1"],
        skill_load_levels: {
          inst_1: {
            "skill.claim_evidence_audit.v1": "instructions",
          },
        },
        selection_reason_summary: {
          researcher: "skill.claim_evidence_audit.v1:evidence audit",
        },
        generated_at: "2026-03-10T00:00:00.000Z",
        source: "team_builder",
      },
      action_source: "generated",
    },
    meta: {
      lensSpec: { mode: "shared_only", budget_tokens: 900 },
      estimatedTokens: 120,
    },
  });

  assert.equal(fakeClient.state.resources.length, 1);
  assert.equal(fakeClient.state.resources[0].threadId, "thread_2");
  assert.equal(fakeClient.state.resources[0].payload.resource_kind, "context_meta");
  assert.ok(fakeClient.state.resources[0].payload.payload_json.runtime_team_snapshot);
  assert.deepEqual(
    fakeClient.state.resources[0].payload.payload_json.runtime_authority,
    cloneRuntimeAuthorityFixture("goc")
  );
  assert.equal(fakeClient.state.resources[0].payload.payload_json.plan_source, "local");
  assert.equal(fakeClient.state.resources[0].payload.payload_json.context_source, "goc");
  assert.equal(fakeClient.state.resources[0].payload.payload_json.action_source, "generated_team_actions");
  assert.ok(fakeClient.state.resources[0].payload.payload_json.selected_skill_ids.includes("skill.claim_evidence_audit.v1"));
  assert.equal(
    fakeClient.state.resources[0].payload.payload_json.skill_load_levels.inst_1["skill.claim_evidence_audit.v1"],
    "instructions"
  );
  assert.equal(fakeClient.state.resources[0].payload.payload_json.context_packs[0].id, "ctxp_1");
  assert.equal(fakeClient.state.edges.length, 1);
  assert.equal(fakeClient.state.edges[0].edgeType, "HAS_PART");

  await engine.recordMeta({
    jobId: "job_meta",
    chatId: "chat_meta",
    agentId: "coder",
    stepKind: "agent",
    goal: "implement",
    runMeta: {
      runId: "run_meta_1",
      threadId: "thread_2",
      sharedContextSetId: "ctx_shared_2",
      stepNodeId: "step_node_2",
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
      runtimeTeamSnapshot: {
        teamPlan: { mode: "run", roles: [] },
        runtimeAgents: [],
        generatedAt: "2026-03-10T00:00:00.000Z",
        source: "team_builder",
      },
      actionSource: "fallback",
    },
    meta: {
      lensSpec: { mode: "shared_only", budget_tokens: 900 },
      estimatedTokens: 120,
    },
  });

  assert.equal(fakeClient.state.resources.length, 2);
  assert.equal(fakeClient.state.resources[1].payload.payload_json.action_source, "default_fallback_route");
  assert.deepEqual(
    fakeClient.state.resources[1].payload.payload_json.runtime_authority,
    cloneRuntimeAuthorityFixture("local_fallback")
  );
  assert.equal(fakeClient.state.resources[1].payload.payload_json.plan_source, "local_fallback");
  assert.equal(fakeClient.state.resources[1].payload.payload_json.degraded_mode, true);
  assert.equal(fakeClient.state.resources[1].payload.payload_json.fallback_reason, "goc unavailable");
});
