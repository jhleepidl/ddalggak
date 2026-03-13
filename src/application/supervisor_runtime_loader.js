import {
  syncRuntimeConversationTeamState,
} from "./agent_team_commands.js";
import { summarizeMembershipTarget } from "./membership_target.js";
import {
  buildRunAuthorityEnvelope,
  normalizeRunAuthority,
} from "./run_authority.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

async function loadAgentRegistry({
  jobId = "",
  capabilities = {},
  refreshAgentRegistry = null,
  onRegistryLoaded = null,
} = {}) {
  const agentCatalog = capabilities?.agentCatalog;
  let registry = null;
  if (agentCatalog && typeof agentCatalog.load === "function") {
    registry = await agentCatalog.load({
      includeCompiled: true,
      refresh: true,
      fallbackToLocal: true,
    });
  } else if (typeof refreshAgentRegistry === "function") {
    registry = await refreshAgentRegistry({ includeCompiled: true });
  }
  if (typeof onRegistryLoaded === "function") {
    onRegistryLoaded(registry, { jobId: String(jobId || "").trim() });
  }
  return registry;
}

function buildLocalRuntimeResult({
  jobId = "",
  runtimeAuthority = null,
  capabilities = {},
  registry = null,
  normalizeSupervisorJobConfig = null,
  pickBaselineConversationCatalogAgents = null,
  summarizeJobConfigDebug = null,
  summarizeSelectionState = null,
  loadLocalContextDocs = null,
  includeContext = true,
} = {}) {
  const normalizeJobConfig = typeof normalizeSupervisorJobConfig === "function"
    ? normalizeSupervisorJobConfig
    : null;
  if (!normalizeJobConfig) {
    throw new Error("normalizeSupervisorJobConfig is required");
  }
  const summarizeSelection = typeof summarizeSelectionState === "function"
    ? summarizeSelectionState
    : (() => ({ catalog_ids: [], enabled_ids: [], disabled_ids: [] }));
  const summarizeJobConfigText = typeof summarizeJobConfigDebug === "function"
    ? summarizeJobConfigDebug
    : (() => "");
  const localDocs = typeof loadLocalContextDocs === "function"
    ? loadLocalContextDocs
    : (() => "");
  const fallbackNormalized = normalizeJobConfig(
    { job_id: String(jobId || "").trim() },
    { agentsCatalog: asArray(registry?.agents), toolsCatalog: [] }
  );
  const fallbackAgentIds = Array.isArray(fallbackNormalized.enabledAgentIds)
    ? fallbackNormalized.enabledAgentIds
    : [];
  const baselineAgentIds = fallbackAgentIds.length > 0
    ? fallbackAgentIds
    : (typeof pickBaselineConversationCatalogAgents === "function"
      ? pickBaselineConversationCatalogAgents(asArray(registry?.agents))
      : []);
  return {
    fallbackNormalized,
    baselineAgentIds,
    summarizeSelection,
    summarizeJobConfigText,
    localDocs,
    runtimeAuthority: normalizeRunAuthority(runtimeAuthority),
    capabilities,
    registry,
    includeContext,
  };
}

