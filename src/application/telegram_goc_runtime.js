import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Jobs } from "../jobs.js";
import { Tracking } from "../tracking.js";
import { Approvals } from "../approvals.js";
import { runCommand } from "../proc.js";
import { runCodexExec } from "../codex.js";
import { runGeminiPrompt } from "../gemini.js";
import { OrchestratorMemory } from "../settings.js";
import { orchestratorNotes, buildChatGPTNextStepPrompt } from "../prompts.js";
import { clip, extractCodexInstruction, extractJsonPlan } from "../textutil.js";
import { deriveKnowledgeBaseDesign, deriveKnowledgeBaseProfile, deriveInitialKnowledgeBaseDesign } from "../knowledge_base/profile.js";
import { loadAgents, getAgent } from "../agents.js";
import {
  parseAutoSuggestDecision as parseAutoSuggestDecisionShared,
  parseJsonObjectFromText as parseJsonObjectFromTextShared,
} from "../shared/json_extract.js";
import {
  parseRouterPlan as parseRouterPlanDomain,
  sanitizeSupervisorRoutePlan as sanitizeSupervisorRoutePlanDomain,
  normalizeForceMode as normalizeForceModeDomain,
} from "../domain/route_plan.js";
import {
  normalizeScopeHintCore as normalizeLensSpecDomain,
  defaultScopeHintForAgent as defaultLensSpecForAgentDomain,
  resolveEffectiveScopeHint as resolveEffectiveLensSpecDomain,
  dedupeScopeNodeIds as dedupeLensNodeIds,
} from "../domain/scope_hint_core.js";
import { createDefaultRunRoute } from "./orchestrator.js";
import {
  inferTrackingAppendPurpose,
  deriveTrackingMemorySurfaceSpec as deriveTrackingMemorySurfaceSpecShared,
  buildGocMemoryNodePayload,
  ensureKnowledgeBaseMemorySurfacesInGoc as ensureKnowledgeBaseMemorySurfacesInGocShared,
} from "./goc_memory_sync.js";
import {
  enqueueGocLateSync,
  flushGocLateSyncQueue,
  gocLateSyncMode,
  isGocLateSyncEnabled,
  scheduleGocLateSyncFlush,
} from "./goc_late_sync.js";
import { syncMemoryTopologyToGoc } from './goc_memory_topology_sync.js';
import { syncMemoryDemandToGoc } from './goc_memory_demand_sync.js';
import { sendLong as sendLongAdapter } from "../adapters/telegram/send.js";
import {
  buildPendingApprovalPrompt as buildPendingApprovalPromptAdapter,
  formatChatSummary as formatChatSummaryAdapter,
} from "../adapters/telegram/formatting.js";
import {
  buildContextLinks,
  buildContextLinkButtons,
  isTelegramWebAppHttpsError,
} from "../adapters/telegram/context_links.js";
import {
  getActionGoal as getActionGoalShared,
  formatActionAgentLabel as formatActionAgentLabelShared,
  formatChatActionLabel as chatActionLabelShared,
  buildPlanPreviewLines as buildPlanPreviewLinesShared,
  buildQueuedAgentStatusFromActions as buildQueuedAgentStatusFromActionsShared,
  buildRoutedDashboardText as buildRoutedDashboardTextShared,
  inferApprovalPreviewReason as inferApprovalPreviewReasonShared,
  buildApprovalActionSummaryLines as buildApprovalActionSummaryLinesShared,
  buildAutopilotProgressSummary as buildAutopilotProgressSummaryShared,
  buildAutopilotFollowupMessage as buildAutopilotFollowupMessageShared,
  updateCompletedDeliverablesFromOutputs as updateCompletedDeliverablesFromOutputsShared,
  summarizeSpecialChatOutputs as summarizeSpecialChatOutputsShared,
  buildChatSynthesisFallback as buildChatSynthesisFallbackShared,
} from "../adapters/telegram/preview_formatting.js";
import {
  buildGeminiRetryNoticeText as buildGeminiRetryNoticeTextShared,
  buildGeminiModelSwitchNoticeText as buildGeminiModelSwitchNoticeTextShared,
  buildGeminiGiveUpNoticeText as buildGeminiGiveUpNoticeTextShared,
} from "../adapters/telegram/status_messages.js";
import { formatByteSize } from "../adapters/telegram/uploads.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./job_runtime.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { createRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { markActionsSkipped, wasInterruptedByReplan } from "./run_status_cleanup.js";
import {
  applyRunAuthority,
  buildRunAuthority,
  buildRunAuthorityPatch,
  normalizeRunAuthority,
  summarizeRunAuthorityLines,
} from "./run_authority.js";
import {
  createRuntimeComposer,
  invokeRuntimePlanner,
} from "./runtime_composer.js";
import { createSupervisorRuntimeLoader } from "./supervisor_runtime_loader.js";
import {
  isExplicitTeamConfigurationIntentMessage,
} from "./team_intent.js";
import { buildExplicitTeamReconfigurationActions } from "./team_config_diff.js";
import { normalizeAgentLookupKey } from "./logical_agents.js";
import {
  verifyConversationMembershipMutation,
  createMembershipConfirmationError,
} from "./membership_confirmation.js";
import {
  resolveConversationMembershipTarget,
  summarizeMembershipTarget,
} from "./membership_target.js";
import {
  applyConversationAgentMutation,
  runConversationAgentTeamCommand,
  summarizeMembershipMutationResponse,
  syncRuntimeConversationTeamState,
} from "./agent_team_commands.js";
import {
  createAgentProfile,
  updateAgentProfile,
  listPublicBlueprints,
  installBlueprint,
} from "../agent_registry.js";
import { GocClient } from "../goc_client.js";
import {
  ensureJobThread,
  ensureAgentsThread,
  ensureToolsThread,
  ensureGlobalThread,
  normalizeJobConfig as normalizeSupervisorJobConfig,
  appendTrackingChunkToGoc,
} from "../goc_mapping.js";
import { ChatSessionStore } from "../chat/session.js";
import { routeWithSupervisor } from "../chat/supervisor_router.js";
import { executeSupervisorActions, isMutatingAction } from "../chat/executor.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  formatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { normalizeActionPlan } from "../chat/actions.js";
import { expandDetailContext } from "../chat/unfold.js";
import { ChatRunManager } from "../chat/run_manager.js";
import { GocExecutionGraphRecorder } from "../chat/goc_execution_graph.js";

import * as runtimeState from "./telegram_runtime_state.js";

const {
  jobs,
  tracking,
  memory,
  TRACK_DOC_NAMES,
  setAgentRegistry,
  setGocInitStatus,
  runDir,
  runSharedDir,
  loadLocalContextDocs,
  LEGACY_AGENT_MAP,
  MEMORY_MODE,
} = runtimeState;

let agentRegistry = runtimeState.agentRegistry;
let gocClient = runtimeState.gocClient;
let gocReady = runtimeState.gocReady;
let gocInitError = runtimeState.gocInitError;

function envFlag(name, fallback = false) {
  const key = String(process.env[name] ?? '').trim().toLowerCase();
  if (!key) return fallback;
  if (["1", "true", "yes", "on"].includes(key)) return true;
  if (["0", "false", "no", "off"].includes(key)) return false;
  return fallback;
}

function shouldSyncBootstrapMemoryToGoc() {
  return envFlag('GOC_SYNC_BOOTSTRAP_MEMORY', false);
}

function shouldUseLateGocSync() {
  return memoryModeWithFallback() === "goc" && gocLateSyncMode() === 'late' && isGocLateSyncEnabled();
}

function refreshAgentRegistryLocal() {
  agentRegistry = setAgentRegistry(loadAgents());
  return agentRegistry;
}

async function refreshAgentRegistry({ preferGoc = true, includeCompiled = true } = {}) {
  if (!preferGoc) return refreshAgentRegistryLocal();
  const composition = composeCapabilitiesForRun();
  const catalog = composition?.capabilities?.agentCatalog;
  if (catalog && typeof catalog.load === "function") {
    try {
      agentRegistry = await catalog.load({
        includeCompiled,
        refresh: true,
        fallbackToLocal: true,
      });
      return agentRegistry;
    } catch (e) {
      const reason = String(e?.message ?? e);
      const nextError = gocInitError || reason;
      const nextState = setGocInitStatus({
        client: gocClient,
        ready: gocReady,
        error: nextError,
      });
      gocClient = nextState.gocClient;
      gocReady = nextState.gocReady;
      gocInitError = nextState.gocInitError;
    }
  }
  return refreshAgentRegistryLocal();
}

function resolveAgentId(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "";
  return LEGACY_AGENT_MAP[key] || key;
}

