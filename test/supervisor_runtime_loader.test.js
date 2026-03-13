import test from "node:test";
import assert from "node:assert/strict";

import { createSupervisorRuntimeLoader } from "../src/application/supervisor_runtime_loader.js";

function createNormalizeSupervisorJobConfig() {
  return (raw = {}, { agentsCatalog = [], toolsCatalog = [] } = {}) => ({
    configNormalized: {
      job_id: String(raw.job_id || "").trim(),
      participants: agentsCatalog.map((row) => row.id),
      tool_set: { mode: "all_enabled", selected: [], disabled: [] },
      agent_set: { mode: "all_enabled", selected: [], disabled: [] },
    },
    enabledAgentIds: agentsCatalog.map((row) => row.id),
    enabledToolIds: toolsCatalog.map((row) => row.id),
  });
}

test("supervisor runtime loader builds standalone runtime from local capabilities", async () => {
  let registrySeen = null;
  const loadSupervisorRuntime = createSupervisorRuntimeLoader({
    composeCapabilitiesForRun: () => ({
      authority: {
        mode: "standalone",
        plan_source: "local",
        context_source: "local",
        agent_catalog_source: "local",
        conversation_team_source: "local",
        skill_catalog_source: "local",
      },
      capabilities: {
        agentCatalog: {
          async load() {
            return {
              agents: [
                { id: "planner" },
                { id: "coder" },
              ],
            };
          },
        },
        conversationTeamStore: {
          async ensureTeam() {
            return {
              target: {
                thread_id: "local:job_loader_1",
                conversation_id: "local:job_loader_1",
                source: "local",
              },
              rows: [
                { agent_id: "planner", enabled: true },
                { agent_id: "coder", enabled: false },
                { agent_id: "ghost", enabled: true },
              ],
              warnings: ["local_warning"],
            };
          },
        },
      },
    }),
    bindActor: () => () => {},
    onRegistryLoaded: (registry) => {
      registrySeen = registry;
    },
    normalizeSupervisorJobConfig: createNormalizeSupervisorJobConfig(),
    pickBaselineConversationCatalogAgents: (rows) => rows.map((row) => row.id),
    summarizeJobConfigDebug: (config) => `job=${config.job_id}`,
    summarizeSelectionState: ({ catalog = [], enabled = [] } = {}) => ({
      catalog_ids: catalog.map((row) => row.id),
      enabled_ids: enabled.map((row) => row.id),
      disabled_ids: catalog
        .map((row) => row.id)
        .filter((id) => !enabled.map((row) => row.id).includes(id)),
    }),
    loadLocalContextDocs: (jobId, docNames) => `${jobId}:${docNames.join(",")}`,
    trackedDocNames: ["plan.md", "research.md"],
  });

  const runtime = await loadSupervisorRuntime("job_loader_1", {
    includeContext: true,
    includeGlobal: false,
  });

  assert.ok(registrySeen);
  assert.equal(runtime.mode, "local");
  assert.equal(runtime.runtimeAuthority.mode, "standalone");
  assert.equal(runtime.conversationMembershipTarget.thread_id, "local:job_loader_1");
  assert.deepEqual(runtime.enabledAgentIds, ["planner"]);
  assert.deepEqual(runtime.unknownConversationAgentIds, ["ghost"]);
  assert.match(runtime.conversationMembershipWarning, /local_warning/);
  assert.match(runtime.conversationMembershipWarning, /unknown_catalog_agents:ghost/);
  assert.equal(runtime.contextSummary, "job_loader_1:plan.md,research.md");
});