export function createSupervisorRuntimeLoader({
  composeCapabilitiesForRun = null,
  bindActor = null,
  requireGocClient = null,
  refreshAgentRegistry = null,
  onRegistryLoaded = null,
  normalizeSupervisorJobConfig = null,
  pickBaselineConversationCatalogAgents = null,
  summarizeJobConfigDebug = null,
  summarizeSelectionState = null,
  loadLocalContextDocs = null,
  ensureJobThread = null,
  ensureAgentsThread = null,
  ensureToolsThread = null,
  ensureGlobalThread = null,
  listLatestResourceByKind = null,
  parseStructuredFromResource = null,
  sortResourcesByCreatedAt = null,
  normalizeToolSpec = null,
  trackedDocNames = [],
  runDir = null,
  jobs = null,
} = {}) {
  if (typeof composeCapabilitiesForRun !== "function") {
    throw new Error("composeCapabilitiesForRun is required");
  }

  return async function loadSupervisorRuntime(
    jobId,
    {
      chatMeta = null,
      includeContext = true,
      includeGlobal = true,
      telegramUserId = "",
    } = {}
  ) {
    const cleanJobId = String(jobId || "").trim();
    const effectiveTelegramUserId = String(
      telegramUserId
      || chatMeta?.telegram_user_id
      || ""
    ).trim();
    const restoreActor = typeof bindActor === "function"
      ? bindActor(effectiveTelegramUserId)
      : (() => {});
    try {
      const capabilitiesPack = composeCapabilitiesForRun({ jobId: cleanJobId });
      const runtimeAuthority = normalizeRunAuthority(capabilitiesPack?.authority || null);
      const capabilities = asObject(capabilitiesPack?.capabilities);
      const teamStore = capabilities.conversationTeamStore;
      const registry = await loadAgentRegistry({
        jobId: cleanJobId,
        capabilities,
        refreshAgentRegistry,
        onRegistryLoaded,
      });

      const localDeps = buildLocalRuntimeResult({
        jobId: cleanJobId,
        runtimeAuthority,
        capabilities,
        registry,
        normalizeSupervisorJobConfig,
        pickBaselineConversationCatalogAgents,
        summarizeJobConfigDebug,
        summarizeSelectionState,
        loadLocalContextDocs,
        includeContext,
      });

      if (runtimeAuthority?.mode !== "goc") {
        const baselineDefaultAgentIds = asArray(localDeps.baselineAgentIds);
        const teamResult = (teamStore && typeof teamStore.ensureTeam === "function")
          ? await teamStore.ensureTeam({
            jobId: cleanJobId,
            baselineAgentIds: baselineDefaultAgentIds,
          })
          : {
            target: {
              thread_id: `local:${cleanJobId}`,
              conversation_id: `local:${cleanJobId}`,
              source: "local",
            },
            rows: baselineDefaultAgentIds.map((agentId) => ({ agent_id: agentId, enabled: true })),
            warnings: [],
          };
        const conversationAgents = asArray(teamResult?.rows);
        const localWarningLines = [...asArray(teamResult?.warnings)];
        const localThreadId = String(
          teamResult?.target?.thread_id || `local:${cleanJobId}`
        ).trim();
        const localConversationId = String(
          teamResult?.target?.conversation_id || localThreadId
        ).trim();

        const runtimeResult = {
          mode: "local",
          ...buildRunAuthorityEnvelope(
            { runtime_authority: runtimeAuthority },
            {},
            { includeRuntimeMode: true }
          ),
          map: {
            threadId: localThreadId,
            ctxSharedId: "",
          },
          agentsSlot: null,
          toolsSlot: null,
          conversation: {
            id: localConversationId,
            thread_id: localThreadId,
          },
          conversationMembershipTarget: summarizeMembershipTarget(teamResult?.target || {
            thread_id: localThreadId,
            conversation_id: localConversationId,
            source: "local",
          }),
          conversationAgents,
          baselineDefaultAgentIds,
          conversationMembershipWarning: "",
          unknownConversationAgentIds: [],
          jobConfig: localDeps.fallbackNormalized.configNormalized,
          jobConfigDebugSummary: localDeps.summarizeJobConfigText(localDeps.fallbackNormalized.configNormalized),
          jobConfigNodeId: "",
          agentsCatalog: asArray(registry?.agents),
          toolsCatalog: [],
          enabledAgentIds: [],
          enabledToolIds: localDeps.fallbackNormalized.enabledToolIds,
          agentSelection: localDeps.summarizeSelection({
            catalog: asArray(registry?.agents),
            enabled: [],
          }),
          toolSelection: localDeps.summarizeSelection({ catalog: [], enabled: [] }),
          agents: [],
          tools: [],
          recentArtifactNodeIds: [],
          sharedActiveTypeBreakdown: {},
          contextSummary: includeContext ? localDeps.localDocs(cleanJobId, trackedDocNames, 2200) : "",
          globalSummary: "",
          capabilities,
        };
        syncRuntimeConversationTeamState(runtimeResult, {
          conversationRows: conversationAgents,
          membershipTarget: teamResult?.target || {
            thread_id: localThreadId,
            conversation_id: localConversationId,
            source: "local",
          },
          warningLines: localWarningLines,
          summarizeSelectionState: localDeps.summarizeSelection,
        });
        return runtimeResult;
      }

      if (typeof requireGocClient !== "function") {
        throw new Error("requireGocClient is required for goc runtime loading");
      }
      const client = requireGocClient();
      const ensureJob = typeof ensureJobThread === "function"
        ? ensureJobThread
        : null;
      const ensureAgents = typeof ensureAgentsThread === "function"
        ? ensureAgentsThread
        : null;
      const ensureTools = typeof ensureToolsThread === "function"
        ? ensureToolsThread
        : null;
      if (!ensureJob || !ensureAgents || !ensureTools) {
        throw new Error("GoC runtime loading requires thread helpers");
      }

      const map = await ensureJob(client, {
        jobId: cleanJobId,
        jobDir: typeof runDir === "function" ? runDir(cleanJobId) : "",
        title: `job:${cleanJobId}`,
        telegram: chatMeta,
      });
      const agentsSlot = await ensureAgents(client, { baseDir: jobs?.baseDir || "" });
      const toolsSlot = await ensureTools(client, { baseDir: jobs?.baseDir || "" });

      const warningLines = [];
      const pushConversationWarning = (stage, error = null, extra = {}) => {
        const payload = {
          thread_id: String(map?.threadId || "").trim() || "(none)",
          context_set_id: String(map?.ctxSharedId || "").trim() || "(none)",
          user_id: effectiveTelegramUserId || "(none)",
          stage: String(stage || "unknown"),
          error: error ? String(error?.message ?? error) : "",
          ...asObject(extra),
        };
        const line = `conversation_membership_warning ${JSON.stringify(payload)}`;
        warningLines.push(line);
        if (cleanJobId && jobs && typeof jobs.log === "function") {
          jobs.log(cleanJobId, line);
        }
      };

      const teamResult = (teamStore && typeof teamStore.ensureTeam === "function")
        ? await teamStore.ensureTeam({
          threadId: map.threadId,
          jobId: cleanJobId,
          source: "load_supervisor_runtime",
          baselineAgentIds: typeof pickBaselineConversationCatalogAgents === "function"
            ? pickBaselineConversationCatalogAgents(asArray(registry?.agents))
            : [],
        })
        : {
          target: summarizeMembershipTarget({ thread_id: map.threadId, source: "goc" }),
          rows: [],
          warnings: ["conversation_team_store_unavailable"],
          baseline_agent_ids: typeof pickBaselineConversationCatalogAgents === "function"
            ? pickBaselineConversationCatalogAgents(asArray(registry?.agents))
            : [],
        };
      const baselineDefaultAgentIds = asArray(
        teamResult?.baseline_agent_ids
        || (typeof pickBaselineConversationCatalogAgents === "function"
          ? pickBaselineConversationCatalogAgents(asArray(registry?.agents))
          : [])
      );
      for (const warning of asArray(teamResult?.warnings)) {
        pushConversationWarning(warning);
      }
      const membershipTarget = teamResult?.target && typeof teamResult.target === "object"
        ? teamResult.target
        : summarizeMembershipTarget({ thread_id: map.threadId, source: "goc" });
      if (membershipTarget?.ensure_error) {
        pushConversationWarning("ensure_conversation", membershipTarget.ensure_error);
      }
      if (membershipTarget?.ensured_thread_mismatch === true) {
        pushConversationWarning("ensure_conversation_thread_mismatch", null, {
          requested_thread_id: String(
            membershipTarget?.requested_target?.thread_id || map.threadId || ""
          ).trim() || "(none)",
          ensured_thread_id: String(
            membershipTarget?.ensured_target?.thread_id || ""
          ).trim() || "(none)",
          conversation_id: String(
            membershipTarget?.ensured_target?.conversation_id || ""
          ).trim() || "(none)",
        });
      }
      const conversationAgents = asArray(teamResult?.rows);
      const conversation = {
        id: String(membershipTarget?.conversation_id || "").trim(),
        thread_id: String(membershipTarget?.thread_id || map.threadId || "").trim(),
      };

      const latestJobNode = typeof listLatestResourceByKind === "function"
        ? await listLatestResourceByKind(client, map.threadId, "job_config")
        : null;
      const rawJobConfig = latestJobNode && typeof parseStructuredFromResource === "function"
        ? parseStructuredFromResource(latestJobNode, "job_config")
        : null;

      const toolRows = await client.listResources(toolsSlot.threadId, { resourceKind: "tool_spec" });
      const orderedToolRows = typeof sortResourcesByCreatedAt === "function"
        ? sortResourcesByCreatedAt(toolRows)
        : asArray(toolRows);
      const latestToolSpecById = new Map();
      for (const resource of orderedToolRows) {
        const parsedTool = typeof parseStructuredFromResource === "function"
          ? parseStructuredFromResource(resource, "tool_spec")
          : resource;
        const normalizedTool = typeof normalizeToolSpec === "function"
          ? normalizeToolSpec(parsedTool)
          : parsedTool;
        if (!normalizedTool) continue;
        latestToolSpecById.set(cleanId(normalizedTool.id), normalizedTool);
      }
      const toolsCatalog = [...latestToolSpecById.values()];

      const normalized = normalizeSupervisorJobConfig(
        rawJobConfig || { job_id: cleanJobId },
        { agentsCatalog: asArray(registry?.agents), toolsCatalog }
      );

      const enabledToolIds = asArray(normalized.enabledToolIds)
        .map((id) => cleanId(id))
        .filter(Boolean);
      const enabledToolSet = new Set(enabledToolIds);
      const enabledTools = toolsCatalog
        .filter((tool) => enabledToolSet.has(cleanId(tool?.id || tool?.tool_id || tool?.toolId)));

      let recentArtifactNodeIds = [];
      try {
        const artifacts = await client.listResources(map.threadId, {
          resourceKind: "artifact",
        });
        const sorter = typeof sortResourcesByCreatedAt === "function"
          ? sortResourcesByCreatedAt
          : (rows) => asArray(rows);
        recentArtifactNodeIds = sorter(artifacts)
          .slice(-5)
          .reverse()
          .map((row) => String(row?.id || "").trim())
          .filter(Boolean);
      } catch {
        recentArtifactNodeIds = [];
      }

      let contextSummary = "";
      if (includeContext) {
        try {
          contextSummary = await client.getCompiledContext(map.ctxSharedId);
        } catch {
          contextSummary = typeof loadLocalContextDocs === "function"
            ? loadLocalContextDocs(cleanJobId, trackedDocNames, 2200)
            : "";
        }
      }

      let globalSummary = "";
      if (includeGlobal) {
        try {
          if (typeof ensureGlobalThread !== "function") throw new Error("ensureGlobalThread is unavailable");
          const globalSlot = await ensureGlobalThread(client, {
            baseDir: jobs?.baseDir || "",
            title: "global:shared",
          });
          globalSummary = await client.getCompiledContext(globalSlot.ctxId);
        } catch {
          globalSummary = "";
        }
      }

      const summarizeSelection = typeof summarizeSelectionState === "function"
        ? summarizeSelectionState
        : (() => ({ catalog_ids: [], enabled_ids: [], disabled_ids: [] }));
      const summarizeJobConfigText = typeof summarizeJobConfigDebug === "function"
        ? summarizeJobConfigDebug
        : (() => "");

      const runtimeResult = {
        mode: "goc",
        ...buildRunAuthorityEnvelope(
          { runtime_authority: runtimeAuthority },
          {},
          { includeRuntimeMode: true }
        ),
        map,
        agentsSlot,
        toolsSlot,
        jobConfig: normalized.configNormalized,
        jobConfigDebugSummary: summarizeJobConfigText(rawJobConfig || normalized.configNormalized),
        jobConfigNodeId: String(latestJobNode?.id || "").trim(),
        agentsCatalog: asArray(registry?.agents),
        toolsCatalog,
        conversation,
        conversationMembershipTarget: summarizeMembershipTarget(membershipTarget),
        conversationAgents,
        baselineDefaultAgentIds,
        conversationMembershipWarning: "",
        unknownConversationAgentIds: [],
        enabledAgentIds: [],
        enabledToolIds,
        agentSelection: summarizeSelection({
          catalog: asArray(registry?.agents),
          enabled: [],
        }),
        toolSelection: summarizeSelection({
          catalog: toolsCatalog,
          enabled: enabledTools,
        }),
        agents: [],
        tools: enabledTools,
        recentArtifactNodeIds,
        sharedActiveTypeBreakdown: {},
        contextSummary: contextSummary || "",
        globalSummary: globalSummary || "",
        capabilities,
      };
      syncRuntimeConversationTeamState(runtimeResult, {
        conversationRows: conversationAgents,
        membershipTarget,
        warningLines,
        summarizeSelectionState: summarizeSelection,
      });
      return runtimeResult;
    } finally {
      restoreActor();
    }
  };
}