function findAgentConfig(agentId) {
  const id = resolveAgentId(agentId);
  return getAgent(id, agentRegistry) || null;
}

function findAgentConfigInRuntime(agentId, runtime = null) {
  const key = String(agentId || "").trim().toLowerCase();
  const resolved = resolveAgentId(key);
  const targets = new Set([key, resolved].filter(Boolean));
  if (!targets.size) return null;
  const rows = [
    // Runtime/team assignments must win over static catalog defaults.
    ...(Array.isArray(runtime?.activeTeamConfig?.agents) ? runtime.activeTeamConfig.agents : []),
    ...(Array.isArray(runtime?.agents) ? runtime.agents : []),
    ...(Array.isArray(runtime?.runtimeTeamSnapshot?.runtime_agents) ? runtime.runtimeTeamSnapshot.runtime_agents : []),
    ...(Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : []),
  ];
  for (const row of rows) {
    const rowId = String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase();
    const rowSystemKey = String(row?.system_key || row?.systemKey || "").trim().toLowerCase();
    if (rowId && targets.has(rowId)) return row;
    if (rowSystemKey && targets.has(rowSystemKey)) return row;
  }
  return null;
}

function memoryModeWithFallback() {
  if (MEMORY_MODE !== "goc") return "local";
  return gocReady && gocClient ? "goc" : "local";
}

function requireGocClient() {
  if (!gocReady || !gocClient) {
    const reason = gocInitError || "GoC is not ready";
    throw new Error(reason);
  }
  return gocClient;
}

const composeCapabilitiesForRun = createRuntimeComposer({
  requestedMode: () => MEMORY_MODE,
  getGocState: () => ({
    gocClient: gocReady && gocClient ? gocClient : null,
    gocReady,
    gocInitError,
  }),
  jobs,
  baseDir: jobs.baseDir,
  loggerFactory: (jobId = "") => (jobId ? (line) => jobs.log(jobId, line) : null),
  resolveMembershipTarget: resolveMembershipTargetForThread,
  resolveAgentId,
});

function setGocActingTelegramUser(telegramUserId) {
  if (memoryModeWithFallback() !== "goc") return;
  try {
    const client = requireGocClient();
    if (typeof client.setActorTelegramUserId === "function") {
      client.setActorTelegramUserId(telegramUserId);
    }
  } catch {}
}

function bindGocActor(telegramUserId = "") {
  if (memoryModeWithFallback() !== "goc") return () => {};
  try {
    const client = requireGocClient();
    const prev = String(client.actorTelegramUserId || "").trim();
    const next = String(telegramUserId || "").trim();
    if (next && typeof client.setActorTelegramUserId === "function") {
      client.setActorTelegramUserId(next);
    }
    return () => {
      try {
        if (typeof client.setActorTelegramUserId === "function") {
          client.setActorTelegramUserId(prev);
        }
      } catch {}
    };
  } catch {
    return () => {};
  }
}

const loadSupervisorRuntime = createSupervisorRuntimeLoader({
  composeCapabilitiesForRun,
  bindActor: bindGocActor,
  requireGocClient,
  refreshAgentRegistry,
  onRegistryLoaded: (registry = null) => {
    if (registry) agentRegistry = setAgentRegistry(registry);
  },
  normalizeSupervisorJobConfig,
  pickBaselineConversationCatalogAgents,
  summarizeJobConfigDebug,
  summarizeSelectionState,
  loadLocalContextDocs,
  ensureJobThread,
  ensureAgentsThread,
  ensureToolsThread,
  ensureGlobalThread,
  listLatestResourceByKind,
  parseStructuredFromResource,
  sortResourcesByCreatedAt,
  normalizeToolSpec,
  trackedDocNames: TRACK_DOC_NAMES,
  runDir,
  jobs,
});


function deriveTrackingMemorySurfaceSpec(jobId, docName = '') {
  return deriveTrackingMemorySurfaceSpecShared({ tracking, jobId, docName });
}

function deriveTrackingMemoryNodePayload({ jobId = '', docName = '', markdown = '', provider = '', roleId = '', purpose = '', source = 'system', eventType = '', actorKind = '', pipelineStage = '', semanticKind = '' } = {}) {
  const surfaceSpec = deriveTrackingMemorySurfaceSpec(jobId, docName);
  const surfaceId = String(surfaceSpec?.surface_id || String(docName || '').trim().toLowerCase().replace(/\.md$/i, '')).trim().toLowerCase();
  if (!surfaceId) return null;
  const cleanPurpose = inferTrackingAppendPurpose(docName, purpose);
  return buildGocMemoryNodePayload({
    clip,
    jobId,
    markdown,
    provider: String(provider || 'chatgpt').trim().toLowerCase(),
    roleId: String(roleId || 'operator').trim().toLowerCase(),
    purpose: cleanPurpose,
    source: String(source || 'system').trim().toLowerCase() || 'system',
    eventType,
    actorKind,
    pipelineStage,
    semanticKind: String(semanticKind || surfaceSpec?.semantic_kind || '').trim().toLowerCase(),
    requestedDoc: String(docName || '').trim(),
    resolvedDoc: String(docName || '').trim(),
    requestedSurfaceId: surfaceId,
    targetSurfaceId: surfaceId,
    memoryWriteStatus: 'system_appended',
    defaultConfidence: 0.8,
    nodeTypeHint: ['decisions', 'final_answer'].includes(surfaceId) ? 'decision' : (cleanPurpose === 'artifact' ? 'artifact' : ''),
  });
}

async function ensureKnowledgeBaseMemorySurfacesInGoc(jobId, { client = null, threadId = '' } = {}) {
  return ensureKnowledgeBaseMemorySurfacesInGocShared({
    jobId,
    client,
    threadId,
    docs: tracking.listDocs(jobId),
    deriveSpec: (doc) => deriveTrackingMemorySurfaceSpec(jobId, doc?.file_name || ''),
  });
}

async function syncTrackingAppendToGocMemory({ jobId = '', docName = '', markdown = '', provider = '', roleId = '', purpose = '', source = 'system', eventType = '', actorKind = '', pipelineStage = '', semanticKind = '', memoryContractEnforced = false } = {}) {
  if (memoryModeWithFallback() !== 'goc') return null;
  if (memoryContractEnforced === true) return null;
  const cleanSource = String(source || '').trim().toLowerCase();
  if (['agent_output', 'plan_action'].includes(cleanSource)) return null;
  const payload = deriveTrackingMemoryNodePayload({ jobId, docName, markdown, provider, roleId, purpose, source: cleanSource || 'system', eventType, actorKind, pipelineStage, semanticKind });
  if (!payload?.surface_id || !String(payload?.content?.text || '').trim()) return null;
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
    });
    await ensureKnowledgeBaseMemorySurfacesInGoc(jobId, { client, threadId: map.threadId });
    return await client.createMemoryNode(map.threadId, payload);
  } catch (e) {
    jobs.log(jobId, `GoC memory append hook failed (${docName}): ${String(e?.message ?? e)}`);
    return null;
  }
}


async function flushJobGocLateSync(jobId) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId || memoryModeWithFallback() !== "goc") return { ok: false, reason: 'not_ready' };
  const client = requireGocClient();
  const jobDir = runDir(cleanJobId);
  return await flushGocLateSyncQueue({
    jobs,
    jobId: cleanJobId,
    logger: (line) => jobs.log(cleanJobId, line),
    shouldProcess: (row) => ['tracking_append', 'memory_topology', 'memory_demand'].includes(String(row?.kind || '').trim()),
    handler: async (row) => {
      const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
      const kind = String(row?.kind || '').trim();
      const map = await ensureJobThread(client, {
        jobId: cleanJobId,
        jobDir,
        title: `job:${cleanJobId}`,
      });
      if (kind === 'memory_topology') {
        await syncMemoryTopologyToGoc({
          client,
          threadId: map.threadId,
          jobDir,
          jobId: cleanJobId,
          runId: payload.runId || payload.run_id || '',
          topology: payload.topology || null,
          anchor: payload.anchor || null,
          source: payload.source || 'ddalggak:late_sync',
          eventLimit: payload.eventLimit || 40,
          logger: (line) => jobs.log(cleanJobId, line),
        });
        return;
      }
      if (kind === 'memory_demand') {
        await syncMemoryDemandToGoc({
          client,
          threadId: map.threadId,
          jobDir,
          runId: payload.runId || payload.run_id || '',
          source: payload.source || 'ddalggak:late_sync',
          eventLimit: payload.eventLimit || 80,
          logger: (line) => jobs.log(cleanJobId, line),
        });
        return;
      }
      if (kind !== 'tracking_append') return;
      if (payload.syncChunk !== false) {
        await appendTrackingChunkToGoc(client, {
          jobId: cleanJobId,
          jobDir,
          docName: payload.docName,
          chunkText: String(payload.chunk || ''),
        });
      }
      await syncTrackingAppendToGocMemory({
        jobId: cleanJobId,
        docName: payload.docName,
        markdown: payload.markdown,
        provider: payload.provider,
        roleId: payload.roleId,
        purpose: payload.purpose,
        source: payload.source,
        eventType: payload.eventType,
        actorKind: payload.actorKind,
        pipelineStage: payload.pipelineStage,
        semanticKind: payload.semanticKind,
        memoryContractEnforced: payload.memoryContractEnforced,
        threadId: map.threadId,
        client,
      });
    },
  });
}