test("supervisor runtime loader builds goc runtime with catalog, team, tools, and context", async () => {
  const warnings = [];
  const client = {
    async listResources(threadId, options = {}) {
      if (threadId === "tools-thread" && options.resourceKind === "tool_spec") {
        return [
          {
            id: "tool_res_1",
            createdAt: "2026-03-13T00:00:00.000Z",
            payload: {
              tool_spec: { id: "search", name: "Search" },
            },
          },
        ];
      }
      if (threadId === "goc-thread" && options.resourceKind === "artifact") {
        return [
          { id: "artifact_1", createdAt: "2026-03-13T00:00:00.000Z" },
        ];
      }
      return [];
    },
    async getCompiledContext(ctxId) {
      if (ctxId === "shared-ctx") return "compiled shared context";
      if (ctxId === "global-ctx") return "compiled global context";
      return "";
    },
  };
  const loadSupervisorRuntime = createSupervisorRuntimeLoader({
    composeCapabilitiesForRun: () => ({
      authority: {
        mode: "goc",
        plan_source: "local",
        context_source: "goc",
        agent_catalog_source: "goc",
        conversation_team_source: "goc",
        skill_catalog_source: "mixed",
      },
      capabilities: {
        agentCatalog: {
          async load() {
            return {
              agents: [
                { id: "planner" },
                { id: "coder" },
              ],
            };
          },
        },
        conversationTeamStore: {
          async ensureTeam() {
            return {
              target: {
                thread_id: "goc-thread",
                conversation_id: "goc-conversation",
                source: "goc",
              },
              rows: [
                { agent_id: "planner", enabled: true },
                { agent_id: "ghost", enabled: true },
              ],
              warnings: ["store_warning"],
            };
          },
        },
      },
    }),
    bindActor: () => () => {},
    requireGocClient: () => client,
    normalizeSupervisorJobConfig: createNormalizeSupervisorJobConfig(),
    pickBaselineConversationCatalogAgents: (rows) => rows.map((row) => row.id),
    summarizeJobConfigDebug: (config) => `job=${config.job_id}`,
    summarizeSelectionState: ({ catalog = [], enabled = [] } = {}) => ({
      catalog_ids: catalog.map((row) => row.id),
      enabled_ids: enabled.map((row) => row.id),
      disabled_ids: catalog
        .map((row) => row.id)
        .filter((id) => !enabled.map((row) => row.id).includes(id)),
    }),
    loadLocalContextDocs: () => "local fallback context",
    ensureJobThread: async () => ({
      threadId: "goc-thread",
      ctxSharedId: "shared-ctx",
    }),
    ensureAgentsThread: async () => ({ threadId: "agents-thread" }),
    ensureToolsThread: async () => ({ threadId: "tools-thread" }),
    ensureGlobalThread: async () => ({ ctxId: "global-ctx" }),
    listLatestResourceByKind: async () => ({
      id: "job_config_node_1",
      payload: {
        job_config: { job_id: "job_loader_2" },
      },
    }),
    parseStructuredFromResource: (resource, key) => resource?.payload?.[key] || null,
    sortResourcesByCreatedAt: (rows = []) => [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    normalizeToolSpec: (row) => row,
    trackedDocNames: ["plan.md", "research.md"],
    jobs: {
      baseDir: "/tmp/ddalggak-loader",
      log(jobId, line) {
        warnings.push(`${jobId}:${line}`);
      },
    },
  });

  const runtime = await loadSupervisorRuntime("job_loader_2", {
    chatMeta: {
      chat_id: "chat_1",
      telegram_user_id: "user_1",
    },
    includeContext: true,
    includeGlobal: true,
    telegramUserId: "user_1",
  });

  assert.equal(runtime.mode, "goc");
  assert.equal(runtime.runtimeAuthority.mode, "goc");
  assert.equal(runtime.conversation.id, "goc-conversation");
  assert.deepEqual(runtime.enabledAgentIds, ["planner"]);
  assert.deepEqual(runtime.unknownConversationAgentIds, ["ghost"]);
  assert.deepEqual(runtime.enabledToolIds, ["search"]);
  assert.equal(runtime.contextSummary, "compiled shared context");
  assert.equal(runtime.globalSummary, "compiled global context");
  assert.equal(runtime.jobConfigNodeId, "job_config_node_1");
  assert.match(runtime.conversationMembershipWarning, /store_warning/);
  assert.match(runtime.conversationMembershipWarning, /unknown_catalog_agents/);
  assert.ok(warnings.some((line) => line.includes("conversation_membership_warning")));
});
