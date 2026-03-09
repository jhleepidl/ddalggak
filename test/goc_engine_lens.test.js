import test from "node:test";
import assert from "node:assert/strict";
import { GocContextEngine } from "../src/context_engine/goc_engine.js";

function createFakeClient() {
  return {
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