function enqueueTrackingAppendForLateGocSync(payload = {}) {
  const jobId = String(payload?.jobId || '').trim();
  if (!jobId || !shouldUseLateGocSync()) return { queued: false };
  const result = enqueueGocLateSync({
    jobs,
    jobId,
    kind: 'tracking_append',
    reason: payload.eventType || payload.source || 'tracking_append',
    payload: {
      ...payload,
      markdown: String(payload.markdown || ''),
      chunk: String(payload.chunk || ''),
      syncChunk: payload.syncChunk !== false,
    },
  });
  scheduleGocLateSyncFlush({
    jobs,
    jobId,
    logger: (line) => jobs.log(jobId, line),
    flush: () => flushJobGocLateSync(jobId),
  });
  return result;
}

function installTrackingGocHook() {
  tracking.setAppendHook(async ({ jobId, docName, chunk, markdown, provider, roleId, purpose, source, eventType, actorKind, pipelineStage, semanticKind, memoryContractEnforced, syncToGoc }) => {
    if (syncToGoc === false) return;
    if (memoryModeWithFallback() !== "goc") return;
    const trackedDocs = tracking.listDocs(jobId).map((entry) => String(entry?.file_name || '').trim()).filter(Boolean);
    if (!trackedDocs.includes(docName) && !TRACK_DOC_NAMES.includes(docName)) return;
    const payload = {
      jobId,
      docName,
      chunk,
      markdown,
      provider,
      roleId,
      purpose,
      source,
      eventType,
      actorKind,
      pipelineStage,
      semanticKind,
      memoryContractEnforced,
    };
    if (shouldUseLateGocSync()) {
      const queued = enqueueTrackingAppendForLateGocSync(payload);
      if (queued?.queued) {
        try { jobs.log(jobId, `GoC late sync queued (${docName})`); } catch {}
      }
      return;
    }
    try {
      await appendTrackingChunkToGoc(requireGocClient(), {
        jobId,
        jobDir: runDir(jobId),
        docName,
        chunkText: String(chunk || ""),
      });
    } catch (e) {
      jobs.log(jobId, `GoC append hook failed (${docName}): ${String(e?.message ?? e)}`);
    }
    void syncTrackingAppendToGocMemory(payload);
  });
}
installTrackingGocHook();

function getAgentRolesText() {
  const roles = memory.getAgentRoles();
  return [
    "### Gemini",
    roles.gemini,
    "",
    "### Codex",
    roles.codex,
    "",
    "### ChatGPT",
    roles.chatgpt,
  ].join("\n");
}

async function getRegisteredAgentsText() {
  await refreshAgentRegistry();
  if (!agentRegistry.agents.length) return "(none)";
  return agentRegistry.agents
    .map((row) => `- id=${row.id}, provider=${row.provider}, model=${row.model}, prompt=${clip(row.prompt || "", 220)}`)
    .join("\n");
}

async function createJob(goal, { ownerUserId = null, ownerChatId = null, teamConfig = null } = {}) {
  await refreshAgentRegistry();
  const job = jobs.createJob({
    title: goal.slice(0, 80),
    ownerUserId,
    ownerChatId,
  });
  const knowledgeDesign = deriveInitialKnowledgeBaseDesign({ goal, teamConfig });
  const knowledgeBaseProfile = knowledgeDesign.profile;
  tracking.init(job.jobId, knowledgeBaseProfile);
  const syncBootstrapToGoc = shouldSyncBootstrapMemoryToGoc();
  const seedMode = String(process.env.MEMORY_SEED_MODE || 'adaptive_compact').trim().toLowerCase();
  const compactSeed = knowledgeBaseProfile.profile_id === 'adaptive_compact_seed' && !['legacy', 'structured', 'eager_structured', 'template'].includes(seedMode);
  if (compactSeed) {
    tracking.append(job.jobId, "plan", [
      '# Core Memory Seed',
      '',
      `- goal: ${goal}`,
      `- kb_profile: ${knowledgeBaseProfile.profile_id}`,
      '- memory_mode: compact_single bootstrap',
      '- policy: keep the initial run memory flat; split into plan/research/progress/artifacts only when adaptive topology pressure requires it.',
      '- artifact_policy: record uploads/generated deliverables here initially; typed artifact observations remain in artifact_observations.jsonl.',
      '',
      '## Runtime brief',
      orchestratorNotes({ goal, knowledgeBaseProfile }),
    ].join("\n"), { timestamp: false, source: 'planner', purpose: 'implementation', eventType: 'compact_core_seed', actorKind: 'planner', pipelineStage: 'initialization', semanticKind: 'plan', syncToGoc: syncBootstrapToGoc });
  } else {
    tracking.append(job.jobId, "plan", orchestratorNotes({ goal, knowledgeBaseProfile }), { timestamp: false, source: 'planner', purpose: 'implementation', eventType: 'planner_brief_seed', actorKind: 'planner', pipelineStage: 'initialization', semanticKind: 'plan', syncToGoc: syncBootstrapToGoc });
    tracking.append(job.jobId, "research", `## Goal\n\n${goal}\n`, { timestamp: false, source: 'planner', purpose: 'research', eventType: 'task_goal_seed', actorKind: 'planner', pipelineStage: 'initialization', semanticKind: 'research', syncToGoc: syncBootstrapToGoc });
    tracking.append(job.jobId, "progress", `## Started\n- goal: ${goal}\n`, { timestamp: false, source: 'system', purpose: 'implementation', eventType: 'run_started', actorKind: 'system', pipelineStage: 'initialization', semanticKind: 'progress', syncToGoc: syncBootstrapToGoc });
    tracking.append(job.jobId, "artifacts", [
      "## Artifact policy",
      "- uploads, generated files, exports, and delivery references should be indexed here.",
      `- kb_profile: ${knowledgeBaseProfile.profile_id}`,
    ].join("\n"), { timestamp: false, source: 'system', purpose: 'artifact', eventType: 'artifact_index_initialized', actorKind: 'system', pipelineStage: 'initialization', semanticKind: 'artifacts', syncToGoc: syncBootstrapToGoc });
  }
  jobs.appendConversation(job.jobId, "user", goal, { kind: "goal" });
  return job;
}


function parseJsonMaybeLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProviderName(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (["chatgpt", "gpt", "openai"].includes(key)) return "chatgpt";
  if (["codex"].includes(key)) return "codex";
  if (["gemini"].includes(key)) return "gemini";
  return "gemini";
}

function parseStructuredFromResource(resource, preferredPayloadKey = "") {
  const row = resource && typeof resource === "object" ? resource : {};
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload
    : (row.raw?.payload_json && typeof row.raw.payload_json === "object" ? row.raw.payload_json : {});

  if (preferredPayloadKey && payload[preferredPayloadKey] && typeof payload[preferredPayloadKey] === "object") {
    return payload[preferredPayloadKey];
  }
  if (payload && typeof payload === "object" && Object.keys(payload).length > 0) {
    const directPayload = payload[preferredPayloadKey] ?? payload.job_config ?? payload.tool_spec ?? payload.agent_profile_draft ?? payload.agent_profile;
    if (directPayload && typeof directPayload === "object") return directPayload;
  }

  const text = String(
    row.text
    || row.raw?.raw_text
    || row.raw?.rawText
    || row.summary
    || row.raw?.summary
    || row.raw?.text
    || row.raw?.content
    || ""
  ).trim();
  if (!text) return null;

  const direct = parseJsonMaybeLoose(text);
  if (direct && typeof direct === "object") {
    if (preferredPayloadKey && direct[preferredPayloadKey] && typeof direct[preferredPayloadKey] === "object") {
      return direct[preferredPayloadKey];
    }
    return direct;
  }
  const parsedFromText = parseJsonObjectFromText(text);
  if (parsedFromText && typeof parsedFromText === "object") {
    if (preferredPayloadKey && parsedFromText[preferredPayloadKey] && typeof parsedFromText[preferredPayloadKey] === "object") {
      return parsedFromText[preferredPayloadKey];
    }
    return parsedFromText;
  }
  return null;
}

function sortResourcesByCreatedAt(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const ta = Date.parse(String(a?.createdAt || ""));
    const tb = Date.parse(String(b?.createdAt || ""));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return 0;
  });
}

async function listActiveResourcesByKind(client, { threadId, ctxId, resourceKind }) {
  const resources = await client.listResources(threadId, {
    resourceKind,
    contextSetId: ctxId,
  });
  const ordered = sortResourcesByCreatedAt(resources);
  try {
    const explain = await client.getCompiledContextExplain(ctxId);
    const activeSet = new Set(
      (Array.isArray(explain?.active_node_ids) ? explain.active_node_ids : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    if (activeSet.size === 0) return ordered;
    const activeRows = ordered.filter((row) => activeSet.has(String(row?.id || "").trim()));
    return activeRows.length > 0 ? activeRows : ordered;
  } catch {
    return ordered;
  }
}

async function listLatestResourceByKind(client, threadId, resourceKind) {
  const rows = await client.listResources(threadId, { resourceKind });
  return sortResourcesByCreatedAt(rows).at(-1) || null;
}

function parseTimeMs(raw) {
  const t = Date.parse(String(raw || "").trim());
  return Number.isFinite(t) ? t : 0;
}

function parseNodeCreatedAtMs(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return Math.max(
    parseTimeMs(row?.createdAt),
    parseTimeMs(raw.created_at),
    parseTimeMs(raw.createdAt),
    parseTimeMs(payload.ended_at),
    parseTimeMs(payload.started_at),
    parseTimeMs(payload.created_at),
    parseTimeMs(payload.createdAt),
    parseTimeMs(payload.ts),
    parseTimeMs(payload.timestamp)
  );
}

function nodeTypeLabel(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const direct = String(
    row?.type
    || raw.node_type
    || raw.nodeType
    || raw.type
    || payload.type
    || payload.node_type
    || payload.nodeType
    || ""
  ).trim();
  if (direct) return direct;
  const resourceKind = String(
    row?.resourceKind
    || raw.resource_kind
    || raw.resourceKind
    || payload.resource_kind
    || payload.resourceKind
    || ""
  ).trim().toLowerCase();
  if (resourceKind === "artifact") return "Artifact";
  if (resourceKind) return "Resource";
  if (String(payload.role || "").trim()) return "Message";
  return "";
}

function nodeTypeKey(row = {}) {
  return String(nodeTypeLabel(row) || "").trim().toLowerCase();
}

function nodeResourceKind(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return String(
    row?.resourceKind
    || raw.resource_kind
    || raw.resourceKind
    || payload.resource_kind
    || payload.resourceKind
    || ""
  ).trim().toLowerCase();
}

function messageRoleOf(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return String(
    row?.role
    || raw.role
    || raw.author_role
    || raw.authorRole
    || payload.role
    || ""
  ).trim().toLowerCase();
}

function sortRowsByRecent(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => parseNodeCreatedAtMs(b) - parseNodeCreatedAtMs(a));
}

function uniqNodeIds(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function humanizeParticipantLabel(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return 'Agent';
  return canonicalRoleDisplayName(clean) || 'Agent';
}

function chunkNodeIds(ids = [], size = 100) {
  const rows = Array.isArray(ids) ? ids : [];
  const out = [];
  const n = Math.max(1, Math.floor(Number(size) || 100));
  for (let i = 0; i < rows.length; i += n) {
    out.push(rows.slice(i, i + n));
  }
  return out;
}

function summarizeJobConfigDebug(rawConfig = {}) {
  const row = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const mode = String(row.mode || "supervisor").trim().toLowerCase() || "supervisor";
  const style = String(row.final_response_style || row.finalResponseStyle || "concise").trim().toLowerCase() || "concise";
  const participants = Array.isArray(row.participants)
    ? row.participants.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const budget = row.budget && typeof row.budget === "object" ? row.budget : {};
  const maxActions = Number.isFinite(Number(budget.max_actions)) ? Math.max(1, Math.floor(Number(budget.max_actions))) : 4;
  const maxRisk = String(budget.max_risk || "L2").trim().toUpperCase() || "L2";
  return [
    `mode=${mode}`,
    `style=${style}`,
    `participants=${participants.length > 0 ? participants.map((id) => humanizeParticipantLabel(id)).join(', ') : '(none)'}`,
    `budget.max_actions=${maxActions}`,
    `budget.max_risk=${maxRisk}`,
  ].join(", ");
}

function buildSharedContextSelectionPolicy(runtime = {}) {
  const row = runtime && typeof runtime === "object" ? runtime : {};
  const cfg = row?.jobConfig && typeof row.jobConfig === "object" ? row.jobConfig : {};
  const policy = cfg?.context_policy && typeof cfg.context_policy === "object"
    ? cfg.context_policy
    : {};
  const pinnedNodeIds = Array.isArray(policy.pinned_node_ids)
    ? policy.pinned_node_ids.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const parseLimit = (value, fallback, maxCap) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.min(maxCap, Math.floor(n)));
  };
  const excludeKinds = Array.isArray(policy.exclude_resource_kinds)
    ? policy.exclude_resource_kinds.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    : SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS;
  return {
    pinned_node_ids: pinnedNodeIds,
    recent_user_messages: parseLimit(policy.recent_user_messages, SHARED_CONTEXT_RECENT_USER_MESSAGES, 40),
    recent_assistant_messages: parseLimit(policy.recent_assistant_messages, SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES, 40),
    recent_run_step: parseLimit(policy.recent_run_step, SHARED_CONTEXT_RECENT_RUN_STEP, 80),
    recent_tool_artifact: parseLimit(policy.recent_tool_artifact, SHARED_CONTEXT_RECENT_TOOL_ARTIFACT, 40),
    exclude_resource_kinds: excludeKinds.length > 0 ? excludeKinds : ["job_config", "tracking_append"],
  };
}

function summarizeActiveTypeBreakdown(nodeIds = [], nodeMap = new Map()) {
  const breakdown = {};
  for (const idRaw of Array.isArray(nodeIds) ? nodeIds : []) {
    const id = String(idRaw || "").trim();
    if (!id) continue;
    const node = nodeMap.get(id);
    const type = nodeTypeKey(node);
    const resourceKind = nodeResourceKind(node);
    const role = messageRoleOf(node);
    let key = type || "unknown";
    if (type === "message" && role) key = `message:${role}`;
    else if ((type === "resource" || type === "artifact") && resourceKind) key = `resource:${resourceKind}`;
    breakdown[key] = Number(breakdown[key] || 0) + 1;
  }
  return breakdown;
}

async function refreshSharedContext(client, {
  threadId = "",
  sharedCtxId = "",
  policy = {},
  logger = null,
} = {}) {
  const tid = String(threadId || "").trim();
  const ctxId = String(sharedCtxId || "").trim();
  if (!tid || !ctxId || !client) {
    return { ok: false, reason: "missing_thread_or_context" };
  }
  const log = typeof logger === "function" ? logger : () => {};

  const normalizedPolicy = {
    pinned_node_ids: Array.isArray(policy?.pinned_node_ids)
      ? policy.pinned_node_ids.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
    recent_user_messages: Number.isFinite(Number(policy?.recent_user_messages))
      ? Math.max(1, Math.floor(Number(policy.recent_user_messages)))
      : SHARED_CONTEXT_RECENT_USER_MESSAGES,
    recent_assistant_messages: Number.isFinite(Number(policy?.recent_assistant_messages))
      ? Math.max(1, Math.floor(Number(policy.recent_assistant_messages)))
      : SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES,
    recent_run_step: Number.isFinite(Number(policy?.recent_run_step))
      ? Math.max(1, Math.floor(Number(policy.recent_run_step)))
      : SHARED_CONTEXT_RECENT_RUN_STEP,
    recent_tool_artifact: Number.isFinite(Number(policy?.recent_tool_artifact))
      ? Math.max(1, Math.floor(Number(policy.recent_tool_artifact)))
      : SHARED_CONTEXT_RECENT_TOOL_ARTIFACT,
    exclude_resource_kinds: Array.isArray(policy?.exclude_resource_kinds)
      ? policy.exclude_resource_kinds.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
      : SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS,
  };
  const excludedKinds = new Set(normalizedPolicy.exclude_resource_kinds);

  const [messages, nodes, explain] = await Promise.all([
    client.listMessages(tid, { limit: 120 }).catch(() => []),
    client.listNodes(tid, { contextSetId: ctxId }).catch(() => []),
    client.getCompiledContextExplain(ctxId).catch(() => ({ active_node_ids: [] })),
  ]);

  const nodeMap = new Map();
  for (const row of Array.isArray(nodes) ? nodes : []) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    nodeMap.set(id, row);
  }
  for (const row of Array.isArray(messages) ? messages : []) {
    const id = String(row?.id || "").trim();
    if (!id || nodeMap.has(id)) continue;
    nodeMap.set(id, row);
  }

  const currentActiveIds = uniqNodeIds(
    (Array.isArray(explain?.active_node_ids) ? explain.active_node_ids : [])
      .map((id) => ({ id }))
  );
  const currentActiveSet = new Set(currentActiveIds);

  const messageRows = sortRowsByRecent(messages);
  const userMessageIds = uniqNodeIds(
    messageRows
      .filter((row) => messageRoleOf(row) === "user")
      .slice(0, normalizedPolicy.recent_user_messages)
  );
  const assistantMessageIds = uniqNodeIds(
    messageRows
      .filter((row) => messageRoleOf(row) === "assistant")
      .slice(0, normalizedPolicy.recent_assistant_messages)
  );

  const nodeRows = sortRowsByRecent(nodes);
  const runStepIds = uniqNodeIds(
    nodeRows
      .filter((row) => {
        const type = nodeTypeKey(row);
        return type === "run" || type === "step";
      })
      .slice(0, normalizedPolicy.recent_run_step)
  );
  const toolArtifactIds = uniqNodeIds(
    nodeRows
      .filter((row) => {
        const type = nodeTypeKey(row);
        const resourceKind = nodeResourceKind(row);
        if (type === "toolresult") return true;
        if (type === "artifact") return true;
        if (type === "resource" && resourceKind === "artifact") return true;
        return false;
      })
      .slice(0, normalizedPolicy.recent_tool_artifact)
  );

  const selectedSet = new Set([
    ...normalizedPolicy.pinned_node_ids,
    ...userMessageIds,
    ...assistantMessageIds,
    ...runStepIds,
    ...toolArtifactIds,
  ].map((id) => String(id || "").trim()).filter(Boolean));

  const excludedResourceIds = [];
  for (const row of nodeRows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    const resourceKind = nodeResourceKind(row);
    if (!resourceKind || !excludedKinds.has(resourceKind)) continue;
    excludedResourceIds.push(id);
    selectedSet.delete(id);
  }

  const toActivate = [...selectedSet].filter((id) => !currentActiveSet.has(id));
  const toDeactivate = currentActiveIds.filter((id) => !selectedSet.has(id) || excludedResourceIds.includes(id));

  for (const ids of chunkNodeIds(toDeactivate, 120)) {
    if (ids.length === 0) continue;
    await client.deactivateNodes(ctxId, ids).catch((e) => {
      log(`[shared-context] deactivate failed: ${String(e?.message ?? e)}`);
    });
  }
  for (const ids of chunkNodeIds(toActivate, 120)) {
    if (ids.length === 0) continue;
    await client.activateNodes(ctxId, ids).catch((e) => {
      log(`[shared-context] activate failed: ${String(e?.message ?? e)}`);
    });
  }

  let refreshedActiveIds = [...selectedSet];
  let refreshedNodeMap = nodeMap;
  try {
    const refreshedExplain = await client.getCompiledContextExplain(ctxId);
    refreshedActiveIds = uniqNodeIds(
      (Array.isArray(refreshedExplain?.active_node_ids) ? refreshedExplain.active_node_ids : [])
        .map((id) => ({ id }))
    );
    const refreshedNodes = await client.listNodes(tid, { contextSetId: ctxId }).catch(() => []);
    if (Array.isArray(refreshedNodes) && refreshedNodes.length > 0) {
      refreshedNodeMap = new Map();
      for (const row of refreshedNodes) {
        const id = String(row?.id || "").trim();
        if (!id) continue;
        refreshedNodeMap.set(id, row);
      }
    }
  } catch {}

  return {
    ok: true,
    selected_count: selectedSet.size,
    activated_count: toActivate.length,
    deactivated_count: toDeactivate.length,
    excluded_resource_count: excludedResourceIds.length,
    active_node_ids: refreshedActiveIds,
    active_type_breakdown: summarizeActiveTypeBreakdown(refreshedActiveIds, refreshedNodeMap),
    policy: normalizedPolicy,
  };
}

async function refreshSharedContextForRuntime(runtime, {
  jobId = "",
  reason = "",
} = {}) {
  const row = runtime && typeof runtime === "object" ? runtime : null;
  if (!row || memoryModeWithFallback() !== "goc") return null;
  const threadId = String(row?.map?.threadId || "").trim();
  const ctxId = String(row?.map?.ctxSharedId || "").trim();
  if (!threadId || !ctxId) return null;
  const client = requireGocClient();
  const policy = buildSharedContextSelectionPolicy(row);
  const refreshed = await refreshSharedContext(client, {
    threadId,
    sharedCtxId: ctxId,
    policy,
    logger: (line) => {
      if (!jobId) return;
      jobs.log(jobId, line);
    },
  }).catch(() => null);
  if (!refreshed?.ok) return refreshed;

  try {
    const compiled = await client.getCompiledContext(ctxId);
    row.contextSummary = String(compiled || "").trim();
  } catch {}
  try {
    const meta = await client.getContextSet(ctxId);
    row.contextMeta = {
      context_set_id: ctxId,
      version: String(meta?.version || "").trim(),
      active_node_ids: Array.isArray(meta?.activeNodeIds)
        ? meta.activeNodeIds.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    row.contextMeta = row.contextMeta && typeof row.contextMeta === "object"
      ? row.contextMeta
      : {
        context_set_id: ctxId,
        version: "",
        active_node_ids: [],
      };
  }
  row.sharedActiveTypeBreakdown = refreshed.active_type_breakdown && typeof refreshed.active_type_breakdown === "object"
    ? refreshed.active_type_breakdown
    : {};
  if (jobId) {
    tracking.append(jobId, "decisions", [
      "## shared_context_refresh",
      `- reason: ${reason || "manual"}`,
      `- selected_count: ${refreshed.selected_count}`,
      `- activated_count: ${refreshed.activated_count}`,
      `- deactivated_count: ${refreshed.deactivated_count}`,
      `- excluded_resource_count: ${refreshed.excluded_resource_count}`,
    ].join("\n"));
  }
  return refreshed;
}

function normalizeToolSpec(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.tool_id || row.name || "").trim();
  if (!id) return null;
  const actionTypes = Array.isArray(row.action_types || row.actions)
    ? (row.action_types || row.actions)
      .map((v) => String(v || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  return {
    id,
    name: String(row.name || id).trim(),
    description: String(row.description || "").trim(),
    action_types: actionTypes,
    risk: String(row.risk || "L1").trim().toUpperCase(),
    raw: row,
  };
}

function normalizeCatalogIds(list = [], { lower = true } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = typeof row === "string"
      ? row
      : String(
        row?.id
        || row?.tool_id
        || row?.toolId
        || row?.agent_id
        || row?.agentId
        || row?.name
        || ""
      ).trim();
    if (!raw) continue;
    const cleanRaw = String(raw || "").trim();
    const id = lower ? cleanRaw.toLowerCase() : cleanRaw;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function summarizeSelectionState({ catalog = [], enabled = [] } = {}) {
  const catalogIds = normalizeCatalogIds(catalog);
  const enabledIds = normalizeCatalogIds(enabled);
  const enabledSet = new Set(enabledIds);
  const disabledIds = catalogIds.filter((id) => !enabledSet.has(id));
  return {
    catalog_ids: catalogIds,
    enabled_ids: enabledIds,
    disabled_ids: disabledIds,
  };
}

function pickBaselineConversationCatalogAgents(agentsCatalog = []) {
  const rows = Array.isArray(agentsCatalog) ? agentsCatalog : [];
  const requiredRoles = ["router", "planner", "researcher", "coder"];
  const byRole = [];
  const seen = new Set();
  for (const role of requiredRoles) {
    const match = rows.find((row) => {
      const systemKey = normalizeAgentLookupKey(row?.system_key || row?.systemKey || "");
      const id = normalizeAgentLookupKey(row?.id || "");
      const name = normalizeAgentLookupKey(row?.name || "");
      if (systemKey === role) return true;
      if (id === role) return true;
      return name.includes(role);
    });
    const cleanId = String(match?.id || "").trim().toLowerCase();
    if (!cleanId || seen.has(cleanId)) continue;
    seen.add(cleanId);
    byRole.push(cleanId);
  }
  return byRole;
}

function buildAgentProfileFromProposal(action) {
  const id = String(action?.agent_id || action?.id || "").trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    name: String(action?.name || id).trim() || id,
    description: String(action?.description || "").trim(),
    provider: normalizeProviderName(action?.provider || action?.model || "gemini"),
    model: String(action?.model || action?.provider || "gemini").trim() || "gemini",
    prompt: String(action?.prompt || action?.goal || "").trim(),
    meta: action?.meta && typeof action.meta === "object" ? action.meta : {},
  };
}

function buildGocAgentCreateSpec(spec = {}) {
  const row = spec && typeof spec === "object" ? spec : {};
  const name = String(row.name || row.title || row.id || row.agent_id || "").trim();
  const description = String(row.description || "").trim();
  const systemPrompt = String(
    row.system_prompt
    || row.systemPrompt
    || row.prompt
    || ""
  ).trim();
  const instruction = String(row.instruction || "").trim();
  const tools = Array.isArray(row.tools)
    ? row.tools.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const provider = String(row.provider || "").trim().toLowerCase();
  const model = String(row.model || "").trim();
  let modelRef = "";
  if (provider && model && !model.includes(":")) modelRef = `${provider}:${model}`;
  else if (model) modelRef = model;
  else if (provider) modelRef = provider;
  const visibilityRaw = String(row.visibility || row.scope || "").trim().toLowerCase();
  const visibility = ["private", "public", "installed"].includes(visibilityRaw)
    ? visibilityRaw
    : "private";
  return {
    name,
    description,
    system_prompt: systemPrompt,
    instruction,
    tools,
    model: modelRef,
    visibility,
  };
}

function normalizeBlueprintSearchItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((row) => ({
      blueprint_id: String(row?.blueprint_id || "").trim(),
      public_node_id: String(row?.public_node_id || "").trim(),
      agent_id: String(row?.agent_id || "").trim().toLowerCase(),
      title: String(row?.title || "").trim(),
      tags: Array.isArray(row?.tags) ? row.tags.map((v) => String(v || "").trim()).filter(Boolean) : [],
      description: String(row?.description || "").trim(),
    }))
    .filter((row) => row.blueprint_id || row.public_node_id || row.agent_id);
}

function filterPublicBlueprintCandidates(items = [], query = "", limit = 5) {
  const rows = normalizeBlueprintSearchItems(items);
  const q = String(query || "").trim().toLowerCase();
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(10, Math.floor(Number(limit)))) : 5;
  if (!q) return rows.slice(0, max);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = rows.map((row) => {
    const hay = [
      row.title,
      row.agent_id,
      row.blueprint_id,
      row.description,
      ...(Array.isArray(row.tags) ? row.tags : []),
    ].join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (hay.includes(token)) score += 1;
      if (row.agent_id === token) score += 3;
      if (row.blueprint_id === token) score += 3;
    }
    return { row, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row)
    .slice(0, max);
}

function resolveInstallCandidateFromSession(session, action = {}) {
  const cache = normalizeBlueprintSearchItems(session?.public_search_cache || []);
  if (cache.length === 0) return null;
  const publicNodeId = String(action.public_node_id || "").trim();
  const blueprintId = String(action.blueprint_id || "").trim();
  const overrideAgentId = String(action.agent_id_override || "").trim().toLowerCase();

  if (publicNodeId) {
    const found = cache.find((row) => row.public_node_id === publicNodeId);
    if (found) return found;
  }
  if (blueprintId) {
    const found = cache.find((row) => row.blueprint_id === blueprintId);
    if (found) return found;
  }
  if (overrideAgentId) {
    const found = cache.find((row) => row.agent_id === overrideAgentId);
    if (found) return found;
  }
  return cache[0] || null;
}

function parseAgentIdFromProfileResource(resource) {
  const payload = resource?.payload && typeof resource.payload === "object" ? resource.payload : {};
  const candidate = payload.agent_profile && typeof payload.agent_profile === "object"
    ? payload.agent_profile
    : parseStructuredFromResource(resource, "agent_profile");
  const id = String(
    candidate?.id
    || candidate?.agent_id
    || payload.agent_id
    || ""
  ).trim().toLowerCase();
  return id;
}

async function findLatestAgentProfileNodeForPublish(client, agentsSlot, { agentNodeId = "", agentId = "" } = {}) {
  const directNodeId = String(agentNodeId || "").trim();
  if (directNodeId) {
    const node = await client.getNode(directNodeId);
    if (!node) return null;
    return { id: directNodeId, node };
  }

  const targetAgentId = String(agentId || "").trim().toLowerCase();
  const resources = await listActiveResourcesByKind(client, {
    threadId: agentsSlot.threadId,
    ctxId: agentsSlot.ctxId,
    resourceKind: "agent_profile",
  });
  for (let i = resources.length - 1; i >= 0; i -= 1) {
    const row = resources[i];
    const parsedAgentId = parseAgentIdFromProfileResource(row);
    if (targetAgentId && parsedAgentId !== targetAgentId) continue;
    if (row?.id) return row;
  }
  return null;
}


async function openAgentsUiInfo({ chatId = null, jobId = "", userId = "" } = {}) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error("open_agents_ui requires MEMORY_MODE=goc");
  }
  const client = requireGocClient();
  const restoreActor = bindGocActor(userId);
  try {
    const requestedJobId = String(jobId || "").trim();
    const resolvedJobId = requestedJobId || (chatId == null ? "" : String(resolveCurrentJobIdForChat(chatId) || "").trim());
    if (resolvedJobId) {
      const map = await ensureJobThread(client, {
        jobId: resolvedJobId,
        jobDir: runDir(resolvedJobId),
        title: `job:${resolvedJobId}`,
        telegram: chatId == null ? null : { chat_id: String(chatId || "") },
      });
      const links = await buildContextLinks(client, {
        threadId: map.threadId,
        ctxId: map.ctxSharedId,
        page: "agents",
      });
      return {
        scope: "job",
        jobId: resolvedJobId,
        threadId: map.threadId,
        ctxId: map.ctxSharedId,
        browserLink: links.browserLink,
        miniAppLink: links.miniAppLink,
        link: links.browserLink || links.miniAppLink,
        tokenExp: links.browserTokenExp || null,
        lines: [
          "thread team",
          `jobId=${resolvedJobId}`,
          `thread=${map.threadId}`,
          `ctx=${map.ctxSharedId}`,
          links.browserTokenExp ? `token_exp=${links.browserTokenExp}` : "",
          `browser_link=${links.browserLink}`,
          links.miniAppSupported ? `miniapp_link=${links.miniAppLink}` : "",
        ].filter(Boolean),
      };
    }

    const links = await buildContextLinks(client, { page: "agents" });
    return {
      scope: "catalog",
      jobId: "",
      threadId: "",
      ctxId: "",
      browserLink: links.browserLink,
      miniAppLink: links.miniAppLink,
      link: links.browserLink || links.miniAppLink,
      tokenExp: links.browserTokenExp || null,
      lines: [
        "agents catalog",
        links.browserTokenExp ? `token_exp=${links.browserTokenExp}` : "",
        `browser_link=${links.browserLink}`,
        links.miniAppSupported ? `miniapp_link=${links.miniAppLink}` : "",
      ].filter(Boolean),
    };
  } finally {
    restoreActor();
  }
}

async function createAgentDraftProposal(bot, chatId, userId, jobId, action) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error("propose_agent requires MEMORY_MODE=goc");
  }
  const profile = buildAgentProfileFromProposal(action);
  if (!profile?.id) throw new Error("propose_agent requires agent_id");

  const client = requireGocClient();
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const nowIso = new Date().toISOString();
  const rawText = `${JSON.stringify(profile, null, 2)}\n`;
  const created = await client.createResource(slot.threadId, {
    name: `agent_draft:${profile.id}@${nowIso}`,
    summary: `agent_profile_draft ${profile.id}`,
    text_mode: "plain",
    raw_text: rawText,
    resource_kind: "agent_profile_draft",
    uri: `ddalggak://agents/draft/${profile.id}`,
    context_set_id: slot.ctxId,
    auto_activate: true,
    payload_json: {
      op: "draft",
      ts: nowIso,
      agent_id: profile.id,
      job_id: String(jobId || "").trim() || undefined,
      proposed_by: `telegram:${userId}`,
      agent_profile_draft: profile,
    },
  });
  const draftNodeId = String(created?.id || "").trim();
  const cleanDescription = clip(
    String(profile.description || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / "),
    220
  ) || "(none)";
  const promptPreview = clip(
    String(profile.prompt || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join(" "),
    360
  ) || "(none)";
  const providerModel = `${String(profile.provider || "gemini").trim() || "gemini"}/${String(profile.model || profile.provider || "gemini").trim() || "gemini"}`;
  const approveCallback = draftNodeId
    ? `approve_draft:${draftNodeId}`
    : `approve_agent:${profile.id}`;
  const rejectCallback = draftNodeId
    ? `reject_draft:${draftNodeId}`
    : `reject_agent:${profile.id}`;

  const cleanJobId = String(jobId || "").trim();
  if (cleanJobId) {
    tracking.append(cleanJobId, "decisions", [
      "## /chat propose_agent",
      `- agent_id: ${profile.id}`,
      `- draft_node: ${created?.id || "unknown"}`,
      `- proposed_by: telegram:${userId}`,
    ].join("\n"));
  }
  const openAgentsUiCallback = cleanJobId ? `open_agents_ui:${cleanJobId}` : "open_agents_ui";

  await bot.sendMessage(
    chatId,
    [
      "🧪 agent draft 생성됨",
      `agent_id=${profile.id}`,
      `name=${clip(String(profile.name || profile.id), 120)}`,
      `description=${cleanDescription}`,
      `provider/model=${providerModel}`,
      `prompt_preview=${promptPreview}`,
      `draft_node=${draftNodeId || "unknown"}`,
      cleanJobId
        ? `승인하면 agent_profile이 registry에 추가되고, job_id=${cleanJobId} participants에 반영됩니다.`
        : "승인하면 agent_profile이 registry에 추가됩니다. (job_id 미확인 시 participants 반영 생략)",
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: approveCallback },
          { text: "❌ Reject", callback_data: rejectCallback },
          { text: "🧭 Agents UI", callback_data: openAgentsUiCallback },
        ]],
      },
    }
  );

  return { draft_id: created?.id || "", profile, slot };
}

async function findLatestDraftByAgentId(client, agentId) {
  const key = String(agentId || "").trim().toLowerCase();
  if (!key) return null;
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const resources = await client.listResources(slot.threadId, {
    resourceKind: "agent_profile_draft",
  });
  const ordered = sortResourcesByCreatedAt(resources);

  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const row = ordered[i];
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    const draft = parseStructuredFromResource(row, "agent_profile_draft") || parseStructuredFromResource(row, "agent_profile");
    const id = String(
      payload.agent_id
      || draft?.agent_id
      || draft?.id
      || ""
    ).trim().toLowerCase();
    if (id !== key) continue;
    return { slot, resource: row, payload, draft };
  }
  return null;
}

async function findDraftByNodeId(client, draftNodeId) {
  const key = String(draftNodeId || "").trim();
  if (!key) return null;
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  let node = null;
  try {
    node = await client.getNode(key);
  } catch (e) {
    return {
      slot,
      resource: null,
      payload: {},
      draft: null,
      lookupError: `getNode failed: ${String(e?.message ?? e)}`,
    };
  }
  const row = typeof client.normalizeResource === "function"
    ? client.normalizeResource(node)
    : (node && typeof node === "object" ? node : {});
  const resource = row && typeof row === "object"
    ? {
      ...row,
      id: String(row.id || key).trim(),
    }
    : { id: key };
  const payload = resource?.payload && typeof resource.payload === "object" ? resource.payload : {};
  const fallbackKind = payload?.agent_profile_draft && typeof payload.agent_profile_draft === "object"
    ? "agent_profile_draft"
    : "";
  const kind = String(
    resource.resourceKind
    || node?.resource_kind
    || node?.resourceKind
    || node?.payload?.resource_kind
    || node?.payload?.resourceKind
    || fallbackKind
  ).trim().toLowerCase();
  if (kind !== "agent_profile_draft") {
    return {
      slot,
      resource: null,
      payload: {},
      draft: null,
      lookupError: `node kind mismatch: ${kind || "unknown"}`,
    };
  }
  const draft = parseStructuredFromResource(resource, "agent_profile_draft") || parseStructuredFromResource(resource, "agent_profile");
  return { slot, resource, payload, draft };
}

async function appendParticipantToJobConfig(client, { jobId, agentId, actor = "" }) {
  const map = await ensureJobThread(client, {
    jobId,
    jobDir: runDir(jobId),
    title: `job:${jobId}`,
  });
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  if (!cleanAgentId) throw new Error("appendParticipantToJobConfig requires agentId");

  if (
    typeof client.ensureConversation === "function"
    && typeof client.addConversationAgent === "function"
    && typeof client.listConversationAgents === "function"
  ) {
    const membershipTarget = await resolveMembershipTargetForThread(client, {
      threadId: map.threadId,
      jobId,
      source: "append_participant_to_job_config",
      ensureConversation: true,
    });
    const mutationResponse = await client.addConversationAgent(membershipTarget, cleanAgentId, true);
    const conversationAgents = await client.listConversationAgents(membershipTarget);
    const enabledAgentIds = Array.from(new Set(
      (Array.isArray(conversationAgents) ? conversationAgents : [])
        .filter((row) => row?.enabled !== false)
        .map((row) => String(row?.agent_id || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    const verification = verifyConversationMembershipMutation({
      actionType: "add_agent_to_conversation",
      threadId: membershipTarget.thread_id || map.threadId,
      conversationId: membershipTarget.conversation_id || "",
      targetAgentId: cleanAgentId,
      expectedPresent: true,
      expectedEnabled: true,
      conversationRows: conversationAgents,
      source: "append_participant",
      extra: {
        job_id: String(jobId || "").trim(),
        membership_target: summarizeMembershipTarget(membershipTarget),
        ensured_thread_mismatch: membershipTarget.ensured_thread_mismatch === true,
        mutation_response: summarizeMembershipMutationResponse(mutationResponse),
      },
    });
    if (!verification.confirmed) {
      recordMembershipMutationDiagnostic(jobId, verification, {
        stage: "membership_confirmation_failed",
      });
      throw createMembershipConfirmationError(verification);
    }
    return {
      map,
      created: {
        id: `${String(map.threadId || "").trim()}:${cleanAgentId}`,
      },
      config: null,
      source: "conversation_agents",
      actor,
      enabledAgentIds,
      conversationAgents,
      membership_target: summarizeMembershipTarget(membershipTarget),
      membership_change: verification,
    };
  }

  return { map, created: null, config: null, source: "none" };
}

function recordMembershipMutationDiagnostic(jobId, diagnostic = {}, { stage = "" } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const row = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
  const stageLabel = String(stage || "").trim() || "membership_mutation";
  const text = JSON.stringify(row);
  if (cleanJobId) {
    tracking.append(cleanJobId, "decisions", [
      `## /chat ${stageLabel}`,
      `- diagnostic: ${text}`,
    ].join("\n"));
    jobs.log(cleanJobId, `[membership] ${stageLabel} ${text}`);
  }
}

async function resolveMembershipTargetForThread(client, {
  threadId,
  conversationId = "",
  jobId = "",
  source = "",
  ensureConversation = false,
} = {}) {
  const target = await resolveConversationMembershipTarget(client, {
    threadId,
    conversationId,
    source: source || "membership_target_resolution",
    ensureConversation: ensureConversation === true,
  });
  if (target.ensure_error) {
    recordMembershipMutationDiagnostic(jobId, {
      action: "resolve_membership_target",
      stage: "ensure_conversation_error",
      source: source || "membership_target_resolution",
      target: summarizeMembershipTarget(target),
      ensure_error: target.ensure_error,
    }, {
      stage: "membership_target_ensure_error",
    });
  }
  if (target.ensured_thread_mismatch) {
    recordMembershipMutationDiagnostic(jobId, {
      action: "resolve_membership_target",
      stage: "ensure_thread_mismatch",
      source: source || "membership_target_resolution",
      requested_target: target.requested_target,
      ensured_target: target.ensured_target,
      target: summarizeMembershipTarget(target),
    }, {
      stage: "membership_target_mismatch",
    });
  }
  return target;
}

async function updateJobConfigSelection(client, {
  jobId,
  op,
  kind,
  id,
  actor = "",
  agentsCatalog = [],
  toolsCatalog = [],
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanOp = String(op || "").trim().toLowerCase();
  const cleanKind = String(kind || "").trim().toLowerCase();
  const cleanId = String(id || "").trim().toLowerCase();
  if (!cleanJobId) throw new Error("updateJobConfigSelection requires jobId");
  if (!["enable", "disable"].includes(cleanOp)) throw new Error("updateJobConfigSelection op must be enable|disable");
  if (!["agent", "tool"].includes(cleanKind)) throw new Error("updateJobConfigSelection kind must be agent|tool");
  if (!cleanId) throw new Error("updateJobConfigSelection requires id");

  const map = await ensureJobThread(client, {
    jobId: cleanJobId,
    jobDir: runDir(cleanJobId),
    title: `job:${cleanJobId}`,
  });

  if (cleanKind === "agent") {
    if (typeof client.ensureConversation !== "function" || typeof client.listConversationAgents !== "function") {
      throw new Error("conversation agent APIs unavailable");
    }
    const membershipTarget = await resolveMembershipTargetForThread(client, {
      threadId: map.threadId,
      jobId: cleanJobId,
      source: "update_job_config_selection",
      ensureConversation: true,
    });
    let mutationResponse = null;
    if (cleanOp === "disable") {
      if (typeof client.patchConversationAgent === "function") {
        await client.patchConversationAgent(membershipTarget, cleanId, { enabled: false }).then((row) => {
          mutationResponse = row;
        }).catch(async () => {
          if (typeof client.addConversationAgent === "function") {
            mutationResponse = await client.addConversationAgent(membershipTarget, cleanId, false);
          } else {
            throw new Error("conversation agent disable is not supported by API");
          }
        });
      } else if (typeof client.addConversationAgent === "function") {
        mutationResponse = await client.addConversationAgent(membershipTarget, cleanId, false);
      } else {
        throw new Error("conversation agent disable is not supported by API");
      }
    } else if (typeof client.patchConversationAgent === "function") {
      await client.patchConversationAgent(membershipTarget, cleanId, { enabled: true }).then((row) => {
        mutationResponse = row;
      }).catch(async () => {
        if (typeof client.addConversationAgent === "function") {
          mutationResponse = await client.addConversationAgent(membershipTarget, cleanId, true);
        } else {
          throw new Error("conversation agent enable is not supported by API");
        }
      });
    } else if (typeof client.addConversationAgent === "function") {
      mutationResponse = await client.addConversationAgent(membershipTarget, cleanId, true);
    } else {
      throw new Error("conversation agent enable is not supported by API");
    }
    const conversationAgents = await client.listConversationAgents(membershipTarget);
    const enabledAgentIds = Array.from(new Set(
      (Array.isArray(conversationAgents) ? conversationAgents : [])
        .filter((row) => row?.enabled !== false)
        .map((row) => String(row?.agent_id || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    const verification = verifyConversationMembershipMutation({
      actionType: cleanOp === "enable" ? "enable_agent" : "disable_agent",
      threadId: membershipTarget.thread_id || map.threadId,
      conversationId: membershipTarget.conversation_id || "",
      targetAgentId: cleanId,
      expectedPresent: true,
      expectedEnabled: cleanOp === "enable",
      conversationRows: conversationAgents,
      source: "update_job_config_selection",
      extra: {
        job_id: cleanJobId,
        membership_target: summarizeMembershipTarget(membershipTarget),
        ensured_thread_mismatch: membershipTarget.ensured_thread_mismatch === true,
        mutation_response: summarizeMembershipMutationResponse(mutationResponse),
      },
    });
    if (!verification.confirmed) {
      recordMembershipMutationDiagnostic(cleanJobId, verification, {
        stage: "membership_confirmation_failed",
      });
      throw createMembershipConfirmationError(verification);
    }
    return {
      map,
      config: null,
      source: "conversation_agents",
      conversationAgents,
      enabledAgentIds,
      membership_target: summarizeMembershipTarget(membershipTarget),
      membership_change: verification,
      op: cleanOp,
      kind: cleanKind,
      id: cleanId,
    };
  }

  const latest = await listLatestResourceByKind(client, map.threadId, "job_config");
  const currentRaw = latest ? parseStructuredFromResource(latest, "job_config") : null;
  const normalized = normalizeSupervisorJobConfig(
    currentRaw || { job_id: cleanJobId },
    { agentsCatalog, toolsCatalog }
  );
  const current = normalized.configNormalized;

  const uniq = (list = []) => {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      const value = String(entry || "").trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };

  const currentAgentSet = current.agent_set && typeof current.agent_set === "object"
    ? current.agent_set
    : { mode: "all_enabled", selected: [], disabled: [] };
  const currentToolSet = current.tool_set && typeof current.tool_set === "object"
    ? current.tool_set
    : { mode: "all_enabled", selected: [], disabled: [] };
  const nextAgentSet = {
    mode: String(currentAgentSet.mode || "").trim().toLowerCase() === "selected" ? "selected" : "all_enabled",
    selected: uniq(currentAgentSet.selected),
    disabled: uniq(currentAgentSet.disabled),
  };
  const nextToolSet = {
    mode: String(currentToolSet.mode || "").trim().toLowerCase() === "selected" ? "selected" : "all_enabled",
    selected: uniq(currentToolSet.selected),
    disabled: uniq(currentToolSet.disabled),
  };
  let participants = uniq(current.participants);

  if (cleanKind === "agent") {
    if (cleanOp === "disable") {
      nextAgentSet.disabled = uniq([...nextAgentSet.disabled, cleanId]);
      if (nextAgentSet.mode === "selected") {
        nextAgentSet.selected = nextAgentSet.selected.filter((entry) => entry !== cleanId);
      }
      participants = participants.filter((entry) => entry !== cleanId);
    } else {
      nextAgentSet.disabled = nextAgentSet.disabled.filter((entry) => entry !== cleanId);
      if (nextAgentSet.mode === "selected") {
        nextAgentSet.selected = uniq([...nextAgentSet.selected, cleanId]);
      }
      participants = uniq([...participants, cleanId]);
    }
  } else if (cleanOp === "disable") {
    nextToolSet.disabled = uniq([...nextToolSet.disabled, cleanId]);
    if (nextToolSet.mode === "selected") {
      nextToolSet.selected = nextToolSet.selected.filter((entry) => entry !== cleanId);
    }
  } else {
    nextToolSet.disabled = nextToolSet.disabled.filter((entry) => entry !== cleanId);
    if (nextToolSet.mode === "selected") {
      nextToolSet.selected = uniq([...nextToolSet.selected, cleanId]);
    }
  }

  const nextConfig = {
    ...current,
    version: Math.max(2, Number(current.version || 2) || 2),
    schema_version: Math.max(2, Number(current.schema_version || current.schemaVersion || 2) || 2),
    participants,
    agent_set: nextAgentSet,
    tool_set: nextToolSet,
    updated_at: new Date().toISOString(),
  };
  const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;

  if (latest?.id) {
    await client.updateNode(String(latest.id), {
      text_mode: "plain",
      text: rawText,
      raw_text: rawText,
      summary: `job_config ${cleanOp}_${cleanKind}:${cleanId}`,
    });
  } else {
    await client.createResource(map.threadId, {
      name: `job_config@${new Date().toISOString()}`,
      summary: `job_config ${cleanOp}_${cleanKind}:${cleanId}`,
      text_mode: "plain",
      raw_text: rawText,
      resource_kind: "job_config",
      uri: `ddalggak://jobs/${cleanJobId}/job_config`,
      context_set_id: map.ctxSharedId,
      auto_activate: false,
      payload_json: {
        op: `${cleanOp}_${cleanKind}`,
        ts: new Date().toISOString(),
        job_id: cleanJobId,
        actor: actor || undefined,
        job_config: nextConfig,
      },
    });
  }

  tracking.append(cleanJobId, "decisions", [
    "## /chat update_job_config_selection",
    `- op: ${cleanOp}`,
    `- kind: ${cleanKind}`,
    `- id: ${cleanId}`,
    actor ? `- actor: ${actor}` : "",
  ].filter(Boolean).join("\n"));

  return {
    job_id: cleanJobId,
    op: cleanOp,
    kind: cleanKind,
    id: cleanId,
    config: nextConfig,
    node_id: String(latest?.id || "").trim(),
  };
}

export {
  refreshAgentRegistryLocal,
  refreshAgentRegistry,
  composeCapabilitiesForRun,
  loadSupervisorRuntime,
  getAgentRolesText,
  getRegisteredAgentsText,
  createJob,
  parseStructuredFromResource,
  sortResourcesByCreatedAt,
  listActiveResourcesByKind,
  listLatestResourceByKind,
  parseNodeCreatedAtMs,
  nodeTypeKey,
  nodeResourceKind,
  messageRoleOf,
  summarizeActiveTypeBreakdown,
  refreshSharedContext,
  refreshSharedContextForRuntime,
  normalizeToolSpec,
  normalizeCatalogIds,
  summarizeSelectionState,
  pickBaselineConversationCatalogAgents,
  buildAgentProfileFromProposal,
  buildGocAgentCreateSpec,
  filterPublicBlueprintCandidates,
  resolveInstallCandidateFromSession,
  findLatestAgentProfileNodeForPublish,
  openAgentsUiInfo,
  createAgentDraftProposal,
  findLatestDraftByAgentId,
  findDraftByNodeId,
  appendParticipantToJobConfig,
  recordMembershipMutationDiagnostic,
  resolveMembershipTargetForThread,
  updateJobConfigSelection,
};
