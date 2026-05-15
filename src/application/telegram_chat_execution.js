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
  deriveKnowledgeBaseMemorySurfaceSpec,
  buildGocMemoryNodePayload,
  ensureKnowledgeBaseMemorySurfacesInGoc as ensureKnowledgeBaseMemorySurfacesInGocShared,
} from "./goc_memory_sync.js";
import { isScopedContextMode, normalizeContextRuntimeMode } from "../domain/context_runtime.js";
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
import { formatByteSize } from "../adapters/telegram/uploads.js";
import { toolInputPreviewFromAction, outputPreviewFromResult } from "../adapters/telegram/tool_preview.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./job_runtime.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { createRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { interpretTask } from "../control_plane/task_interpreter.js";
import { repairRoutePlanForTeamExecution } from "./team_route_repair.js";
import { buildExecutionInsightSnapshot } from "./team_execution_insights.js";
import { recordExecutionFeedback } from "./execution_feedback.js";
import { recordTeamMotifFeedback } from "./team_motif_feedback.js";
import { recordChannelExperimentVerification } from "./channel_experiment_verifier.js";
import { recordChannelPromotion } from "./channel_promotion_manager.js";
import { recordAdaptiveExecutionOutcome } from "./execution_mode_adaptation.js";
import { buildExecutionQualitySignals } from './execution_quality_signals.js';
import { installWorkflowExecutionContract } from './workflow_execution_contract.js';
import {
  ensureWatchTaskContract,
  startWatchIteration,
  completeWatchIteration,
  summarizeWatchTaskState,
} from './watch_task_store.js';
import { formatActiveArtifactContext, recordArtifactObservationFromAgentOutput } from "./artifact_context.js";
import { hasProviderFileToolLimitation, materializeArtifactsFromLlmOutput } from "./llm_output_artifact_materializer.js";
import { formatActiveUserFactContext, recordUserFactEvents } from "./user_fact_context.js";
import { buildScopedPromptAssembly, hydrateRuntimeScopesViaGoC, resolveScopeExecutionState } from "./goc_scope_runtime.js";
import { markActionsSkipped, wasInterruptedByReplan } from "./run_status_cleanup.js";
import {
  applyRunAuthority,
  buildRunAuthority,
  buildRunAuthorityPatch,
  createAuthorityDeniedError,
  evaluateActionAuthority,
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
import { applyPendingTeam, applyTeamConfigurationToRuntime, buildAutoRefineDraftFromStructureConflict, buildStarterSingleAgentTeamConfiguration, formatTeamProposalMessage, getSessionTeamState, hydrateSessionTeamStateFromConversationStore, storePendingTeam, syncTeamConfigurationToConversationStore, validateTeamConfiguration } from "./team_configuration.js";
import { bootstrapTelegramRuntimeSession } from './telegram_runtime_session.js';
import { resolveRuntimePolicyForRuntime } from './runtime_behavior_resolver.js';
import { setRuntimeCurrentTurn } from './runtime_session_state.js';
import { appendRecentAgentTurn, planAgentFollowupShortcut } from "./agent_followup_shortcuts.js";
import { appendFoldedContributionDigest, collectFoldedParticipantSignals, recordFoldedParticipantSignals } from './participant_reply_integration.js';
import { buildAnswerCapsules } from "./answer_capsules.js";
import { detectCapabilityGapsFromExecution } from "./capability_gap_detector.js";
import { archivePendingInstallProposal, buildInstallProposalPrompt, buildInstallProposalStateFromExecution, clearPendingInstallProposal, getPendingInstallProposal, resolveAutomaticInstallProposalAction, setPendingInstallProposal } from './install_proposal_state.js';
import { resolveCredentialEnvForChat } from './credential_binding.js';
import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from './tool_install_adapter.js';
import { buildAgentLocalInteractionContract } from "../domain/interaction_spec.js";
import { buildAgencyRoleOverlayPromptBlock, resolveAgencyRoleOverlay } from "../domain/agency_role_overlays.js";
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
import { ReplyAnchorStore } from "../runtime_capabilities/reply_anchor_store.js";
import { routeWithSupervisor } from "../chat/supervisor_router.js";
import { executeSupervisorActions, isMutatingAction } from "../chat/executor.js";
import {
  collectActiveRouteSignals,
  evaluateIncomingConditions,
  resolveActionRouteSignals,
  summarizeConditions,
} from "../chat/structural_runtime.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  formatChatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { normalizeActionPlan } from "../chat/actions.js";
import { expandDetailContext } from "../chat/unfold.js";
import { ChatRunManager } from "../chat/run_manager.js";
import { GocExecutionGraphRecorder } from "../chat/goc_execution_graph.js";
import { mergePreferredRuntimeTeamSnapshot, sanitizeExecutablePlan } from "../chat/route_execution_contract.js";
import { updateAgentStatus } from "./agent_status_store.js";
import { detectPatternConflict, applyTemporaryExecutionOverrideToRuntimeSnapshot, buildPatternRecoveryState, inferCompatibilityFallbackState, summarizePatternConflictLines } from "./pattern_conflict_detector.js";
import { buildAgentKnowledgeBaseGuidance, buildRoleMemoryContract, summarizeRoleMemoryEnforcement, canRolePublishSurface } from "../knowledge_base/runtime.js";
import { executeToolProxyAction } from "./tool_proxy_runtime.js";
import { writeGeminiMemoryFile, writeCodexInstructionFile } from "./cli_workspace_contract.js";
import {
  applyRuntimeRulePolicy,
  detectUnmetExecutionRequirements,
  extractExecutionRequirements,
  formatExecutionRequirementsBlock,
  mergeExecutionRequirements,
  resolveExecutionRequirementsForRuntime,
} from "./execution_requirements.js";
import { normalizeRuntimeExecutionPolicy } from "./runtime_execution_policy.js";
import { resolveProviderRuntimeOptions } from "./provider_runtime_policy.js";
import { summarizeProviderInteractionCapabilities } from "./provider_interaction_capabilities.js";
import { summarizeRuntimeCheckpointRef, writeRuntimeCheckpointBundle } from "./runtime_checkpointing.js";
import { appendPromptTelemetry, estimateTextTokens as estimatePromptTelemetryTokens } from "./prompt_telemetry.js";
import { readIterationDelta, readRoleSummary, updateRoleSummary } from "./summary_memory.js";
import { getAgentMemoryGrant, loadMemoryTopology } from "./memory_topology.js";
import { scoreTaskAutonomy, inferTypedMemoryNeeds } from "./autonomy_policy.js";
import { buildLocalizedSurfaceLabels, internalLanguagePolicyBlock, resolveUserSurfaceLocale, userSurfaceLanguageDirective } from "./language_policy.js";

import * as runtimeState from "./telegram_runtime_state.js";
import * as runtimeIo from "./telegram_runtime_io.js";
import * as routePlanning from "./telegram_route_planning.js";
import * as gocRuntime from "./telegram_goc_runtime.js";
import * as runtimeUi from "./telegram_runtime_ui.js";
import * as runtimeUiHelpers from "./telegram_status_notifications.js";
import { runAgentProviderExecution } from "./telegram_provider_execution.js";
import { appendAgentActivityEvent, appendAgentHandoffEvent, appendExecutionPolicyResolution } from "./agent_activity_stream.js";
import { compileAgentContextProjection, attachCompiledProjectionToPreparedContext } from "./context_projection_compiler.js";
import { extractContextWriteIntentsFromAgentResult } from "./context_write_intent_extractor.js";
import { commitContextWriteIntentsBatch } from "./context_write_batcher.js";
import { buildHandoffDeltaFromAgentResult, appendHandoffDelta } from "./handoff_delta_store.js";
import { createGocTrackingIo } from "./telegram_goc_tracking_io.js";

function normalizeForceMode(raw) {
  return normalizeForceModeDomain(raw);
}

function uniqueLowerList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function buildTelegramAgentIndex({ runtime = null, routePlan = null, actions = [], extraSources = [] } = {}) {
  return buildAgentDisplayIndexShared(
    agentRegistry,
    runtime,
    runtime?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || null,
    routePlan,
    routePlan?.team_plan,
    { actions },
    ...(Array.isArray(extraSources) ? extraSources : []),
  );
}

function resolveRuntimeExecutionPolicyForRuntime(runtime = null) {
  const source = runtime && typeof runtime === 'object'
    ? (runtime.runtime_execution || runtime.runtimeExecution || runtime.runtime_execution_policy || runtime.runtimeExecutionPolicy || runtime.execution_policy || runtime.executionPolicy || runtime)
    : {};
  return normalizeRuntimeExecutionPolicy(source);
}

function installWorkflowContractFromRoute(runtime = null, route = null, { jobId = '', source = 'route' } = {}) {
  if (!runtime || typeof runtime !== 'object') return { changed: false };
  const routeObj = route && typeof route === 'object' ? route : {};
  const contract = routeObj.team_workflow_contract
    || routeObj.teamWorkflowContract
    || routeObj.planner_metadata?.team_workflow_contract
    || routeObj.plannerMetadata?.teamWorkflowContract
    || routeObj.task_interpretation?.team_workflow_contract
    || routeObj.taskInterpretation?.teamWorkflowContract
    || null;
  const installed = installWorkflowExecutionContract(runtime, contract, { source });
  if (installed.changed) {
    try {
      tracking.append(jobId, 'decisions', [
        '## Workflow execution contract installed',
        `- workflow_kind: ${contract.workflow_kind || contract.workflowKind || 'workflow'}`,
        `- continuous_improvement: ${installed.runtime_execution_patch?.continuous_improvement?.enabled ? 'enabled' : 'disabled'}`,
        `- mode: ${installed.runtime_execution_patch?.continuous_improvement?.mode || ''}`,
        `- min_turns: ${installed.runtime_execution_patch?.continuous_improvement?.min_turns || ''}`,
        `- max_turns: ${installed.runtime_execution_patch?.continuous_improvement?.max_turns || ''}`,
      ].filter(Boolean).join('\n'), { source: 'workflow_contract', purpose: 'audit', eventType: 'workflow_contract_install', semanticKind: 'decisions' });
    } catch {}
  }
  return installed;
}

function safeLoadTrackingProfile(jobId = '') {
  try {
    return tracking.loadProfile(jobId);
  } catch {
    return null;
  }
}

function safeRunDir(jobId = '') {
  try {
    return runDir(jobId);
  } catch {
    return '';
  }
}

function safeRunSharedDir(jobId = '') {
  try {
    return runSharedDir(jobId);
  } catch {
    return '';
  }
}

function safeRunWorkspaceDir(jobId = '') {
  try {
    return runWorkspaceDir(jobId);
  } catch {
    return '';
  }
}

function sendLong(bot, chatId, text, options = undefined) {
  return runtimeUiHelpers.sendLong(bot, chatId, text, options);
}

function buildAgentChatUpdateText({ agentId = "", output = "" } = {}) {
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  const displayName = formatChatAgentDisplayName(cleanAgentId, buildTelegramAgentIndex({}))
    || cleanAgentId
    || "agent";
  const preview = clip(String(output || "").trim(), 3500);
  return [
    `🤖 ${displayName} 완료`,
    preview,
  ].filter(Boolean).join("\n");
}

function buildRoleAwareContextContract(jobId, { provider = '', roleId = '', maxReadDocs = 4 } = {}) {
  const profile = safeLoadTrackingProfile(jobId);
  if (!profile) return null;
  return buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs });
}

function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500, options = {}) {
  return runtimeIo.loadContextDocs(jobId, docNames, maxCharsPerDoc, options);
}

function buildWorkspaceFilesPromptSection(jobId, options = {}) {
  return runtimeIo.buildWorkspaceFilesPromptSection(jobId, options);
}

function ensureCommandOk(name, result) {
  return runtimeIo.ensureCommandOk(name, result);
}

function maybeSendArtifactSummary(bot, chatId, jobId, options = {}) {
  return runtimeIo.maybeSendArtifactSummary(bot, chatId, jobId, options);
}

function buildAgentOutputContractBlock({ roleId = '', runtimeExecutionPolicy = null } = {}) {
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy || {});
  const lines = [
    'OUTPUT CONTRACT',
    `- role_id: ${String(roleId || '').trim().toLowerCase() || '(unspecified)'}`,
    `- checkpointing: ${policy.checkpointing?.enabled === false ? 'disabled' : 'enabled'}`,
    `- continuous_improvement: ${policy.continuous_improvement?.enabled ? `enabled(mode=${policy.continuous_improvement.mode || 'bounded'}, min_turns=${policy.continuous_improvement.min_turns || 1}, max_turns=${policy.continuous_improvement.max_turns || 1})` : 'disabled'}`,
    policy.workflow_contract?.workflow_kind ? `- workflow_contract: ${policy.workflow_contract.workflow_kind}; required_passes=${(policy.workflow_contract.required_passes || []).join('→') || '(unspecified)'}` : '',
    '- respond with concrete artifacts, verification notes, and next-step risks when relevant',
  ];
  return lines.join('\n');
}

function getCurrentTurnReplyMessageId(chatId) {
  if (routePlanning && typeof routePlanning.getCurrentTurnReplyMessageId === 'function') {
    return routePlanning.getCurrentTurnReplyMessageId(chatId);
  }
  return null;
}


function withAgentOutputContract(action = {}, { runtimeExecutionPolicy = null } = {}) {
  const normalizedAction = action && typeof action === 'object' ? { ...action } : {};
  const inputs = normalizedAction.inputs && typeof normalizedAction.inputs === 'object' ? { ...normalizedAction.inputs } : {};
  const inferredRoleId = String(inputs.role_id || inputs.roleId || normalizedAction.role_id || normalizedAction.roleId || '').trim().toLowerCase();
  const outputContract = buildAgentOutputContractBlock({
    roleId: inferredRoleId,
    runtimeExecutionPolicy: normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy || {}),
  });
  if (outputContract && !String(inputs.output_contract || inputs.outputContract || '').trim()) {
    inputs.output_contract = outputContract;
  }
  normalizedAction.inputs = inputs;
  return normalizedAction;
}

function resolveProviderRuntimeOptionsForJob({ runtime = null, provider = '', action = null, agent = null, jobId = '' } = {}) {
  const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
  const actionInputs = action?.inputs && typeof action.inputs === 'object' ? action.inputs : {};
  return resolveProviderRuntimeOptions({
    runtimeExecutionPolicy,
    provider,
    workspaceRoot: safeRunWorkspaceDir(jobId),
    agent,
    action,
  });
}

function normalizeActionShape(raw = {}) {
  if (routePlanning && typeof routePlanning.normalizeActionShape === 'function') {
    return routePlanning.normalizeActionShape(raw);
  }
  return raw && typeof raw === 'object' ? raw : null;
}

function enforceAgentPublishContract(jobId, { runtime = null, agentId = '', agent = null, provider = '', roleId = '', displayLabel = '', finalSynthesis = false, requestedSurface = '' } = {}) {
  const profile = safeLoadTrackingProfile(jobId);
  const runtimeAgent = findAgentConfigInRuntime(agentId, runtime) || agent || {};
  const declaredPublishTargets = uniqueLowerList([
    ...(runtimeAgent?.memory_contract?.publish_surface_ids || runtimeAgent?.memoryContract?.publishSurfaceIds || []),
    ...(runtimeAgent?.context_policy?.writes?.publish_targets || runtimeAgent?.contextPolicy?.writes?.publish_targets || runtimeAgent?.contextPolicy?.writes?.publishTargets || []),
  ]);
  const enforcement = summarizeRoleMemoryEnforcement({ profile, provider, roleId });
  const targetSurface = String(requestedSurface || '').trim().toLowerCase();
  const finalRequested = finalSynthesis === true || targetSurface === 'final_answer';
  const roleCanPublishTarget = targetSurface
    ? canRolePublishSurface({ profile, provider, roleId, surfaceId: targetSurface })
    : false;
  const roleCanPublishFinal = canRolePublishSurface({ profile, provider, roleId, surfaceId: 'final_answer' });
  const declaredFinalPublisher = declaredPublishTargets.includes('final_answer');
  let allowed = true;
  let summary = 'allowed';

  if (finalRequested && !(roleCanPublishFinal || declaredFinalPublisher)) {
    allowed = false;
    summary = 'publish contract blocked: final synthesis는 final_answer surface가 선언된 agent만 수행할 수 있습니다';
  } else if (targetSurface && !(roleCanPublishTarget || declaredPublishTargets.includes(targetSurface))) {
    allowed = false;
    summary = `publish contract blocked: ${displayLabel || agentId || roleId || 'agent'} cannot publish to ${targetSurface}`;
  }

  return {
    allowed,
    summary,
    contract: {
      ...enforcement,
      publish_targets: declaredPublishTargets,
      final_owner_required: finalRequested,
      final_owner_label: declaredFinalPublisher ? (displayLabel || agentId || roleId || '') : '',
    },
  };
}

async function maybeBuildStructureConflictRefineDraft({ sessionStore, chatId, teamConfig, instruction, runtime }) {
  const currentState = typeof getSessionTeamState === 'function' ? getSessionTeamState(sessionStore, chatId) : {};
  try {
    const draft = await buildAutoRefineDraftFromStructureConflict({
      team: teamConfig,
      instruction,
      runtime,
    });
    if (!draft || typeof draft !== 'object') return { draft: null, stored: false };
    const hasExistingPending = !!(currentState?.pending_team && typeof currentState.pending_team === 'object');
    if (!hasExistingPending && typeof storePendingTeam === 'function') storePendingTeam(sessionStore, chatId, draft);
    return { draft, stored: !hasExistingPending };
  } catch (error) {
    return { draft: null, stored: false, error: String(error?.message || error) };
  }
}

const {
  FENCE,
  CHAT_VERBOSE,
  MAX_PARALLEL_PER_RUN,
  AUTOPILOT_ENABLED,
  AUTOPILOT_MAX_TURNS,
  AUTOPILOT_MAX_TOTAL_ACTIONS,
  TRACK_DOC_NAMES,
  jobs,
  tracking,
  approvals,
  memory,
  chatSessionStore,
  agentRegistry,
  gocFallbackByJob,
  jobAbortControllers,
  activeJobByChat,
  runDir,
  runSharedDir,
  runWorkspaceDir,
  resolveCurrentJobIdForChat,
  rememberLastChatJob,
  resolveAgentId,
  findAgentConfig,
  findAgentConfigInRuntime,
  memoryModeWithFallback,
  requireGocClient,
  bindGocActor,
  isCancelledError,
  resetJobAbortController,
  requestChatInterrupt,
  enqueue,
} = runtimeState;

const replyAnchorStore = new ReplyAnchorStore({ sessionStore: chatSessionStore });

const {
  appendChatMessageToGoc,
  buildContextInfo,
  invalidateRoleScopedContextCache,
  sendContextInfo,
} = runtimeIo;

const {
  buildGocAgentCreateSpec,
  composeCapabilitiesForRun,
  createAgentDraftProposal,
  createJob,
  filterPublicBlueprintCandidates,
  findLatestAgentProfileNodeForPublish,
  loadSupervisorRuntime,
  messageRoleOf,
  nodeResourceKind,
  nodeTypeKey,
  normalizeCatalogIds,
  parseNodeCreatedAtMs,
  recordMembershipMutationDiagnostic,
  refreshAgentRegistry,
  resolveInstallCandidateFromSession,
  summarizeActiveTypeBreakdown,
  summarizeSelectionState,
  updateJobConfigSelection,
} = gocRuntime;

const {
  buildApprovalActionSummaryLines,
  buildAutopilotFollowupMessage,
  buildAutopilotProgressSummary,
  buildPendingApprovalPrompt,
  buildPlanPreviewLines,
  buildQueuedAgentStatusFromActions,
  buildRoutedDashboardText,
  chatActionLabel,
  collectSuggestedActionsFromOutputs,
  formatActionAgentLabel,
  formatRegistryLines,
  getActionGoal,
  inferApprovalPreviewReason,
  mergeSuggestedActions,
  normalizeDeliverableList,
  parseAutoSuggestDecision,
  parseJsonObjectFromText,
  parseRouterPlan,
  recommendTeamForTask,
  rewritePlanToReuseAgents,
  sanitizeSupervisorRoutePlan,
  sendAgentStatusTransitionMessage,
  sendChatGPTPrompt,
  sendPlanPreviewMessage,
  sendRouterAckMessage,
  updateCompletedDeliverablesFromOutputs,
} = routePlanning;

const {
  buildChatStatusCard,
} = runtimeUi;

const {
  summarizeUserSafeGocFallbackReason,
} = runtimeUiHelpers;

function buildRuntimeAgentMetadataIndex(runtime = null) {
  const index = new Map();
  const pushAgent = (agent = {}) => {
    if (!agent || typeof agent !== "object") return;
    const agentId = String(agent.agent_id || agent.agentId || agent.id || agent.name || "").trim().toLowerCase();
    if (!agentId) return;
    const current = index.get(agentId) || {};
    index.set(agentId, {
      ...current,
      id: agentId,
      name: String(agent.name || current.name || agentId).trim(),
      role: String(agent.role_id || agent.roleId || agent.role || current.role || "").trim().toLowerCase(),
      provider: String(agent.provider || current.provider || "").trim().toLowerCase(),
      model: String(agent.model || current.model || "").trim(),
      skills: Array.isArray(agent.skills) ? agent.skills : (Array.isArray(agent.attached_skill_ids) ? agent.attached_skill_ids : (Array.isArray(agent.attachedSkillIds) ? agent.attachedSkillIds : (Array.isArray(agent.skill_ids) ? agent.skill_ids : (Array.isArray(current.skills) ? current.skills : [])))),
      purpose: String(agent.slot_purpose || agent.slotPurpose || agent.purpose || current.purpose || "").trim(),
      agency_overlay: agent.agency_role_overlay || agent.agencyRoleOverlay || current.agency_overlay || undefined,
      agency_overlay_id: String(agent.agency_role_overlay_id || agent.agencyRoleOverlayId || current.agency_overlay_id || "").trim() || undefined,
    });
  };
  const collect = (source = null) => {
    if (!source || typeof source !== "object") return;
    const arrays = [
      source.agents,
      source.members,
      source.runtime_team_snapshot?.agents,
      source.runtimeTeamSnapshot?.agents,
      source.runtime_team?.agents,
      source.runtimeTeam?.agents,
      source.team_config?.agents,
      source.teamConfig?.agents,
      source.active_team?.agents,
      source.activeTeam?.agents,
      source.pending_team?.agents,
      source.pendingTeam?.agents,
      source.team_plan?.agents,
      source.teamPlan?.agents,
      source.job_config?.team?.agents,
      source.jobConfig?.team?.agents,
    ];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const agent of arr) pushAgent(agent);
    }
  };
  collect(runtime);
  return index;
}

function continuousStopSignalsMatched(activeSignals = [], policy = {}) {
  const configured = uniqueLowerList(policy?.stop_signals || policy?.stopSignals || []);
  const signals = uniqueLowerList(activeSignals);
  if (signals.length === 0) return [];
  if (configured.length === 0) return signals;
  return signals.filter((signal) => configured.includes(signal));
}

function buildTurnDeltaFingerprint(outputs = []) {
  const rows = [];
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (!output || typeof output !== "object") continue;
    rows.push(JSON.stringify({
      type: String(output.type || "").trim().toLowerCase(),
      role: String(output.role || output.role_id || output.roleId || "").trim().toLowerCase(),
      summary: String(output.summary || "").trim(),
      text: String(output.text || output.raw_text || output.rawText || "").trim().slice(0, 1000),
      path: String(output.rel || output.path || output.uri || "").trim(),
    }));
  }
  return rows.join("\n");
}

function chatModelBadgeEnabled() {
  const raw = String(process.env.CHAT_SHOW_MODEL_BADGE ?? process.env.CHAT_RESPONSE_MODEL_BADGE ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'hide', 'hidden'].includes(raw);
}

function compactProviderModelLabel(provider = '', model = '') {
  const cleanProvider = String(provider || '').trim().toLowerCase();
  const cleanModel = String(model || '').trim();
  if (!cleanProvider && !cleanModel) return '';
  if (!cleanProvider) return cleanModel;
  if (!cleanModel || cleanModel.toLowerCase() === cleanProvider) return cleanProvider;
  return `${cleanProvider}/${cleanModel}`;
}

function firstAgentModelLabel(outputs = []) {
  for (const row of Array.isArray(outputs) ? outputs : []) {
    if (!row || typeof row !== 'object') continue;
    if (String(row.agentId || '').trim().toLowerCase() === 'system') continue;
    const label = compactProviderModelLabel(row.provider, row.model);
    if (label) return label;
  }
  return '';
}

function appendResponseModelBadge(replyText = '', { routePlan = null, execution = null } = {}) {
  const text = String(replyText || '').trim();
  if (!text || !chatModelBadgeEnabled()) return text;
  if (/↳\s*(?:model|모델|응답)\s*:/i.test(text)) return text;
  const finalLabel = compactProviderModelLabel(
    execution?._response_model_badge?.final?.provider || '',
    execution?._response_model_badge?.final?.model || '',
  );
  const agentLabel = firstAgentModelLabel(execution?.outputs || []);
  const routerLabel = compactProviderModelLabel(routePlan?.router_provider || '', routePlan?.router_model || '');
  const parts = [];
  if (finalLabel) parts.push(`answer ${finalLabel}`);
  if (agentLabel && agentLabel !== finalLabel) parts.push(`agent ${agentLabel}`);
  if (routerLabel && routerLabel !== finalLabel && routerLabel !== agentLabel) parts.push(`router ${routerLabel}`);
  if (parts.length === 0) return text;
  const maxParts = Math.max(1, Math.min(3, Number(process.env.CHAT_MODEL_BADGE_MAX_PARTS || 3) || 3));
  return `${text}\n\n↳ model: ${parts.slice(0, maxParts).join(' · ')}`;
}

function deriveGocMemorySurfaceSpec(doc = {}) {
  return deriveKnowledgeBaseMemorySurfaceSpec(doc);
}

function formatGocProjectionContext(projectionResult = {}, { maxChars = 9000 } = {}) {
  return runtimeIo.formatRoleScopedProjectionContext(projectionResult, { maxChars });
}

async function ensureKnowledgeBaseMemorySurfacesInGoc(jobId, { client = null, threadId = '' } = {}) {
  const profile = tracking.loadProfile(jobId);
  const docs = Array.isArray(profile?.docs) ? profile.docs : [];
  return ensureKnowledgeBaseMemorySurfacesInGocShared({
    jobId,
    client,
    threadId,
    docs,
    deriveSpec: deriveGocMemorySurfaceSpec,
  });
}

const gocTrackingIo = createGocTrackingIo({
  clip,
  jobs,
  tracking,
  runDir,
  memoryModeWithFallback,
  requireGocClient,
  ensureJobThread,
  ensureKnowledgeBaseMemorySurfacesInGoc,
  buildGocMemoryNodePayload,
  invalidateRoleScopedContextCache: runtimeIo.invalidateRoleScopedContextCache,
});

const {
  deriveGocMemoryNodePayload,
  syncRoleAwareMemoryWriteToGoc,
  recordBlockedMemoryWriteAudit,
  appendRoleAwareTracking,
  appendRoleAwareTrackingWithStatus,
} = gocTrackingIo;

function ensureCliWorkspaceSupportFiles(jobId, { provider = "", roleMemo = "", kbContract = "", goal = "", instruction = "", runtimeExecutionPolicy = {}, providerOptions = {}, allowDirectExecution = false } = {}) {
  let workspacePath = "";
  try {
    workspacePath = runWorkspaceDir(jobId);
  } catch {
    return {};
  }
  if (provider === "gemini") {
    return {
      geminiMemoryFile: writeGeminiMemoryFile({
        workspaceRoot: workspacePath,
        roleMemo,
        kbContract,
        goal,
        runtimeExecutionPolicy,
        providerOptions,
        allowDirectExecution,
      }),
    };
  }
  if (provider === "codex") {
    return {
      codexInstructionFile: writeCodexInstructionFile({
        workspaceRoot: workspacePath,
        roleMemo,
        kbContract,
        instruction,
        goal,
        runtimeExecutionPolicy,
        providerOptions,
      }),
    };
  }
  return {};
}

async function runToolProxyStep({ action = {}, jobId = "", signal = null, runtime = null, chatId = '' } = {}) {
  return await executeToolProxyAction({
    action,
    jobId,
    workspaceRoot: runWorkspaceDir(jobId),
    sharedDir: runSharedDir(jobId),
    tracking,
    signal,
    runtimeExecutionPolicy: resolveRuntimeExecutionPolicyForRuntime(runtime),
    harnessRuntimePolicy: runtime?.harnessRuntimePolicy || runtime?.openharnessInstallState?.runtime_policy || null,
    env: resolveCredentialEnvForChat(chatSessionStore, chatId),
  });
}

function decoratePlanActionsWithAgentMetadata(actions = [], runtime = null) {
  const metadataIndex = buildRuntimeAgentMetadataIndex(runtime);
  const decorateOne = (action = {}) => {
    if (!action || typeof action !== 'object') return action;
    const type = String(action.type || '').trim().toLowerCase();
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      return {
        ...action,
        agents: (Array.isArray(action.agents) ? action.agents : []).map((child) => decorateOne(child)),
      };
    }
    if (!['run_agent', 'agent_run', 'synthesize_final'].includes(type)) return action;
    const agentId = String(action.agent_id || action.agentId || action.agent || '').trim().toLowerCase();
    const meta = metadataIndex.get(agentId) || null;
    const inputs = action.inputs && typeof action.inputs === 'object' ? action.inputs : {};
    const mergedInputs = {
      ...inputs,
      display_label: String(inputs.display_label || inputs.displayLabel || action.display_label || action.displayLabel || meta?.name || '').trim() || undefined,
      agent_name: String(inputs.agent_name || inputs.agentName || meta?.name || '').trim() || undefined,
      role_id: String(inputs.role_id || inputs.roleId || meta?.role || '').trim().toLowerCase() || undefined,
      provider: String(inputs.provider || meta?.provider || '').trim().toLowerCase() || undefined,
      model: String(inputs.model || meta?.model || '').trim() || undefined,
      attached_skill_ids: (Array.isArray(inputs.attached_skill_ids) ? inputs.attached_skill_ids : (Array.isArray(inputs.attachedSkillIds) ? inputs.attachedSkillIds : (Array.isArray(meta?.skills) ? meta.skills : []))),
      slot_purpose: String(inputs.slot_purpose || inputs.slotPurpose || meta?.purpose || '').trim() || undefined,
      agency_role_overlay: inputs.agency_role_overlay || inputs.agencyRoleOverlay || meta?.agency_overlay || undefined,
      agency_role_overlay_id: String(inputs.agency_role_overlay_id || inputs.agencyRoleOverlayId || meta?.agency_overlay_id || '').trim() || undefined,
    };
    return {
      ...action,
      display_label: String(action.display_label || action.displayLabel || meta?.name || '').trim() || undefined,
      inputs: mergedInputs,
    };
  };
  return (Array.isArray(actions) ? actions : []).map((action) => decorateOne(action));
}

function buildAgentKnowledgeBaseBlock(jobId, { provider = "", roleId = "", agentId = "", detailLevel = "compact" } = {}) {
  try {
    const profile = safeLoadTrackingProfile(jobId);
    if (!profile) return "";
    const memoryTopology = loadMemoryTopology({ jobDir: safeRunDir(jobId) });
    const memoryGrant = memoryTopology
      ? getAgentMemoryGrant(memoryTopology, { agentId, roleId, provider })
      : null;
    return buildAgentKnowledgeBaseGuidance({
      profile,
      sharedDir: safeRunSharedDir(jobId),
      provider,
      roleId,
      agentId,
      detailLevel,
      memoryTopology,
      memoryGrant,
    });
  } catch {
    return "";
  }
}

function escapePromptRegex(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBracketSection(text = '', label = '', { maxChars = 600, tailLines = 0 } = {}) {
  const cleanLabel = String(label || '').trim();
  const cleanTextValue = String(text || '');
  if (!cleanLabel || !cleanTextValue) return '';
  const re = new RegExp(`\\[${escapePromptRegex(cleanLabel)}\\]\\n([\\s\\S]*?)(?=\\n\\[[A-Z][A-Z_ ]*\\]\\n|$)`, 'i');
  const match = cleanTextValue.match(re);
  if (!match) return '';
  let body = String(match[1] || '').trim();
  if (!body) return '';
  if (Number.isFinite(Number(tailLines)) && Number(tailLines) > 0) {
    const rows = body.split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean);
    body = rows.slice(Math.max(0, rows.length - Math.max(1, Math.floor(Number(tailLines))))).join('\n');
  }
  body = clip(body, Math.max(120, Math.floor(Number(maxChars) || 600)));
  return body ? `[${cleanLabel}]\n${body}` : '';
}

function extractDirectiveBullets(text = '', { maxItems = 4, maxChars = 720 } = {}) {
  const src = String(text || '');
  if (!src) return '';
  const directiveRe = /(반드시|절대로|하지\s*마|하지마|아니라|대신|다른\s+모드|다르다|혼동하지\s*않도록|혼동하지\s*말|주의해|주의하|기억해|기억해둬|잊지\s*마|잊지마|must|never|do not|don't|instead|rather than|not\s+.*but)/i;
  const seen = new Set();
  const bullets = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const cleanLine = String(rawLine || '').trim();
    if (!cleanLine || !directiveRe.test(cleanLine)) continue;
    const normalized = cleanLine
      .replace(/^[-*]\s*/, '')
      .replace(/^(user|system|assistant|researcher|builder|reviewer|critic|synthesizer|operator)\s*:\s*/i, '')
      .trim();
    if (!normalized || normalized.length < 8) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(`- ${clip(normalized, 220)}`);
    if (bullets.length >= Math.max(1, Math.floor(Number(maxItems) || 4))) break;
  }
  return clip(bullets.join('\n'), Math.max(180, Math.floor(Number(maxChars) || 720)));
}

function compactTaskText(value = '', { maxChars = 2400 } = {}) {
  const text = String(value || '').trim();
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(600, Math.floor(Number(maxChars))) : 2400;
  if (!text || text.length <= limit) return text;

  const compactRequirements = extractExecutionRequirements(text);
  const preserveDeliveryRequirements = compactRequirements.artifact_delivery_forbidden !== true;
  const head = clip(text, Math.max(420, Math.floor(limit * 0.48)));
  const tail = clip(text.slice(Math.max(0, text.length - Math.max(180, Math.floor(limit * 0.12)))).trim(), Math.max(180, Math.floor(limit * 0.12)));
  const preserved = [
    extractBracketSection(text, 'CURRENT TASK PACKET', { maxChars: Math.max(360, Math.floor(limit * 0.28)) }),
    extractBracketSection(text, 'ACTIVE DIRECTIVES', { maxChars: Math.max(260, Math.floor(limit * 0.2)) }),
    extractBracketSection(text, 'PINNED FACTS', { maxChars: Math.max(260, Math.floor(limit * 0.2)) }),
    preserveDeliveryRequirements ? extractBracketSection(text, 'DELIVERY REQUIREMENTS', { maxChars: Math.max(240, Math.floor(limit * 0.18)) }) : '',
    extractBracketSection(text, 'JOB CONSTRAINTS', { maxChars: Math.max(220, Math.floor(limit * 0.16)) }),
    extractBracketSection(text, 'RECENT TURNS', { maxChars: Math.max(320, Math.floor(limit * 0.24)), tailLines: 6 }),
  ].filter(Boolean);
  const directiveBullets = extractDirectiveBullets(text, {
    maxItems: 4,
    maxChars: Math.max(200, Math.floor(limit * 0.2)),
  });
  if (directiveBullets) {
    const hasTaskPacket = preserved.some((block) => /^\[CURRENT TASK PACKET\]/i.test(String(block || '').trim()));
    const hasPinnedFacts = preserved.some((block) => /^\[PINNED FACTS\]/i.test(String(block || '').trim()));
    preserved.push(
      !hasTaskPacket
        ? `[LATEST USER QUOTES]\n${directiveBullets}`
        : (hasPinnedFacts ? `[LATEST USER DIRECTIVES]\n${directiveBullets}` : `[PINNED FACTS]\n${directiveBullets}`)
    );
  }

  const noteBlock = [
    '[truncated for prompt efficiency]',
    '- Full request and working details are preserved in the shared memory surfaces.',
    '- Use mission_brief / working_memory as the source of truth for the complete task context.',
    tail ? `- tail excerpt: ${tail}` : '',
  ].filter(Boolean).join('\n');

  const compacted = [
    head,
    preserved.length > 0 ? '[PRESERVED CRITICAL CONTEXT]' : '',
    preserved.join('\n\n'),
    noteBlock,
  ].filter(Boolean).join('\n\n');

  if (compacted.length <= limit) return compacted;
  const truncationMarker = '\n…(truncated)…';
  const hardLimit = Math.max(120, limit - truncationMarker.length);
  return `${compacted.slice(0, hardLimit)}${truncationMarker}`;
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function buildRoleAwareContextDocList(jobId, { provider = '', roleId = '', fallbackDocIds = ['plan', 'research'] } = {}) {
  try {
    const profile = tracking.loadProfile(jobId);
    if (!profile) return fallbackDocIds;
    const contract = buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs: 4 });
    const orderedDocs = [
      ...(Array.isArray(contract.primary_docs) ? contract.primary_docs : []),
      ...(Array.isArray(contract.read_docs) ? contract.read_docs : []),
    ];
    const seen = new Set();
    const docIds = [];
    for (const doc of orderedDocs) {
      const fileName = String(doc?.file_name || '').trim();
      const docId = String(doc?.doc_id || doc?.surface_id || '').trim();
      const candidates = [fileName, docId].filter(Boolean);
      for (const candidate of candidates) {
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        docIds.push(candidate);
        break;
      }
    }
    return docIds.length > 0 ? docIds : fallbackDocIds;
  } catch {
    return fallbackDocIds;
  }
}


function extractLatestUserRequestFromTaskText(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const patterns = [
    /Latest user request:\s*["“]([^"”\n]{1,500})["”]/i,
    /Baseline objective:\s*["“]([^"”\n]{1,500})["”]/i,
    /Goal:\s*([^\n]{1,500})/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    const candidate = String(match?.[1] || '').trim();
    if (candidate) return candidate;
  }
  const messageMatch = text.match(/\[Message [^\n\]]+\]\s*role=user\s*\n([\s\S]{1,700}?)(?=\n\n\[[A-Z][A-Z_ ]*\]|\n\[[A-Z][^\]]+\]|$)/i);
  const messageCandidate = String(messageMatch?.[1] || '').trim();
  if (messageCandidate) return messageCandidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n').slice(0, 500);
  const assignedMatch = text.match(/\[ASSIGNED TASK\]\s*\n([\s\S]{1,700}?)(?=\n\n\[[A-Z][A-Z_ ]*\]|$)/i);
  const assignedCandidate = String(assignedMatch?.[1] || '').trim();
  if (assignedCandidate && !/^\[KNOWLEDGE BASE CONTRACT\]/i.test(assignedCandidate)) {
    return assignedCandidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n').slice(0, 500);
  }
  return '';
}

function isStaleBuilderHandoffTaskContext(text = '') {
  const src = String(text || '');
  return /구현을\s*바로\s*진행|builder에게\s*handoff|핵심\s*요구사항|제품\s*흐름|외부\s*제약\/?리스크/i.test(src);
}

function buildDirectAnswerOutputGuide(rawGuide = '', { userLocale = 'ko' } = {}) {
  const explicit = String(rawGuide || '').trim();
  if (explicit) return explicit;
  const locale = resolveUserSurfaceLocale({ message: '', fallback: userLocale || 'ko' });
  const labels = buildLocalizedSurfaceLabels(locale);
  return [
    labels.outputGuide,
    '- Answer the latest user request directly.',
    '- If the user asks for a recommendation, question answer, or explanation, provide it directly instead of using a fixed implementation-risk template.',
    '- Do not expose internal KB, tracking file, route, provider, run_dir, or runtime metadata unless the user explicitly asks for diagnostics.',
    `- ${userSurfaceLanguageDirective(locale)}`,
  ].join('\\n');
}

function buildArtifactTurnPolicyBlock(requirements = {}, { hasArtifactContract = false, runtimeExecutionPolicy = null, roleId = '' } = {}) {
  const row = requirements && typeof requirements === 'object' ? requirements : {};
  if (hasArtifactContract) return '';
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy || {});
  const taskLoop = policy.execution_mode === 'task_loop' || policy.workflow_contract?.workflow_kind === 'bounded_continuous_loop';
  const strictMemoryOnly = row.artifact_delivery_forbidden || row.memory_only_requested;
  if (taskLoop && !strictMemoryOnly) {
    return [
      '[TASK OUTPUT POLICY]',
      '- Task-loop mode: workspace-internal code/file changes are allowed when needed for implementation, diagnosis, tests, or verification.',
      '- Artifact delivery/publish is allowed only when the task/build actually requires it; otherwise report changed paths and verification notes in chat.',
      '- Approval boundary still applies to deployment, credential/API binding, destructive writes, large irreversible changes, financial recommendation logic, and canonical memory switches.',
      roleId ? `- active_role: ${String(roleId || '').trim().toLowerCase()}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    '[TASK OUTPUT POLICY]',
    strictMemoryOnly
      ? '- Memory-only turn: do not create/update/send workspace artifacts; answer in chat and let runtime memory capture useful facts.'
      : '- No explicit file deliverable requested: answer in chat; do not create/update/send workspace artifacts.',
    '- Existing workspace files are context only unless the latest user explicitly asks to edit/send them.',
  ].join('\n');
}

function normalizeRuleSource(row = {}) {
  const source = String(row?.source || row?.origin || row?.scope || 'user').trim().toLowerCase();
  if (/learn|auto|runtime|system/.test(source)) return 'learned';
  return 'user';
}

function formatChatRuntimeRulesBlock(session = null, { maxRules = 6, maxChars = 700 } = {}) {
  const rules = Array.isArray(session?.runtime_rules) ? session.runtime_rules : [];
  const enabled = rules
    .filter((row) => row && row.enabled !== false && String(row.text || '').trim())
    .map((row) => ({ ...row, source_group: normalizeRuleSource(row) }))
    .sort((a, b) => (a.source_group === b.source_group ? 0 : (a.source_group === 'user' ? -1 : 1)))
    .slice(0, Math.max(1, Math.floor(Number(maxRules) || 6)))
    .map((row, index) => `${index + 1}. ${clip(String(row.text || '').trim(), 170)}`);
  if (enabled.length === 0) return '';
  return clip([
    '[CHAT RUNTIME GUIDANCE]',
    'Use these as chat-level operating preferences unless the latest user request clearly overrides them.',
    ...enabled,
  ].join('\n'), Math.max(240, Math.floor(Number(maxChars) || 700)));
}



async function geminiResearch(jobId, goal, signal = null, opts = {}) {
  const runtimeExecutionPolicy = normalizeRuntimeExecutionPolicy(opts.runtimeExecutionPolicy || {});
  const sectionTitle = String(opts.sectionTitle || "Gemini notes");
  const surfaceLocale = resolveUserSurfaceLocale({ message: opts.userRequest || opts.user_request || goal, runtime: opts.runtime || null, fallback: opts.userLocale || opts.user_locale || 'ko' });
  const outputGuide = buildDirectAnswerOutputGuide(opts.outputGuide || opts.output_guide || '', { userLocale: surfaceLocale });
  const concurrencyKey = String(opts.concurrencyKey || "").trim() || `job:${String(jobId || "").trim()}`;
  const preferredModel = String(opts.model || "").trim();
  const providedRoleMemo = String(opts.roleMemo || opts.role_memo || '').trim();
  const boundGeminiRoleMemo = memory.getAgentRole("gemini");
  const roleMemo = providedRoleMemo || boundGeminiRoleMemo;
  const roleKey = String(opts.roleId || 'researcher').trim().toLowerCase();
  const agentKey = String(opts.agentId || 'gemini').trim().toLowerCase() || 'gemini';
  const cleanUserRequest = String(opts.userRequest || opts.user_request || extractLatestUserRequestFromTaskText(goal) || '').trim();
  const rawGoal = String(goal || '').trim();
  const compactGoal = compactTaskText(rawGoal, { maxChars: 1400 });
  const taskContext = isStaleBuilderHandoffTaskContext(compactGoal)
    ? ''
    : (cleanUserRequest && compactGoal.includes(cleanUserRequest) && compactGoal.length <= cleanUserRequest.length + 80
      ? ''
      : compactGoal);
  const ctxMaxChars = clampInteger(process.env.CHAT_GEMINI_CONTEXT_DOC_MAX_CHARS, 900, { min: 0, max: 2600 });
  const ctx = ctxMaxChars > 0
    ? await runtimeIo.loadRoleScopedContextDocs(jobId, {
      provider: 'gemini',
      roleId: roleKey,
      fallbackDocIds: ['plan', 'research'],
      maxCharsPerDoc: ctxMaxChars,
      audienceLabel: 'agent run',
      runtimePolicy: opts.runtime?.harnessRuntimePolicy || opts.runtime?.openharnessInstallState?.runtime_policy || null,
    })
    : '';
  const workspacePath = runWorkspaceDir(jobId);
  const providerOptions = opts.providerOptions && typeof opts.providerOptions === 'object'
    ? opts.providerOptions
    : resolveProviderRuntimeOptions({
      runtimeExecutionPolicy,
      provider: "gemini",
      workspaceRoot: workspacePath,
    });
  const artifactOutputRequirements = resolveExecutionRequirementsForRuntime(
    applyRuntimeRulePolicy(mergeExecutionRequirements(
      extractExecutionRequirements(cleanUserRequest),
      extractExecutionRequirements(rawGoal),
    ), opts.chatRuntimeRules || opts.chat_runtime_rules || '', { runtimeExecutionPolicy }),
    { runtimeExecutionPolicy, roleId: roleKey, taskText: `${cleanUserRequest}\n${rawGoal}` },
  );
  const artifactPolicyBlock = buildArtifactTurnPolicyBlock(artifactOutputRequirements, { hasArtifactContract: artifactOutputRequirements.artifact_delivery_requested === true, runtimeExecutionPolicy, roleId: roleKey });
  appendExecutionPolicyResolution({
    jobDir: runDir(jobId),
    source: 'geminiResearch',
    agentId: agentKey,
    roleId: roleKey,
    runtimeExecutionPolicy,
    requirements: artifactOutputRequirements,
    decision: artifactOutputRequirements.task_loop_workspace_write_allowed ? 'task_loop_workspace_write_allowed' : (artifactOutputRequirements.artifact_delivery_forbidden ? 'artifact_forbidden' : 'chat_default'),
  });
  const includeArtifactContext = artifactOutputRequirements.artifact_delivery_requested === true;
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, {
    limitPerBucket: 3,
    includeWorkspaceArtifacts: includeArtifactContext,
    includeActiveArtifactContext: includeArtifactContext,
  });
  const activeArtifactContext = includeArtifactContext ? formatActiveArtifactContext(runDir(jobId), { maxChars: 1800, limit: 4 }) : '';
  const activeUserFactContext = formatActiveUserFactContext(runDir(jobId), { maxChars: 2200 });
  const artifactMaterializationGuide = artifactOutputRequirements.artifact_delivery_requested
    ? [
      "[FILE ARTIFACT OUTPUT CONTRACT]",
      "- When the user expects a file deliverable, produce each file through an explicit artifact block instead of relying on provider-specific write_file/write_todos tools.",
      "- Use this exact shape for each deliverable:",
      "  [ARTIFACT]",
      "  path: relative/path/to/file.ext",
      "  ```language",
      "  complete file contents",
      "  ```",
      "  [/ARTIFACT]",
      "- Choose natural filenames and relative paths from the user request and task context; do not write outside the workspace or into hidden runtime directories.",
      "- The runtime will materialize explicit artifact blocks into workspace files and publish the artifact index.",
      "- If direct provider file-writing is unavailable or denied, continue by emitting artifact blocks rather than failing the task.",
    ].join("\n")
    : "";
  const kbContract = buildAgentKnowledgeBaseBlock(jobId, {
    provider: "gemini",
    roleId: roleKey,
    agentId: agentKey,
    detailLevel: "minimal",
  });
  ensureCliWorkspaceSupportFiles(jobId, { provider: "gemini", roleMemo, kbContract, goal: cleanUserRequest || rawGoal, runtimeExecutionPolicy, providerOptions });
  const prompt = [
    internalLanguagePolicyBlock({ surfaceLocale }),
    'You are an agent invoked by Telegram /chat.',
    'The most important authority is [USER REQUEST]; if older memory/context conflicts with it, follow [USER REQUEST].',
    roleMemo ? `[ROLE]\n${clip(roleMemo, 900)}` : '',
    kbContract,
    activeArtifactContext ? activeArtifactContext : '',
    activeUserFactContext ? activeUserFactContext : '',
    ctx ? `[AVAILABLE MEMORY — optional]\n${ctx}` : '',
    workspaceFilesText ? `[WORKSPACE FILES — optional]\n${workspaceFilesText}` : '',
    artifactPolicyBlock,
    artifactMaterializationGuide,
    '',
    '[USER REQUEST]',
    cleanUserRequest || rawGoal,
    taskContext ? `[TASK CONTEXT]\n${taskContext}` : '',
    '',
    outputGuide,
    '',
    buildLocalizedSurfaceLabels(surfaceLocale).finalAnswer,
  ].filter(Boolean).join('\n\n');
  appendPromptTelemetry({
    jobDir: runDir(jobId),
    sharedDir: runSharedDir(jobId),
    row: {
      kind: 'provider_prompt',
      provider: 'gemini',
      model: preferredModel || '',
      agent_id: agentKey,
      role_id: roleKey,
      prompt_text: prompt,
      prepared_context_tokens: opts.preparedContextInfo?.compiled_tokens_estimate,
      prepared_context_chars: opts.preparedContextInfo?.compiled_chars,
      components: {
        user_request: cleanUserRequest || rawGoal,
        task_context: taskContext,
        active_artifact_context: activeArtifactContext,
        active_user_fact_context: activeUserFactContext,
        local_context: ctx,
        kb_contract: kbContract,
        workspace_files: workspaceFilesText,
        output_guide: outputGuide,
      },
      metadata: {
        concurrency_key: concurrencyKey,
        prompt_mode: 'direct_answer',
      },
    },
  });
  const agentTimeoutMs = clampInteger(process.env.CHAT_GEMINI_AGENT_TIMEOUT_MS, 90000, { min: 15000, max: 240000 });
  const r = await runGeminiPrompt({
    workspaceRoot: workspacePath,
    cwd: workspacePath,
    prompt,
    signal,
    model: preferredModel || "",
    concurrencyKey,
    jobId,
    onRetry: opts.onGeminiRetry,
    onModelSwitch: opts.onGeminiModelSwitch,
    onGiveUp: opts.onGeminiGiveUp,
    approvalMode: providerOptions.approvalMode,
    settingsOverwrite: providerOptions.settingsOverwrite,
    workspaceSettingsPatch: providerOptions.workspaceSettings,
    timeoutMs: Number(opts.timeoutMs || opts.timeout_ms || 0) > 0 ? Number(opts.timeoutMs || opts.timeout_ms) : agentTimeoutMs,
    extraEnv: {
      ...(providerOptions.extraEnv || {}),
      ...resolveCredentialEnvForChat(chatSessionStore, opts.chatId || ''),
    },
  });
  const effectiveGeminiResult = r;
  const out = (r.stdout || r.stderr || "");
  const materialization = artifactOutputRequirements.artifact_delivery_requested
    ? materializeArtifactsFromLlmOutput({
      output: out,
      workspaceRoot: workspacePath,
      userRequest: cleanUserRequest || rawGoal,
    })
    : { materialized: [] };
  if (materialization.materialized?.length) {
    try { runtimeIo.refreshArtifactIndex(jobId, { maxFiles: 12 }); } catch {}
  }
  try {
    recordArtifactObservationFromAgentOutput(runDir(jobId), out, { source: `gemini:${agentKey}` });
  } catch {}
  const researchPurpose = ['reviewer', 'critic'].includes(roleKey) ? 'review' : 'research';
  appendRoleAwareTracking(jobId, `## ${sectionTitle}\n\n${out}\n`, {
    provider: 'gemini',
    roleId: roleKey,
    purpose: researchPurpose,
    fallbackDoc: 'research',
    requestedDoc: researchPurpose === "review" ? "critic_log" : "research",
  });
  const materializedArtifacts = Array.isArray(materialization.materialized) ? materialization.materialized : [];
  const acceptedProviderFileLimitation = materializedArtifacts.length > 0 && !effectiveGeminiResult.ok && hasProviderFileToolLimitation(`${effectiveGeminiResult.stderr || ""}\n${effectiveGeminiResult.stdout || ""}`);
  const acceptedTimedPartial = materializedArtifacts.length > 0 && !effectiveGeminiResult.ok && /timeout/i.test(String(effectiveGeminiResult.error_type || effectiveGeminiResult.stderr || ""));
  const userFacingOut = materializedArtifacts.length > 0
    ? [
      '요청한 파일 산출물을 생성했습니다.',
      '',
      '생성된 파일:',
      ...materializedArtifacts.map((entry) => `- ${entry.path}`),
      '',
      effectiveGeminiResult.ok
        ? '검증: LLM이 생성한 파일 내용을 파싱해 workspace에 저장했습니다.'
        : '검증: provider-side 파일쓰기 제한 이후 LLM 출력물을 파싱해 workspace에 저장했습니다.',
    ].join('\n')
    : out;
  jobs.appendConversation(jobId, "gemini", userFacingOut, { kind: "research", provider: 'gemini', model: effectiveGeminiResult.used_model || preferredModel || 'gemini' });
  if (!acceptedProviderFileLimitation && !acceptedTimedPartial) ensureCommandOk("Gemini", effectiveGeminiResult);
  return {
    output: userFacingOut,
    provider: 'gemini',
    model: String(effectiveGeminiResult.used_model || preferredModel || 'gemini').trim() || 'gemini',
    llm_trace_id: effectiveGeminiResult.llm_trace_id || undefined,
  };
}

async function codexImplement(jobId, instruction, signal = null, opts = {}) {
  const runtimeExecutionPolicy = normalizeRuntimeExecutionPolicy(opts.runtimeExecutionPolicy || {});
  const providerOptions = opts.providerOptions && typeof opts.providerOptions === 'object'
    ? opts.providerOptions
    : resolveProviderRuntimeOptions({
      runtimeExecutionPolicy,
      provider: "codex",
      workspaceRoot: runWorkspaceDir(jobId),
    });
  const credentialEnv = resolveCredentialEnvForChat(chatSessionStore, opts.chatId || '');
  const roleMemo = memory.getAgentRole("codex");
  const ctx = await runtimeIo.loadRoleScopedContextDocs(jobId, { provider: 'codex', roleId: String(opts.roleId || 'builder').trim().toLowerCase(), fallbackDocIds: ['plan', 'progress', 'research'], maxCharsPerDoc: 3200, audienceLabel: 'agent run', runtimePolicy: opts.runtime?.harnessRuntimePolicy || opts.runtime?.openharnessInstallState?.runtime_policy || null });
  const workspacePath = runWorkspaceDir(jobId);
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, { limitPerBucket: 5 });
  const kbContract = buildAgentKnowledgeBaseBlock(jobId, { provider: "codex", roleId: String(opts.roleId || 'builder').trim().toLowerCase(), agentId: String(opts.agentId || 'codex').trim().toLowerCase() || 'codex', detailLevel: "compact" });
  const executionRequirements = resolveExecutionRequirementsForRuntime(
    mergeExecutionRequirements(extractExecutionRequirements(instruction), extractExecutionRequirements(opts.goal || '')),
    { runtimeExecutionPolicy, roleId: String(opts.roleId || 'builder').trim().toLowerCase(), taskText: `${instruction}\n${opts.goal || ''}` },
  );
  const allowDirectExecution = executionRequirements.direct_execution_requested || executionRequirements.shell_execution_requested || executionRequirements.artifact_build_requested || executionRequirements.task_loop_workspace_write_allowed === true || executionRequirements.workspace_write_requested === true;
  appendExecutionPolicyResolution({
    jobDir: runDir(jobId),
    source: 'codexImplement',
    agentId: String(opts.agentId || 'codex').trim().toLowerCase() || 'codex',
    roleId: String(opts.roleId || 'builder').trim().toLowerCase() || 'builder',
    runtimeExecutionPolicy,
    requirements: executionRequirements,
    decision: allowDirectExecution ? 'direct_workspace_execution_allowed' : 'verification_deferred',
  });
  const cliSupport = ensureCliWorkspaceSupportFiles(jobId, { provider: "codex", roleMemo, kbContract, instruction, goal: instruction, runtimeExecutionPolicy, providerOptions, allowDirectExecution });
  const compactInstruction = compactTaskText(instruction, { maxChars: 2800 });
  const executionRequirementsBlock = formatExecutionRequirementsBlock(executionRequirements);
  const prompt = [
    ctx,
    "",
    "Codex workspace context is preloaded via .codex/instructions.md.",
    kbContract,
    "You are a code implementation agent.",
    "Rules:",
    "- No network access.",
    `- Modify files only inside CODEX_WORKSPACE_ROOT: ${workspacePath}`,
    `- Current run workspace: ${workspacePath}`,
    "- Read uploads/ files when they are relevant to the task.",
    workspaceFilesText,
    allowDirectExecution
      ? "- This task requires real execution/build output. Run bounded local shell commands directly and verify results."
      : "- A separate tool_proxy verification stage may run tests/builds; keep appropriate verification commands in mind while editing.",
    "- Include a concise change summary with per-file rationale.",
    executionRequirementsBlock ? `[DELIVERY REQUIREMENTS]
${executionRequirementsBlock}` : "",
    "",
    "Task:",
    compactInstruction,
    "",
  ].join("\n");
  appendPromptTelemetry({
    jobDir: runDir(jobId),
    sharedDir: runSharedDir(jobId),
    row: {
      kind: 'provider_prompt',
      provider: 'codex',
      model: String(providerOptions.profile || process.env.CODEX_PROFILE || '').trim() || 'codex',
      agent_id: String(opts.agentId || 'codex').trim().toLowerCase(),
      role_id: String(opts.roleId || 'builder').trim().toLowerCase(),
      prompt_text: prompt,
      prepared_context_tokens: opts.preparedContextInfo?.compiled_tokens_estimate,
      prepared_context_chars: opts.preparedContextInfo?.compiled_chars,
      components: {
        local_context: ctx,
        kb_contract: kbContract,
        instructions_file: '.codex/instructions.md',
        workspace_files: workspaceFilesText,
        task_instruction: compactInstruction,
        execution_requirements: executionRequirementsBlock,
      },
      metadata: {
        sandbox_mode: providerOptions.sandboxMode || undefined,
        approval_policy: providerOptions.approvalPolicy || undefined,
      },
    },
  });
  const r = await runCodexExec({
    workspaceRoot: workspacePath,
    cwd: workspacePath,
    prompt,
    signal,
    jobId,
    profile: providerOptions.profile || process.env.CODEX_PROFILE || "",
    addDirs: providerOptions.addDirs || [],
    sandboxMode: providerOptions.sandboxMode,
    approvalPolicy: providerOptions.approvalPolicy,
    configOverrides: {
      ...(providerOptions.configOverrides || {}),
      ...(cliSupport.codexInstructionFile ? { model_instructions_file: cliSupport.codexInstructionFile } : {}),
    },
    env: {
      ...(providerOptions.extraEnv || {}),
      ...credentialEnv,
    },
  });
  const out = (r.stdout || r.stderr || "");
  appendRoleAwareTracking(jobId, `## Codex output\n\n${out}\n`, {
    provider: 'codex',
    roleId: String(opts.roleId || 'builder').trim().toLowerCase(),
    purpose: opts.finalSynthesis === true ? 'final' : 'implementation',
    fallbackDoc: 'progress',
    requestedDoc: opts.finalSynthesis === true ? 'final_answer' : 'implementation_notes',
  });
  jobs.appendConversation(jobId, "codex", out, { kind: "implementation" });
  ensureCommandOk("Codex", r);
  return out;
}


async function codexAssist(jobId, instruction, signal = null, opts = {}) {
  const runtimeExecutionPolicy = normalizeRuntimeExecutionPolicy(opts.runtimeExecutionPolicy || {});
  const explicitProviderOptions = opts.providerOptions && typeof opts.providerOptions === 'object' ? opts.providerOptions : {};
  const resolvedCodexOptions = resolveProviderRuntimeOptions({
    runtimeExecutionPolicy,
    provider: 'codex',
    workspaceRoot: runWorkspaceDir(jobId),
  });
  const providerOptions = {
    ...resolvedCodexOptions,
    ...explicitProviderOptions,
    sandboxMode: String(explicitProviderOptions.sandboxMode || explicitProviderOptions.sandbox_mode || process.env.CODEX_ASSIST_SANDBOX_MODE || resolvedCodexOptions.sandboxMode || 'read-only').trim() || 'read-only',
    approvalPolicy: String(explicitProviderOptions.approvalPolicy || explicitProviderOptions.approval_policy || process.env.CODEX_ASSIST_APPROVAL_POLICY || resolvedCodexOptions.approvalPolicy || 'never').trim() || 'never',
  };
  const workspacePath = runWorkspaceDir(jobId);
  const credentialEnv = resolveCredentialEnvForChat(chatSessionStore, opts.chatId || '');
  const roleKey = String(opts.roleId || 'assistant').trim().toLowerCase() || 'assistant';
  const agentKey = String(opts.agentId || 'codex_assist').trim().toLowerCase() || 'codex_assist';
  const cleanUserRequest = String(opts.userRequest || opts.user_request || extractLatestUserRequestFromTaskText(instruction) || instruction || '').trim();
  const surfaceLocale = resolveUserSurfaceLocale({ message: cleanUserRequest || instruction, runtime: opts.runtime || null, fallback: opts.userLocale || opts.user_locale || 'ko' });
  const outputGuide = buildDirectAnswerOutputGuide(opts.outputGuide || opts.output_guide || '', { userLocale: surfaceLocale });
  const roleMemo = String(opts.roleMemo || opts.role_memo || memory.getAgentRole('codex') || '').trim();
  const ctx = await runtimeIo.loadRoleScopedContextDocs(jobId, {
    provider: 'codex',
    roleId: roleKey,
    fallbackDocIds: ['plan', 'progress', 'research', 'decisions', 'artifact_index'],
    maxCharsPerDoc: clampInteger(process.env.CHAT_CODEX_ASSIST_CONTEXT_DOC_MAX_CHARS, 1800, { min: 0, max: 4200 }),
    audienceLabel: 'agent failover assist',
    runtimePolicy: opts.runtime?.harnessRuntimePolicy || opts.runtime?.openharnessInstallState?.runtime_policy || null,
  });
  const executionRequirements = resolveExecutionRequirementsForRuntime(
    applyRuntimeRulePolicy(mergeExecutionRequirements(
      extractExecutionRequirements(cleanUserRequest),
      extractExecutionRequirements(instruction),
    ), opts.chatRuntimeRules || opts.chat_runtime_rules || '', { runtimeExecutionPolicy }),
    { runtimeExecutionPolicy, roleId: roleKey, taskText: `${cleanUserRequest}\n${instruction}` },
  );
  const artifactPolicyBlock = buildArtifactTurnPolicyBlock(executionRequirements, { hasArtifactContract: executionRequirements.artifact_delivery_requested === true, runtimeExecutionPolicy, roleId: roleKey });
  appendExecutionPolicyResolution({
    jobDir: runDir(jobId),
    source: 'codexAssist',
    agentId: agentKey,
    roleId: roleKey,
    runtimeExecutionPolicy,
    requirements: executionRequirements,
    decision: executionRequirements.task_loop_workspace_write_allowed ? 'task_loop_workspace_write_allowed' : (executionRequirements.artifact_delivery_forbidden ? 'artifact_forbidden' : 'chat_default'),
  });
  const includeArtifactContext = executionRequirements.artifact_delivery_requested === true;
  const activeArtifactContext = includeArtifactContext ? formatActiveArtifactContext(runDir(jobId), { maxChars: 1200, limit: 4 }) : '';
  const activeUserFactContext = formatActiveUserFactContext(runDir(jobId), { maxChars: 1600 });
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, {
    limitPerBucket: 3,
    includeWorkspaceArtifacts: includeArtifactContext,
    includeActiveArtifactContext: includeArtifactContext,
  });
  const artifactMaterializationGuide = executionRequirements.artifact_delivery_requested
    ? [
      '[FILE ARTIFACT OUTPUT CONTRACT]',
      '- If the user expects a file deliverable, output explicit artifact blocks. The runtime will materialize them.',
      '- Shape:',
      '  [ARTIFACT]',
      '  path: relative/path/to/file.ext',
      '  ```language',
      '  complete file contents',
      '  ```',
      '  [/ARTIFACT]',
    ].join('\n')
    : '';
  const webSearchEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.CODEX_ENABLE_WEB_SEARCH || '').trim().toLowerCase());
  const failoverNote = opts.failoverDecision
    ? `Provider failover: Gemini could not serve the request because of ${String(opts.failoverDecision?.failure?.category || opts.failoverDecision?.reason || 'transient capacity').trim()}. Continue with the best available answer; mention missing live-web capability only if it materially affects the answer.`
    : '';
  const prompt = [
    internalLanguagePolicyBlock({ surfaceLocale }),
    'You are a general-purpose assistant agent invoked by Telegram /chat.',
    'This execution is not code-editing only. Answer the latest user request directly.',
    failoverNote,
    roleMemo ? `[ROLE]\n${clip(roleMemo, 700)}` : '',
    '[SAFETY / EXECUTION]',
    `- workspace sandbox: ${providerOptions.sandboxMode}`,
    '- Do not edit files unless the user clearly requested a file/code artifact.',
    webSearchEnabled
      ? '- Web search may be available through Codex tooling; use it when needed for current facts.'
      : '- Live web search may be unavailable in this fallback. If current facts are required, ask for permission/tooling or state the limitation briefly.',
    ctx ? `[AVAILABLE MEMORY — optional]\n${ctx}` : '',
    activeArtifactContext || '',
    activeUserFactContext || '',
    workspaceFilesText ? `[WORKSPACE FILES — optional]\n${workspaceFilesText}` : '',
    artifactPolicyBlock,
    artifactMaterializationGuide,
    '[USER REQUEST]',
    cleanUserRequest || instruction,
    cleanUserRequest && cleanUserRequest !== String(instruction || '').trim() ? `[TASK CONTEXT]\n${compactTaskText(instruction, { maxChars: 1800 })}` : '',
    outputGuide,
    buildLocalizedSurfaceLabels(surfaceLocale).finalAnswer,
  ].filter(Boolean).join('\n\n');
  appendPromptTelemetry({
    jobDir: runDir(jobId),
    sharedDir: runSharedDir(jobId),
    row: {
      kind: 'provider_prompt',
      provider: 'codex',
      model: String(providerOptions.profile || process.env.CODEX_PROFILE || '').trim() || 'codex',
      agent_id: agentKey,
      role_id: roleKey,
      prompt_text: prompt,
      prepared_context_tokens: opts.preparedContextInfo?.compiled_tokens_estimate,
      prepared_context_chars: opts.preparedContextInfo?.compiled_chars,
      components: {
        user_request: cleanUserRequest || instruction,
        local_context: ctx,
        active_artifact_context: activeArtifactContext,
        active_user_fact_context: activeUserFactContext,
        workspace_files: workspaceFilesText,
        output_guide: outputGuide,
        failover_note: failoverNote,
      },
      metadata: {
        sandbox_mode: providerOptions.sandboxMode || undefined,
        approval_policy: providerOptions.approvalPolicy || undefined,
        failover_from: opts.failoverDecision?.from_provider || undefined,
        failover_reason: opts.failoverDecision?.reason || undefined,
        prompt_mode: 'direct_answer_failover',
      },
    },
  });
  const cliSupport = ensureCliWorkspaceSupportFiles(jobId, {
    provider: 'codex',
    roleMemo,
    kbContract: '',
    instruction: prompt,
    goal: cleanUserRequest || instruction,
    runtimeExecutionPolicy,
    providerOptions,
    allowDirectExecution: false,
  });
  const r = await runCodexExec({
    workspaceRoot: workspacePath,
    cwd: workspacePath,
    prompt,
    signal,
    jobId,
    profile: providerOptions.profile || process.env.CODEX_PROFILE || '',
    addDirs: providerOptions.addDirs || [],
    sandboxMode: providerOptions.sandboxMode,
    approvalPolicy: providerOptions.approvalPolicy,
    configOverrides: {
      ...(providerOptions.configOverrides || {}),
      ...(cliSupport.codexInstructionFile ? { model_instructions_file: cliSupport.codexInstructionFile } : {}),
    },
    env: {
      ...(providerOptions.extraEnv || {}),
      ...credentialEnv,
    },
    surface: 'codex_assist_failover',
    agentId: agentKey,
    roleId: roleKey,
    traceMetadata: {
      failover_from: opts.failoverDecision?.from_provider || null,
      failover_reason: opts.failoverDecision?.reason || null,
    },
  });
  const out = String(r.stdout || r.stderr || '').trim();
  const materialization = executionRequirements.artifact_delivery_requested
    ? materializeArtifactsFromLlmOutput({ output: out, workspaceRoot: workspacePath, userRequest: cleanUserRequest || instruction })
    : { materialized: [] };
  if (materialization.materialized?.length) {
    try { runtimeIo.refreshArtifactIndex(jobId, { maxFiles: 12 }); } catch {}
  }
  appendRoleAwareTracking(jobId, `## Codex fallback assist output\n\n${out}\n`, {
    provider: 'codex',
    roleId: roleKey,
    purpose: opts.finalSynthesis === true ? 'final' : 'research',
    fallbackDoc: 'research',
    requestedDoc: opts.finalSynthesis === true ? 'final_answer' : 'research',
  });
  jobs.appendConversation(jobId, 'codex', out, { kind: 'assistant_failover', provider: 'codex', model: providerOptions.profile || process.env.CODEX_PROFILE || 'codex' });
  ensureCommandOk('Codex fallback assist', r);
  if (materialization.materialized?.length) {
    return [
      out,
      '',
      '생성된 파일:',
      ...materialization.materialized.map((entry) => `- ${entry.path}`),
    ].join('\n');
  }
  return out;
}

async function gitSummary(jobId, signal = null) {
  const commandCwd = runWorkspaceDir(jobId);
  const status = await runCommand("git", ["status", "--porcelain=v1"], { cwd: commandCwd, abortSignal: signal });
  if (!status.ok && /not a git repository/i.test(String(status.stderr || ""))) {
    const note = `workspace is not a git repository: ${commandCwd}`;
    appendRoleAwareTracking(jobId, `## git status\n\n${note}\n`, { provider: 'codex', roleId: 'builder', purpose: 'implementation', fallbackDoc: 'progress' });
    return { status: "", diff: "", note };
  }
  const diff = await runCommand("git", ["diff"], { cwd: commandCwd, timeoutMs: 120000, abortSignal: signal });
  ensureCommandOk("git status", status);
  ensureCommandOk("git diff", diff);

  appendRoleAwareTracking(jobId, `## git status\n\n${FENCE}\n${status.stdout}\n${FENCE}\n`, { provider: 'codex', roleId: 'builder', purpose: 'implementation', fallbackDoc: 'progress' });
  appendRoleAwareTracking(jobId, `## git diff\n\n${FENCE}diff\n${diff.stdout}\n${FENCE}\n`, { provider: 'codex', roleId: 'builder', purpose: 'implementation', fallbackDoc: 'progress' });

  return { status: status.stdout || "", diff: diff.stdout || "" };
}

function formatChatSummary(routePlan, results) {
  return formatChatSummaryAdapter(routePlan, results);
}

function summarizeSpecialChatOutputs(outputs) {
  return summarizeSpecialChatOutputsShared(outputs);
}

function buildChatSynthesisFallback(message, execution = {}, runtime = null) {
  return buildChatSynthesisFallbackShared(message, { ...execution, runtime });
}

async function synthesizeChatReply(message, routePlan, execution = {}) {
  const surfaceLocale = resolveUserSurfaceLocale({ message, runtime: execution?.runtime || routePlan?.runtime || null, fallback: 'ko' });
  const surfaceLabels = buildLocalizedSurfaceLabels(surfaceLocale);
  if (execution && typeof execution === 'object' && !execution.runtime && routePlan?.runtime) execution.runtime = routePlan.runtime;
  const runtime = execution?.runtime || routePlan?.runtime || null;
  const foldedSignals = collectFoldedParticipantSignals(runtime, {
    turnId: runtime?.currentTurnId || runtime?.current_turn_id || runtime?.runtimeSessionState?.active_turn?.turn_id || runtime?.runtime_session_state?.active_turn?.turn_id || '',
  });
  await recordFoldedParticipantSignals(runtime, foldedSignals, {
    turnId: runtime?.currentTurnId || runtime?.current_turn_id || runtime?.runtimeSessionState?.active_turn?.turn_id || runtime?.runtime_session_state?.active_turn?.turn_id || '',
    runEventSink: execution?.runEventSink || runtime?.runEventSink || runtime?.run_event_sink || null,
    jobId: String(execution?.currentJobId || runtime?.currentJobId || runtime?.current_job_id || '').trim(),
  });
  const appendFoldedDigestOnFallback = ['folded_only', 'always_append'].includes(String(foldedSignals?.mode || '').trim().toLowerCase());
  const appendFoldedDigestAlways = String(foldedSignals?.mode || '').trim().toLowerCase() === 'always_append';
  const outputs = Array.isArray(execution.outputs) ? execution.outputs : [];
  const hardFailures = Array.isArray(execution?.results)
    ? execution.results.filter((row) => ['error', 'blocked'].includes(String(row?.status || '').trim().toLowerCase()))
    : [];
  const capabilityGapDetected = detectCapabilityGapsFromExecution(execution).length > 0;
  if (outputs.length === 0 || hardFailures.length > 0 || capabilityGapDetected) {
    const fallback = buildChatSynthesisFallback(message, execution, runtime || null);
    return appendFoldedDigestOnFallback ? appendFoldedContributionDigest(fallback, foldedSignals) : fallback;
  }
  const special = summarizeSpecialChatOutputs(outputs);
  const hasAgentOutput = outputs.some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
  if (String(routePlan?.reason || "").trim().toLowerCase() === "direct_agent_followup_shortcut") {
    const direct = outputs.find((row) => String(row?.agentId || "").trim().toLowerCase() !== "system" && String(row?.output || "").trim());
    if (direct) {
      const directText = clip(String(direct.output || "").trim(), 3800);
      return appendFoldedDigestAlways ? appendFoldedContributionDigest(directText, foldedSignals) : directText;
    }
  }
  if (special && !hasAgentOutput) return appendFoldedDigestOnFallback ? appendFoldedContributionDigest(special, foldedSignals) : special;

  const outputText = outputs
    .map((row, idx) => [
      `## output_${idx + 1}`,
      `agent=${row.agentId || "unknown"}`,
      `provider=${row.provider || "unknown"}`,
      clip(String(row.output || ""), 3200),
    ].join("\n"))
    .join("\n\n");

  const jobId = String(execution.currentJobId || "").trim();
  const cwd = (() => {
    if (!jobId) return process.cwd();
    try {
      return runWorkspaceDir(jobId);
    } catch {
      return process.cwd();
    }
  })();

  const prompt = [
    internalLanguagePolicyBlock({ surfaceLocale }),
    "You are the final response writer for Telegram /chat.",
    "Write exactly one user-facing final response from the internal execution results below.",
    "Rules:",
    `- ${userSurfaceLanguageDirective(surfaceLocale)}`,
    "- Hide internal routing, job IDs, run_dir, provider names, agent names, and raw logs unless the user explicitly asks for diagnostics.",
    "- Give the core answer first, then at most 1–3 short next steps if useful.",
    "",
    surfaceLabels.userRequest,
    String(message || ""),
    "",
    "Internal routing summary:",
    `reason=${String(routePlan?.reason || "(none)")}`,
    `actions=${(Array.isArray(routePlan?.actions) ? routePlan.actions : []).map((a) => chatActionLabel(a)).join(", ") || "(none)"}`,
    "",
    "Execution results:",
    outputText,
    special ? "Special execution summary:" : "",
    special ? special : "",
    foldedSignals.prompt_block ? foldedSignals.prompt_block : "",
    "",
    surfaceLabels.finalAnswer,
  ].join("\n");

  try {
    const r = await enqueue(
      () => runGeminiPrompt({
        workspaceRoot: cwd,
        cwd,
        prompt,
        concurrencyKey: `job:${String(jobId || "").trim()}`,
        jobId,
      }),
      { jobId, label: "chat_synthesize" }
    );
    const out = String(r?.stdout || r?.stderr || "").trim();
    if (r?.ok && out) {
      if (execution && typeof execution === 'object') {
        execution._response_model_badge = {
          ...(execution._response_model_badge && typeof execution._response_model_badge === 'object' ? execution._response_model_badge : {}),
          final: { provider: 'gemini', model: String(r.used_model || r.model || '').trim() || 'gemini' },
        };
      }
      const reply = clip(out, 3800);
      return appendFoldedDigestAlways ? appendFoldedContributionDigest(reply, foldedSignals) : reply;
    }
  } catch {}

  if (execution && typeof execution === 'object') {
    execution._response_model_badge = {
      ...(execution._response_model_badge && typeof execution._response_model_badge === 'object' ? execution._response_model_badge : {}),
      final: { provider: 'local', model: 'fallback' },
    };
  }
  const fallback = buildChatSynthesisFallback(message, execution, runtime || null);
  return appendFoldedDigestOnFallback ? appendFoldedContributionDigest(fallback, foldedSignals) : fallback;
}


function buildSupervisorExecutionCallbacks({
  bot,
  chatId,
  userId,
  jobId,
  runtime,
  controller,
  verbose,
  onAgentStatusChanged = null,
  executionGraph = null,
  contextEngine = null,
  runEventSink = null,
  getRoutePlan = null,
}) {
  const sharedContextSetId = String(runtime?.map?.ctxSharedId || "").trim();
  const threadId = String(runtime?.map?.threadId || "").trim();
  const currentTelegramUserId = String(userId || "").trim();
  const lensCacheByKey = new Map();
  const sharedContextMeta = runtime?.contextMeta && typeof runtime.contextMeta === "object"
    ? runtime.contextMeta
    : null;
  const hasContextEngine = !!(contextEngine && typeof contextEngine.prepareStepContext === "function");
  const resolveCurrentRoutePlan = () => {
    try {
      const current = typeof getRoutePlan === "function" ? getRoutePlan() : null;
      return current && typeof current === "object" ? current : null;
    } catch {
      return null;
    }
  };
  let threadNodeMapCache = null;

  const withBoundGocActor = async (work) => {
    const restoreActor = bindGocActor(currentTelegramUserId);
    try {
      return await work();
    } finally {
      restoreActor();
    }
  };

  const formatRuntimeAgentDisplay = (agentId = "") => {
    const index = buildTelegramAgentIndex({ runtime });
    return formatChatAgentDisplayName(agentId, index);
  };
  const rememberRecentAgentTurn = ({ agentId = "", goal = "", output = "", provider = "", model = "", runtimeInstanceId = "", slotId = "", scopeId = "" } = {}) => {
    const cleanAgentId = String(agentId || "").trim().toLowerCase();
    if (!cleanAgentId || !String(output || "").trim()) return;
    const configAgent = findAgentConfigInRuntime(cleanAgentId, runtime) || findAgentConfig(cleanAgentId) || {};
    const normalizedRoleId = String(configAgent?.role || configAgent?.system_key || cleanAgentId).trim().toLowerCase();
    const maxRecentTurns = Number(runtime?.activeTeamConfig?.shortcut_policy?.max_recent_turns || 6);
    chatSessionStore.upsert(chatId, (session) => ({
      ...session,
      recent_agent_turns: appendRecentAgentTurn(session?.recent_agent_turns || [], {
        agent_id: cleanAgentId,
        agent_name: String(configAgent?.name || cleanAgentId).trim(),
        role: normalizedRoleId,
        provider: String(provider || configAgent?.provider || "").trim().toLowerCase(),
        model: String(model || configAgent?.model || "").trim(),
        goal: String(goal || "").trim(),
        output: String(output || "").trim(),
        runtime_instance_id: String(runtimeInstanceId || "").trim(),
        slot_id: String(slotId || "").trim(),
        scope_id: String(scopeId || "").trim(),
        job_id: String(jobId || "").trim(),
        ts: new Date().toISOString(),
      }).slice(0, Math.max(1, Math.min(12, maxRecentTurns))),
    }));
    updateRoleSummary({
      jobDir: safeRunDir(jobId),
      roleId: normalizedRoleId,
      agentId: cleanAgentId,
      goal: String(goal || "").trim(),
      output: String(output || "").trim(),
      provider: String(provider || configAgent?.provider || "").trim().toLowerCase(),
      model: String(model || configAgent?.model || "").trim(),
    });
  };

  function estimateTokens(text) {
    return estimatePromptTelemetryTokens(text);
  }

  function normalizeLensSpec(rawLens, { fallbackBudget = 1200 } = {}) {
    return normalizeLensSpecDomain(rawLens, { fallbackBudget });
  }

  function dedupeNodeIds(nodeIds = []) {
    return dedupeLensNodeIds(nodeIds);
  }

  function defaultLensSpecForAgent({ agentId = "", goal = "" } = {}) {
    return defaultLensSpecForAgentDomain({
      agentId,
      goal: clip(String(goal || "").trim(), 280),
      recentArtifactNodeIds: runtime?.recentArtifactNodeIds || [],
    });
  }

  function resolveEffectiveLensSpec(rawLens, { agentId = "", goal = "" } = {}) {
    return resolveEffectiveLensSpecDomain(rawLens, {
      agentId,
      goal: clip(String(goal || "").trim(), 280),
      recentArtifactNodeIds: runtime?.recentArtifactNodeIds || [],
    });
  }

  async function getThreadNodeMap(client, { refresh = false } = {}) {
    if (!client || !threadId) return new Map();
    if (!refresh && threadNodeMapCache instanceof Map) return threadNodeMapCache;
    const nodes = await client.listNodes(threadId, {
      contextSetId: sharedContextSetId || undefined,
    }).catch(() => []);
    const map = new Map();
    for (const row of Array.isArray(nodes) ? nodes : []) {
      const id = String(row?.id || "").trim();
      if (!id) continue;
      map.set(id, row);
    }
    threadNodeMapCache = map;
    return map;
  }

  function rankNodeForBudgetRemoval(node = {}) {
    const type = nodeTypeKey(node);
    const resourceKind = nodeResourceKind(node);
    const role = messageRoleOf(node);
    const createdMs = parseNodeCreatedAtMs(node);
    if (resourceKind === "job_config" || resourceKind === "tracking_append") {
      return { rank: 0, createdMs };
    }
    if (type === "toolresult" || type === "toolcall") {
      return { rank: 1, createdMs };
    }
    if (type === "run" || type === "step") {
      return { rank: 2, createdMs };
    }
    if (type === "resource" && resourceKind !== "artifact") {
      return { rank: 3, createdMs };
    }
    if (type === "message" && role === "assistant") {
      return { rank: 4, createdMs };
    }
    if (type === "artifact" || resourceKind === "artifact") {
      return { rank: 6, createdMs };
    }
    if (type === "message" && role === "user") {
      return { rank: 10, createdMs };
    }
    return { rank: 5, createdMs };
  }

  async function enforceLensBudget(client, {
    contextSetId = "",
    lensSpec = null,
    compiledText = "",
  } = {}) {
    const ctxId = String(contextSetId || "").trim();
    const normalizedLens = normalizeLensSpec(lensSpec, { fallbackBudget: 1200 });
    const budgetTokens = Number(normalizedLens?.budget_tokens) > 0
      ? Math.floor(Number(normalizedLens.budget_tokens))
      : 1200;

    let text = String(compiledText || "");
    let tokenEstimate = estimateTokens(text);
    let activeNodeIds = [];
    let breakdown = {};

    if (!ctxId || !client) {
      const maxChars = Math.max(1200, Math.floor(budgetTokens * 4));
      if (tokenEstimate > budgetTokens && text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n\n[context truncated: budget=${budgetTokens}]`;
        tokenEstimate = estimateTokens(text);
      }
      return {
        compiledText: text,
        compiledTokensEstimate: tokenEstimate,
        compiledChars: text.length,
        activeNodeIds: [],
        activeTypeBreakdown: {},
      };
    }

    for (let attempt = 0; attempt < 3 && tokenEstimate > budgetTokens; attempt += 1) {
      let activeIds = [];
      try {
        const ctx = await client.getContextSet(ctxId);
        activeIds = dedupeNodeIds(ctx?.activeNodeIds || []);
      } catch {
        activeIds = [];
      }
      if (activeIds.length <= 8) break;

      const nodeMap = await getThreadNodeMap(client, { refresh: attempt > 0 });
      const removable = activeIds
        .map((id) => ({ id, node: nodeMap.get(id) }))
        .filter((row) => row.id)
        .map((row) => ({
          ...row,
          ...rankNodeForBudgetRemoval(row.node || {}),
        }))
        .filter((row) => Number(row.rank) < 10)
        .sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank;
          return a.createdMs - b.createdMs;
        });
      if (removable.length === 0) break;
      const removeCount = Math.max(1, Math.ceil(removable.length * 0.25));
      const removeIds = removable.slice(0, removeCount).map((row) => row.id).filter(Boolean);
      if (removeIds.length === 0) break;
      await client.deactivateNodes(ctxId, removeIds).catch(() => {});
      text = await client.getCompiledContext(ctxId).catch(() => text);
      tokenEstimate = estimateTokens(text);
    }

    if (tokenEstimate > budgetTokens) {
      const maxChars = Math.max(1200, Math.floor(budgetTokens * 4));
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n\n[context truncated: budget=${budgetTokens}]`;
        tokenEstimate = estimateTokens(text);
      }
    }

    try {
      const ctx = await client.getContextSet(ctxId);
      activeNodeIds = dedupeNodeIds(ctx?.activeNodeIds || []);
      const nodeMap = await getThreadNodeMap(client, { refresh: false });
      breakdown = summarizeActiveTypeBreakdown(activeNodeIds, nodeMap);
    } catch {
      activeNodeIds = [];
      breakdown = {};
    }

    return {
      compiledText: text,
      compiledTokensEstimate: tokenEstimate,
      compiledChars: text.length,
      activeNodeIds,
      activeTypeBreakdown: breakdown,
    };
  }

  function buildSharedContextInfo({
    lensSpec = null,
    compiledText = "",
    lensContextSetId = "",
    lensAddedCount = 0,
    contextActiveNodeIds = null,
    activeTypeBreakdown = null,
  } = {}) {
    const normalizedLens = normalizeLensSpec(lensSpec, { fallbackBudget: 1200 });
    const activeNodeIds = Array.isArray(contextActiveNodeIds)
      ? contextActiveNodeIds
      : (Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : []);
    const breakdown = activeTypeBreakdown && typeof activeTypeBreakdown === "object"
      ? activeTypeBreakdown
      : (runtime?.sharedActiveTypeBreakdown && typeof runtime.sharedActiveTypeBreakdown === "object"
        ? runtime.sharedActiveTypeBreakdown
        : {});
    return {
      context_set_id: sharedContextSetId || undefined,
      context_version: String(sharedContextMeta?.version || "").trim() || undefined,
      context_active_node_ids: activeNodeIds.length > 0 ? activeNodeIds : undefined,
      shared_context_set_id: sharedContextSetId || undefined,
      shared_context_version: String(sharedContextMeta?.version || "").trim() || undefined,
      shared_context_active_node_ids: Array.isArray(sharedContextMeta?.active_node_ids) && sharedContextMeta.active_node_ids.length > 0
        ? sharedContextMeta.active_node_ids
        : undefined,
      lens_context_set_id: String(lensContextSetId || sharedContextSetId || "").trim() || undefined,
      lens_spec: normalizedLens,
      lens_budget_tokens: normalizedLens.budget_tokens,
      lens_added_ids_count: Number.isFinite(Number(lensAddedCount)) ? Math.max(0, Math.floor(Number(lensAddedCount))) : 0,
      compiled_tokens_estimate: estimateTokens(compiledText),
      compiled_chars: String(compiledText || "").length,
      active_type_breakdown: breakdown,
    };
  }

  async function prepareStepLensContext({
    agentId = "",
    goal = "",
    lens = null,
    detailContext = "",
    stepNodeId = "",
    actionInputs = null,
    runtimeInstanceId = "",
    slotId = "",
    scopeId = "",
  } = {}) {
    const cleanAgentId = String(agentId || "").trim().toLowerCase();
    const cleanGoal = String(goal || "").trim();
    const cleanDetail = String(detailContext || "").trim();
    const cleanStepNodeId = String(stepNodeId || "").trim();
    const runtimeTeamSnapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
      ? runtime.runtimeTeamSnapshot
      : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === "object"
        ? runtime.runtime_team_snapshot
        : null);
    const scopedMode = isScopedContextMode(
      runtimeTeamSnapshot?.context_runtime_mode
      || runtime?.contextRuntimeMode
      || runtime?.context_runtime_mode
      || "shared_memory"
    );
    const scopeBinding = scopedMode
      ? resolveScopeBinding({
        runtimeSnapshot: runtimeTeamSnapshot,
        action: {
          agent: cleanAgentId,
          inputs: actionInputs && typeof actionInputs === "object" ? actionInputs : {},
        },
        agentId: cleanAgentId,
        runtimeInstanceId,
        slotId,
        scopeId,
      })
      : null;
    if (scopedMode && scopeBinding?.materialized_scope) {
      return buildScopedPromptAssembly({
        goal: cleanGoal,
        detailContext: cleanDetail,
        runtime,
        scopeBinding,
      });
    }
    if (hasContextEngine) {
      const runtimeAuthority = buildRunAuthority(runtime);
      const prepared = await contextEngine.prepareStepContext({
        jobId,
        chatId: String(chatId || ""),
        threadId,
        agentId: cleanAgentId,
        goal: cleanGoal,
        userMessageText: cleanGoal,
        stepKind: "agent",
        budgetTokens: Number.isFinite(Number(lens?.budget_tokens))
          ? Number(lens.budget_tokens)
          : undefined,
        lensSpec: lens && typeof lens === "object" ? lens : null,
        detailContext: cleanDetail,
        runMeta: {
          runId: String(executionGraph?.runId || "").trim(),
          stepId: cleanStepNodeId || undefined,
          stepNodeId: cleanStepNodeId || undefined,
          threadId,
          sharedContextSetId,
          runtimeTeamSnapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
          ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
          jobConfig: runtime?.jobConfig && typeof runtime.jobConfig === "object"
            ? runtime.jobConfig
            : undefined,
        },
      });
      const contextText = String(prepared?.contextText || "").trim();
      const meta = prepared?.meta && typeof prepared.meta === "object"
        ? prepared.meta
        : {};
      const contextInfo = {
        mode: String(meta.mode || "").trim() || undefined,
        budgetTokens: Number.isFinite(Number(meta.budgetTokens))
          ? Math.floor(Number(meta.budgetTokens))
          : undefined,
        token_estimate: Number.isFinite(Number(meta.estimatedTokens))
          ? Math.floor(Number(meta.estimatedTokens))
          : undefined,
        compiled_tokens_estimate: Number.isFinite(Number(meta.estimatedTokens))
          ? Math.floor(Number(meta.estimatedTokens))
          : undefined,
        compiled_chars: Number.isFinite(Number(meta.compiledChars))
          ? Math.floor(Number(meta.compiledChars))
          : String(contextText).length,
        context_set_id: String(meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        context_version: String(meta.contextVersion || sharedContextMeta?.version || "").trim() || undefined,
        context_active_node_ids: Array.isArray(meta.contextActiveNodeIds) && meta.contextActiveNodeIds.length > 0
          ? meta.contextActiveNodeIds
          : undefined,
        shared_context_set_id: String(meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        lens_context_set_id: String(meta.lensContextSetId || meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        lens_spec: meta.lensSpec && typeof meta.lensSpec === "object"
          ? meta.lensSpec
          : (lens && typeof lens === "object" ? lens : undefined),
        lens_added_ids_count: Number.isFinite(Number(meta.lensAddedCount))
          ? Math.max(0, Math.floor(Number(meta.lensAddedCount)))
          : 0,
        lens_removed_ids_count: Number.isFinite(Number(meta.lensRemovedCount))
          ? Math.max(0, Math.floor(Number(meta.lensRemovedCount)))
          : 0,
        activeNodeIdsCount: Number.isFinite(Number(meta.activeNodeIdsCount))
          ? Math.max(0, Math.floor(Number(meta.activeNodeIdsCount)))
          : undefined,
        node_type_breakdown: meta.typeBreakdown && typeof meta.typeBreakdown === "object"
          ? meta.typeBreakdown
          : undefined,
        active_type_breakdown: meta.typeBreakdown && typeof meta.typeBreakdown === "object"
          ? meta.typeBreakdown
          : undefined,
        local_recent_turns_count: Number.isFinite(Number(meta.localRecentTurnsCount))
          ? Math.max(0, Math.floor(Number(meta.localRecentTurnsCount)))
          : undefined,
        local_summary_chars: Number.isFinite(Number(meta.localSummaryChars))
          ? Math.max(0, Math.floor(Number(meta.localSummaryChars)))
          : undefined,
        local_pinned_count: Number.isFinite(Number(meta.localPinnedCount))
          ? Math.max(0, Math.floor(Number(meta.localPinnedCount)))
          : undefined,
      };
      await contextEngine.recordMeta({
        jobId,
        chatId: String(chatId || ""),
        agentId: cleanAgentId,
        goal: cleanGoal,
        userMessageText: cleanGoal,
        stepKind: "agent",
        runMeta: {
          runId: String(executionGraph?.runId || "").trim(),
          stepId: cleanStepNodeId || undefined,
          stepNodeId: cleanStepNodeId || undefined,
          threadId,
          sharedContextSetId,
          runtimeTeamSnapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
          ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
        },
        meta,
      }).catch(() => {});
      const finalPrompt = [
        cleanGoal,
        contextText ? `[CONTEXT]\n${clip(contextText, 12000)}` : "",
        cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
        runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
      ].filter(Boolean).join("\n\n");
      return {
        final_prompt: finalPrompt,
        context_info: contextInfo,
      };
    }
    const lensSpec = resolveEffectiveLensSpec(lens, {
      agentId: cleanAgentId,
      goal: cleanGoal,
    });
    const sharedCompiled = String(runtime?.contextSummary || "").trim();

    const fallbackText = [
      cleanGoal,
      sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : "",
      cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
      runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
    ].filter(Boolean).join("\n\n");

    if (memoryModeWithFallback() !== "goc" || !sharedContextSetId) {
      return {
        final_prompt: fallbackText,
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: fallbackText,
          lensContextSetId: sharedContextSetId || undefined,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: {},
        }),
      };
    }

    // shared_only + no extra detail + within budget: reuse shared context directly (skip clone/apply)
    if (
      lensSpec.mode === "shared_only"
      && !cleanDetail
      && estimateTokens(sharedCompiled) <= Number(lensSpec?.budget_tokens || 1200)
    ) {
      return {
        final_prompt: [
          cleanGoal,
          sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : "",
          runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
        ].filter(Boolean).join("\n\n"),
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: sharedCompiled,
          lensContextSetId: sharedContextSetId,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
        }),
      };
    }

    const lensKey = JSON.stringify({
      agent_id: cleanAgentId || "",
      shared_context_set_id: sharedContextSetId,
      shared_context_version: String(sharedContextMeta?.version || "").trim(),
      lens: lensSpec,
      detail: cleanDetail ? clip(cleanDetail, 600) : "",
    });
    if (lensCacheByKey.has(lensKey)) {
      const cached = lensCacheByKey.get(lensKey);
      const prompt = [
        cleanGoal,
        cached?.compiled_prompt || "",
        cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
        runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
      ].filter(Boolean).join("\n\n");
      return {
        final_prompt: prompt,
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: String(cached?.compiled_text || ""),
          lensContextSetId: cached?.lens_context_set_id || sharedContextSetId,
          lensAddedCount: Number.isFinite(Number(cached?.lens_added_ids_count))
            ? Number(cached.lens_added_ids_count)
            : 0,
          contextActiveNodeIds: Array.isArray(cached?.active_node_ids) ? cached.active_node_ids : [],
          activeTypeBreakdown: cached?.active_type_breakdown || {},
        }),
      };
    }

    const client = requireGocClient();
    let lensContextSetId = sharedContextSetId;
    let lensAddedCount = 0;
    let lensCompiledText = sharedCompiled;
    let enforced = {
      compiledText: sharedCompiled,
      compiledTokensEstimate: estimateTokens(sharedCompiled),
      compiledChars: sharedCompiled.length,
      activeNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
      activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
    };
    try {
      const cloned = await client.cloneContextSet(
        sharedContextSetId,
        `lens:${cleanAgentId || "agent"}@${Date.now().toString(36)}`,
        {
          kind: "agent_lens",
          agent_id: cleanAgentId || undefined,
          goal: cleanGoal || undefined,
          job_id: String(jobId || "").trim() || undefined,
          chat_id: String(chatId || "").trim() || undefined,
          lens_spec: lensSpec,
        }
      );
      lensContextSetId = String(cloned?.id || sharedContextSetId).trim() || sharedContextSetId;
      if (lensSpec.mode === "unfold_query" && lensSpec.query) {
        const plan = await client.unfoldPlan(lensContextSetId, lensSpec.query, lensSpec);
        const applied = await client.applyUnfoldPlan(lensContextSetId, plan, lensSpec);
        lensAddedCount = Array.isArray(applied?.added_node_ids) ? applied.added_node_ids.length : 0;
      }
      if (Array.isArray(lensSpec.add_node_ids) && lensSpec.add_node_ids.length > 0) {
        await client.activateNodes(lensContextSetId, lensSpec.add_node_ids);
        lensAddedCount += lensSpec.add_node_ids.length;
      }
      if (Array.isArray(lensSpec.remove_node_ids) && lensSpec.remove_node_ids.length > 0) {
        await client.deactivateNodes(lensContextSetId, lensSpec.remove_node_ids);
      }
      lensCompiledText = await client.getCompiledContext(lensContextSetId);
      enforced = await enforceLensBudget(client, {
        contextSetId: lensContextSetId,
        lensSpec,
        compiledText: lensCompiledText,
      });
      lensCompiledText = String(enforced?.compiledText || lensCompiledText || "").trim();
    } catch {
      lensContextSetId = sharedContextSetId;
      lensCompiledText = sharedCompiled;
      lensAddedCount = 0;
      enforced = {
        compiledText: sharedCompiled,
        compiledTokensEstimate: estimateTokens(sharedCompiled),
        compiledChars: sharedCompiled.length,
        activeNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
        activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
      };
    }

    const compiledPrompt = [
      sharedCompiled ? `[SHARED SUMMARY]\n${clip(sharedCompiled, 3500)}` : "",
      lensCompiledText ? `[LENS CONTEXT]\n${clip(lensCompiledText, 9000)}` : "",
    ].filter(Boolean).join("\n\n");
    const finalPrompt = [
      cleanGoal,
      compiledPrompt || (sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : ""),
      cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
      runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
    ].filter(Boolean).join("\n\n");
    const cachePayload = {
      lens_context_set_id: lensContextSetId,
      compiled_prompt: compiledPrompt,
      compiled_text: lensCompiledText,
      lens_added_ids_count: lensAddedCount,
      active_node_ids: Array.isArray(enforced?.activeNodeIds) ? enforced.activeNodeIds : [],
      active_type_breakdown: enforced?.activeTypeBreakdown && typeof enforced.activeTypeBreakdown === "object"
        ? enforced.activeTypeBreakdown
        : {},
    };
    lensCacheByKey.set(lensKey, cachePayload);
    return {
      final_prompt: finalPrompt,
      context_info: buildSharedContextInfo({
        lensSpec,
        compiledText: lensCompiledText,
        lensContextSetId,
        lensAddedCount,
        contextActiveNodeIds: Array.isArray(enforced?.activeNodeIds) ? enforced.activeNodeIds : [],
        activeTypeBreakdown: enforced?.activeTypeBreakdown || {},
      }),
    };
  }

  const runSingleAgent = async ({
    agentId,
    goal,
    detailContext = "",
    stepNodeId = "",
    preparedContext = null,
    actionInputs = null,
    runtimeInstanceId = "",
    slotId = "",
    scopeId = "",
  }) => {
    const cleanAgentId = String(agentId || "").trim().toLowerCase();
    const cleanGoal = String(goal || "").trim();
    const roleKey = String(actionInputs?.role_id || actionInputs?.roleId || cleanAgentId || '').trim().toLowerCase();
    const activeAgentConfig = cleanAgentId
      ? (findAgentConfigInRuntime(cleanAgentId, runtime) || findAgentConfig(cleanAgentId) || null)
      : null;
    const activeProvider = String(activeAgentConfig?.provider || '').trim().toLowerCase();
    const activeModel = String(activeAgentConfig?.model || '').trim();
    const activeExecutionChannel = String(activeAgentConfig?.provider_spec?.execution_channel || activeAgentConfig?.execution_channel || activeAgentConfig?.executionChannel || 'local_cli').trim().toLowerCase() || 'local_cli';
    const activeInteractionCapabilities = summarizeProviderInteractionCapabilities({
      provider: activeProvider,
      model: activeModel,
      executionChannel: activeExecutionChannel,
    });
    if (cleanAgentId) {
      updateAgentStatus(chatId, cleanAgentId, {
        state: "running",
        goal: cleanGoal,
        provider: activeProvider || undefined,
        model: activeModel || undefined,
        execution_channel: activeExecutionChannel || undefined,
        interaction_capabilities: activeInteractionCapabilities,
        started_at: new Date().toISOString(),
        ended_at: undefined,
      });
      if (typeof onAgentStatusChanged === "function") {
        await onAgentStatusChanged({
          chatId,
          agentId: cleanAgentId,
          state: "running",
          goal: cleanGoal,
        });
      }
      if (runEventSink && typeof runEventSink.recordAgentEvent === "function") {
        await runEventSink.recordAgentEvent("run.agent_start", {
          agent_id: cleanAgentId,
          role_id: roleKey || undefined,
          goal: cleanGoal,
          runtime_instance_id: runtimeInstanceId || undefined,
          slot_id: slotId || undefined,
          scope_id: scopeId || undefined,
        }, { jobId }).catch(() => null);
      }
    }

    const prepared = preparedContext && typeof preparedContext === "object"
      ? preparedContext
      : await prepareStepLensContext({
        agentId: cleanAgentId,
        goal: cleanGoal,
        lens: null,
        detailContext,
        stepNodeId,
        actionInputs,
        runtimeInstanceId,
        slotId,
        scopeId,
      });
    let activePreparedContext = prepared;
    try {
      const agentConfigForProjection = cleanAgentId
        ? (findAgentConfigInRuntime(cleanAgentId, runtime) || findAgentConfig(cleanAgentId) || null)
        : null;
      const modelNodeForProjection = [
        String(agentConfigForProjection?.provider || '').trim(),
        String(agentConfigForProjection?.model || '').trim(),
      ].filter(Boolean).join(':');
      const compiledProjection = compileAgentContextProjection({
        jobId,
        chatId: String(chatId || ''),
        threadId,
        agentId: cleanAgentId,
        roleId: roleKey || cleanAgentId,
        taskType: actionInputs?.task_type || actionInputs?.taskType || '',
        modelNode: modelNodeForProjection,
        goal: cleanGoal,
        baseContextText: String(prepared?.final_prompt || '').trim(),
        baseContextInfo: prepared?.context_info && typeof prepared.context_info === 'object' ? prepared.context_info : {},
        budgetTokens: Number(prepared?.context_info?.budgetTokens || prepared?.context_info?.lens_budget_tokens || 1800),
        rootDir: process.cwd(),
        runDir: safeRunDir(jobId),
      });
      activePreparedContext = attachCompiledProjectionToPreparedContext(prepared, compiledProjection);
    } catch (projectionError) {
      activePreparedContext = {
        ...(prepared || {}),
        context_info: {
          ...(prepared?.context_info && typeof prepared.context_info === 'object' ? prepared.context_info : {}),
          context_projection_error: String(projectionError?.message ?? projectionError),
        },
      };
    }
    const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
    const agencyRoleOverlay = resolveAgencyRoleOverlay(
      actionInputs?.agency_role_overlay,
      actionInputs?.agencyRoleOverlay,
    );
    const promptRoleSummary = readRoleSummary({ jobDir: safeRunDir(jobId), roleId: roleKey, agentId: cleanAgentId });
    const promptIterationDelta = readIterationDelta({ jobDir: safeRunDir(jobId) });
    const outputContractBlock = buildAgentOutputContractBlock({
      roleId: roleKey,
      runtimeExecutionPolicy,
    });
    const executionRequirements = resolveExecutionRequirementsForRuntime(
      applyRuntimeRulePolicy(mergeExecutionRequirements(
        extractExecutionRequirements(cleanGoal),
        extractExecutionRequirements(detailContext),
        extractExecutionRequirements(actionInputs?.user_request || actionInputs?.userRequest || ''),
      ), actionInputs?._runtime_rules_text || actionInputs?.runtime_rules_text || '', { runtimeExecutionPolicy }),
      { runtimeExecutionPolicy, roleId: roleKey, taskText: `${cleanGoal}\n${detailContext}\n${actionInputs?.user_request || actionInputs?.userRequest || ''}` },
    );
    const deliveryRequirementsBlock = formatExecutionRequirementsBlock(executionRequirements);
    const artifactPolicyBlock = buildArtifactTurnPolicyBlock(executionRequirements, { hasArtifactContract: executionRequirements.artifact_delivery_requested === true, runtimeExecutionPolicy, roleId: roleKey });
    appendExecutionPolicyResolution({
      jobDir: safeRunDir(jobId),
      source: 'runSingleAgent',
      agentId: cleanAgentId,
      roleId: roleKey,
      runtimeExecutionPolicy,
      requirements: executionRequirements,
      decision: executionRequirements.task_loop_workspace_write_allowed ? 'task_loop_workspace_write_allowed' : (executionRequirements.artifact_delivery_forbidden ? 'artifact_forbidden' : 'chat_default'),
    });
    const finalPrompt = [
      String(activePreparedContext?.final_prompt || "").trim() || cleanGoal,
      promptRoleSummary ? `[ROLE SUMMARY]\n${clip(promptRoleSummary, 900)}` : "",
      promptIterationDelta ? `[ITERATION DELTA]\n${clip(promptIterationDelta, 700)}` : "",
      deliveryRequirementsBlock ? `[DELIVERY REQUIREMENTS]\n${deliveryRequirementsBlock}` : "",
      artifactPolicyBlock,
      outputContractBlock,
    ].filter(Boolean).join("\n\n");
    try {
      const result = await enqueue(
        () => executeAgentRun(
          bot,
          chatId,
          jobId,
          {
            type: "agent_run",
            agent: cleanAgentId,
            prompt: finalPrompt,
            inputs: {
              ...(actionInputs && typeof actionInputs === "object" ? actionInputs : {}),
              _prompt_context_info: activePreparedContext?.context_info && typeof activePreparedContext.context_info === "object"
                ? activePreparedContext.context_info
                : undefined,
            },
          },
          {
            runtime,
            telegramUserId: currentTelegramUserId,
            signal: controller.signal,
            notify: verbose,
            geminiConcurrencyKey: `job:${String(jobId || "").trim()}`,
            onGeminiRetry: async ({ retryCount = 0, maxRetries = 0 } = {}) => {
              await runtimeUiHelpers.sendGeminiRetryMessage(bot, chatId, {
                retryCount,
                maxRetries,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
                getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
                resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
              });
            },
            onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
              await runtimeUiHelpers.sendGeminiModelSwitchMessage(bot, chatId, {
                toModel,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
                getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
                resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
              });
            },
            onGeminiGiveUp: async ({ reason = "" } = {}) => {
              await runtimeUiHelpers.sendGeminiGiveUpMessage(bot, chatId, {
                reason,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
                getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
                resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
              });
            },
          }
        ),
        { jobId, signal: controller.signal, label: `chat_v2_run_${String(cleanAgentId || "agent")}` }
      );
      appendPromptTelemetry({
        jobDir: safeRunDir(jobId),
        sharedDir: runSharedDir(jobId),
        row: {
          kind: 'provider_prompt',
          provider: String(result?.provider || '').trim().toLowerCase() || undefined,
          model: String(result?.model || '').trim() || undefined,
          agent_id: cleanAgentId,
          role_id: roleKey || cleanAgentId,
          prompt_text: finalPrompt,
          prepared_context_tokens: activePreparedContext?.context_info?.compiled_tokens_estimate,
          prepared_context_chars: activePreparedContext?.context_info?.compiled_chars,
          components: {
            assembled_context: String(activePreparedContext?.final_prompt || '').trim() || cleanGoal,
            role_summary: promptRoleSummary,
            agency_overlay: buildAgencyRoleOverlayPromptBlock(agencyRoleOverlay, { maxBullets: 4 }),
            iteration_delta: promptIterationDelta,
            output_contract: outputContractBlock,
            delivery_requirements: deliveryRequirementsBlock,
          },
          metadata: {
            runtime_instance_id: runtimeInstanceId || undefined,
            slot_id: slotId || undefined,
            scope_id: scopeId || undefined,
            agency_overlay_id: agencyRoleOverlay?.overlay_id || undefined,
            agency_overlay_title: agencyRoleOverlay?.display?.title || undefined,
          },
        },
      });
      rememberRecentAgentTurn({
        agentId: cleanAgentId,
        goal: cleanGoal,
        output: String(result?.output || ""),
        provider: String(result?.provider || "").trim().toLowerCase(),
        model: String(result?.model || "").trim(),
        runtimeInstanceId,
        slotId,
        scopeId,
      });
      try {
        const extractedIntents = extractContextWriteIntentsFromAgentResult({
          agentId: cleanAgentId,
          roleId: roleKey || cleanAgentId,
          goal: cleanGoal,
          result,
          preparedContext: activePreparedContext,
          deliveryRequirements: executionRequirements,
        });
        if (extractedIntents.length > 0) {
          commitContextWriteIntentsBatch(extractedIntents, {
            rootDir: process.cwd(),
            jobId,
            runDir: safeRunDir(jobId),
          });
        }
        const handoffDelta = buildHandoffDeltaFromAgentResult({
          agentId: cleanAgentId,
          roleId: roleKey || cleanAgentId,
          goal: cleanGoal,
          result,
          preparedContext: activePreparedContext,
        });
        if (handoffDelta?.delta?.output_summary) {
          appendHandoffDelta(handoffDelta, {
            rootDir: process.cwd(),
            jobId,
            runDir: safeRunDir(jobId),
          });
        }
      } catch {
        // Context-substrate writeback is best-effort; agent execution must remain on the hot path.
      }
      if (String(result?.output || "").trim()) {
        await sendLong(
          bot,
          chatId,
          buildAgentChatUpdateText({
            agentId: cleanAgentId,
            output: String(result.output || ""),
          })
        );
      }
      if (cleanAgentId) {
        updateAgentStatus(chatId, cleanAgentId, {
          state: "done",
          goal: cleanGoal,
          ended_at: new Date().toISOString(),
        });
        if (typeof onAgentStatusChanged === "function") {
          await onAgentStatusChanged({
            chatId,
            agentId: cleanAgentId,
            state: "done",
            goal: cleanGoal,
          });
        }
        if (runEventSink && typeof runEventSink.recordAgentEvent === "function") {
          await runEventSink.recordAgentEvent("run.agent_finish", {
            agent_id: cleanAgentId,
            role_id: roleKey || undefined,
            goal: cleanGoal,
            provider: String(result?.provider || "").trim().toLowerCase() || undefined,
            model: String(result?.model || "").trim() || undefined,
            output_chars: String(result?.output || "").length || 0,
            runtime_instance_id: runtimeInstanceId || undefined,
            slot_id: slotId || undefined,
            scope_id: scopeId || undefined,
          }, { jobId }).catch(() => null);
        }
      }
      if (executionGraph && cleanAgentId && stepNodeId && String(result?.output || "").trim()) {
        const currentRoutePlan = resolveCurrentRoutePlan();
        await executionGraph.attachArtifact(String(stepNodeId || "").trim(), {
          name: `artifact:${cleanAgentId}@${new Date().toISOString()}`,
          summary: clip(`${formatChatAgentDisplayName(cleanAgentId, buildTelegramAgentIndex({ runtime, routePlan: currentRoutePlan, actions: currentRoutePlan?.actions || [] }))} output`, 220),
          text: String(result.output || ""),
          uri: `ddalggak://jobs/${jobId}/agents/${cleanAgentId}/output`,
          payload: {
            kind: "agent_output",
            agent_id: cleanAgentId,
            provider: String(result?.provider || "").trim().toLowerCase() || undefined,
          },
        });
      }
      const artifactIndex = runtimeIo.loadArtifactIndex ? runtimeIo.loadArtifactIndex(jobId) : null;
      const artifactPaths = Array.isArray(artifactIndex?.artifacts)
        ? artifactIndex.artifacts.map((row) => String(row?.relative_path || row?.relativePath || row?.path || '').trim()).filter(Boolean)
        : [];
      const unmetExecutionRequirements = detectUnmetExecutionRequirements({
        requirements: executionRequirements,
        output: String(result?.output || ''),
        artifactPaths,
      });
      if (unmetExecutionRequirements.length > 0) {
        return {
          ...result,
          unmet_requirements: unmetExecutionRequirements,
          delivery_requirements: executionRequirements,
        };
      }
      return {
        ...result,
        delivery_requirements: executionRequirements,
      };
    } catch (e) {
      if (cleanAgentId) {
        updateAgentStatus(chatId, cleanAgentId, {
          state: "error",
          goal: cleanGoal,
          ended_at: new Date().toISOString(),
        });
        if (typeof onAgentStatusChanged === "function") {
          await onAgentStatusChanged({
            chatId,
            agentId: cleanAgentId,
            state: "error",
            goal: cleanGoal,
            error: String(e?.message ?? e),
          });
        }
        if (runEventSink && typeof runEventSink.recordAgentEvent === "function") {
          await runEventSink.recordAgentEvent("run.agent_error", {
            agent_id: cleanAgentId,
            role_id: roleKey || undefined,
            goal: cleanGoal,
            error: String(e?.message ?? e),
            runtime_instance_id: runtimeInstanceId || undefined,
            slot_id: slotId || undefined,
            scope_id: scopeId || undefined,
          }, { jobId }).catch(() => null);
        }
      }
      throw e;
    }
  };

  const runActionWithGraph = async ({
    action,
    detailContext = "",
    toolName = "",
    work,
    onSuccess = null,
    onError = null,
  }) => {
    const stepNodeId = executionGraph ? executionGraph.getStepNodeId(action) : "";
    const cleanToolName = String(toolName || action?.type || "action").trim().toLowerCase() || "action";
    const inputPreview = toolInputPreviewFromAction(action, detailContext);
    const defaultAgentId = String(action?.agent_id || action?.agent || "").trim().toLowerCase();
    const actionType = String(action?.type || "").trim().toLowerCase();
    const preparedContext = (actionType === "run_agent" || actionType === "spawn_agents")
      ? await prepareStepLensContext({
        agentId: defaultAgentId,
        goal: getActionGoalShared(action),
        lens: action?.lens && typeof action.lens === "object" ? action.lens : null,
        detailContext,
        stepNodeId,
        actionInputs: action?.inputs && typeof action.inputs === "object" ? action.inputs : null,
        runtimeInstanceId: String(action?.inputs?.runtime_instance_id || action?.inputs?.runtimeInstanceId || "").trim(),
        slotId: String(action?.inputs?.slot_id || action?.inputs?.slotId || "").trim(),
        scopeId: String(action?.inputs?.scope_id || action?.inputs?.scopeId || "").trim(),
      })
      : {
        final_prompt: "",
        context_info: buildSharedContextInfo({
          lensSpec: action?.lens || null,
          compiledText: String(runtime?.contextSummary || ""),
          lensContextSetId: sharedContextSetId || undefined,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
        }),
      };
    if (executionGraph && stepNodeId) {
      await executionGraph.markStepRunning(action, {
        extra: preparedContext?.context_info || {},
      });
    }
    const toolCall = executionGraph
      ? await executionGraph.startToolCall(stepNodeId, {
        toolName: cleanToolName,
        inputPreview,
        status: "running",
      })
      : null;
    const toolCallNodeId = String(toolCall?.id || "").trim();

    try {
      const result = await work({ stepNodeId, preparedContext });
      const outputPreview = outputPreviewFromResult(result);
      if (executionGraph && stepNodeId) {
        await executionGraph.finishToolCall(toolCallNodeId, {
          status: "done",
          outputPreview,
        });
        await executionGraph.recordToolResult({
          stepNodeId,
          toolCallNodeId,
          toolName: cleanToolName,
          outputPreview,
          status: "done",
        });
        await executionGraph.markStepDone(action, {
          output: outputPreview,
          extra: preparedContext?.context_info || {},
        });
      }
      if (typeof onSuccess === "function") {
        await onSuccess({ result, stepNodeId, outputPreview });
      }
      return result;
    } catch (e) {
      const errText = String(e?.message ?? e);
      if (executionGraph && stepNodeId) {
        await executionGraph.finishToolCall(toolCallNodeId, {
          status: "error",
          error: errText,
        });
        await executionGraph.recordToolResult({
          stepNodeId,
          toolCallNodeId,
          toolName: cleanToolName,
          outputPreview: errText,
          status: "error",
          error: errText,
        });
        await executionGraph.markStepError(action, e, {
          output: errText,
          extra: preparedContext?.context_info || {},
        });
      }
      if (typeof onError === "function") {
        await onError({ error: e, stepNodeId });
      }
      throw e;
    }
  };

  const runSpawnAgents = async ({ action, detailContext, parentStepNodeId = "" }) => {
    const children = Array.isArray(action?.agents) ? action.agents : [];
    if (children.length === 0) {
      return {
        summary: "spawn할 agent가 없습니다.",
        children: [],
      };
    }

    const limitRaw = Number(action?.max_parallel);
    const maxParallel = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_PARALLEL_PER_RUN, Math.floor(limitRaw)))
      : MAX_PARALLEL_PER_RUN;
    const parentAgentId = String(action?.parent_agent_id || action?.agent_id || "router").trim().toLowerCase() || "router";
    const childAgentIds = children
      .map((row) => String(row?.agent_id || "").trim().toLowerCase())
      .filter(Boolean);
    if (childAgentIds.length > 0) {
      const parentAgentLabel = formatRuntimeAgentDisplay(parentAgentId);
      const childAgentLabels = childAgentIds.map((id) => formatRuntimeAgentDisplay(id));
      await bot.sendMessage(
        chatId,
        `📣 ${parentAgentLabel} → ${childAgentLabels.join(", ")} (병렬)`,
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined
      );
    }
    const childSteps = executionGraph
      ? await executionGraph.createSpawnChildSteps({
        parentAction: action,
        children,
      })
      : [];
    const childStepByIndex = new Map(
      childSteps.map((row) => [Number(row.index), row])
    );

    const childResults = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxParallel, children.length) }, async () => {
      while (cursor < children.length) {
        const idx = cursor;
        cursor += 1;
        const child = children[idx];
        const agentId = String(child?.agent_id || "").trim().toLowerCase();
        const goal = String(child?.goal || "").trim();
        if (!agentId || !goal) continue;
        const childStep = childStepByIndex.get(idx);
        const childStepNodeId = String(childStep?.node_id || "").trim();
        const preparedContext = await prepareStepLensContext({
          agentId,
          goal,
          lens: (child?.lens && typeof child.lens === "object")
            ? child.lens
            : (action?.lens && typeof action.lens === "object" ? action.lens : null),
          detailContext,
          stepNodeId: childStepNodeId,
          actionInputs: child?.inputs && typeof child.inputs === "object" ? child.inputs : null,
          runtimeInstanceId: String(child?.inputs?.runtime_instance_id || child?.inputs?.runtimeInstanceId || "").trim(),
          slotId: String(child?.inputs?.slot_id || child?.inputs?.slotId || "").trim(),
          scopeId: String(child?.inputs?.scope_id || child?.inputs?.scopeId || "").trim(),
        });
        if (executionGraph && childStepNodeId) {
          await executionGraph.markStepNodeRunning(childStepNodeId, {
            extra: preparedContext?.context_info || {},
          });
        }
        const currentRoutePlan = resolveCurrentRoutePlan();
        const childToolCall = executionGraph
          ? await executionGraph.startToolCall(childStepNodeId, {
            toolName: "run_agent",
            inputPreview: clip(`${formatChatAgentDisplayName(agentId, buildTelegramAgentIndex({ runtime, routePlan: currentRoutePlan, actions: currentRoutePlan?.actions || [], extraSources: [{ actions: children }] }))} ${goal}`, 900),
            status: "running",
          })
          : null;
        const childToolCallNodeId = String(childToolCall?.id || "").trim();
        try {
          const result = await runSingleAgent({
            agentId,
            goal,
            detailContext,
            stepNodeId: childStepNodeId,
            preparedContext,
            actionInputs: child?.inputs && typeof child.inputs === "object" ? child.inputs : null,
            runtimeInstanceId: String(child?.inputs?.runtime_instance_id || child?.inputs?.runtimeInstanceId || "").trim(),
            slotId: String(child?.inputs?.slot_id || child?.inputs?.slotId || "").trim(),
            scopeId: String(child?.inputs?.scope_id || child?.inputs?.scopeId || "").trim(),
          });
          if (executionGraph && childStepNodeId) {
            const preview = outputPreviewFromResult(result);
            await executionGraph.finishToolCall(childToolCallNodeId, {
              status: "done",
              outputPreview: preview,
            });
            await executionGraph.recordToolResult({
              stepNodeId: childStepNodeId,
              toolCallNodeId: childToolCallNodeId,
              toolName: "run_agent",
              outputPreview: preview,
              status: "done",
            });
            await executionGraph.markStepNodeDone(childStepNodeId, {
              output: preview,
              extra: preparedContext?.context_info || {},
            });
          }
          childResults.push({
            agent_id: agentId,
            status: "ok",
            output: String(result?.output || ""),
            provider: String(result?.provider || ""),
            step_node_id: childStepNodeId || undefined,
          });
        } catch (e) {
          if (executionGraph && childStepNodeId) {
            const preview = String(e?.message ?? e);
            await executionGraph.finishToolCall(childToolCallNodeId, {
              status: "error",
              error: preview,
            });
            await executionGraph.recordToolResult({
              stepNodeId: childStepNodeId,
              toolCallNodeId: childToolCallNodeId,
              toolName: "run_agent",
              outputPreview: preview,
              status: "error",
              error: preview,
            });
            await executionGraph.markStepNodeError(childStepNodeId, e, {
              output: preview,
              extra: preparedContext?.context_info || {},
            });
          }
          childResults.push({
            agent_id: agentId,
            status: "error",
            error: String(e?.message ?? e),
            step_node_id: childStepNodeId || undefined,
          });
          if (isCancelledError(e)) throw e;
        }
      }
    });
    const settledWorkers = await Promise.allSettled(workers);
    for (const row of settledWorkers) {
      if (row.status === "rejected" && isCancelledError(row.reason)) {
        throw row.reason;
      }
    }

    const okCount = childResults.filter((row) => row.status === "ok").length;
    const errorCount = childResults.filter((row) => row.status === "error").length;
    if (executionGraph && parentStepNodeId) {
      const join = await executionGraph.createJoinStep({
        parentAction: action,
        childStepNodeIds: childResults.map((row) => String(row?.step_node_id || "").trim()).filter(Boolean),
        agentId: "router",
        goal: "병렬 실행 결과를 결합",
        summary: `spawn join ok=${okCount}, error=${errorCount}`,
      });
      const joinNodeId = String(join?.node_id || "").trim();
      if (joinNodeId) {
        await executionGraph.markStepNodeRunning(joinNodeId, {
          extra: {
            mode: "spawn_join",
          },
        });
        await executionGraph.markStepNodeDone(joinNodeId, {
          output: `ok=${okCount}, error=${errorCount}`,
          extra: {
            mode: "spawn_join",
          },
        });
      }
    }
    return {
      summary: `병렬 실행 완료: ok=${okCount}, error=${errorCount}`,
      children: childResults,
    };
  };

  return {
    runAgent: async ({ action, detailContext }) => {
      return await runActionWithGraph({
        action,
        detailContext,
        toolName: "run_agent",
        work: async ({ stepNodeId, preparedContext }) => {
          return await runSingleAgent({
            agentId: String(action.agent_id || "").trim().toLowerCase(),
            goal: String(action.goal || "").trim(),
            detailContext,
            stepNodeId,
            preparedContext,
            actionInputs: action?.inputs && typeof action.inputs === "object" ? action.inputs : null,
            runtimeInstanceId: String(action?.inputs?.runtime_instance_id || action?.inputs?.runtimeInstanceId || "").trim(),
            slotId: String(action?.inputs?.slot_id || action?.inputs?.slotId || "").trim(),
            scopeId: String(action?.inputs?.scope_id || action?.inputs?.scopeId || "").trim(),
          });
        },
      });
    },
    spawnAgents: async ({ action, detailContext }) => {
      return await runActionWithGraph({
        action,
        detailContext,
        toolName: "spawn_agents",
        work: async ({ stepNodeId }) => {
          return await runSpawnAgents({
            action,
            detailContext,
            parentStepNodeId: stepNodeId,
          });
        },
      });
    },
    toolProxyCall: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "tool_proxy_call",
        work: async () => {
          return await runToolProxyStep({ action, jobId, signal: controller?.signal || null, runtime, chatId });
        },
      });
    },
    proposeAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "propose_agent",
        work: async () => {
          return await createAgentDraftProposal(bot, chatId, userId, jobId, action);
        },
      });
    },
    createAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "create_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("create_agent requires MEMORY_MODE=goc");
          }
          const profile = action?.agent && typeof action.agent === "object" ? action.agent : {};
          const created = await withBoundGocActor(async () => {
            return await createAgentProfile(requireGocClient(), {
              baseDir: jobs.baseDir,
              profile,
              format: action?.format || "json",
              actor: `telegram:${userId}`,
            });
          });
          await refreshAgentRegistry({ includeCompiled: true });
          const createdId = String(profile.id || created?.created?.id || "").trim();
          const createdLabel = createdId ? formatRuntimeAgentDisplay(createdId) : "";
          return {
            agent_id: createdId,
            text: createdLabel ? `✅ agent 생성 완료: ${createdLabel}` : "✅ agent 생성 완료",
          };
        },
      });
    },
    updateAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "update_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("update_agent requires MEMORY_MODE=goc");
          }
          const targetAgentId = String(action?.agentId || "").trim().toLowerCase();
          const updated = await withBoundGocActor(async () => {
            return await updateAgentProfile(requireGocClient(), {
              baseDir: jobs.baseDir,
              agentId: targetAgentId,
              patch: action?.patch || {},
              format: action?.format || "json",
              actor: `telegram:${userId}`,
            });
          });
          await refreshAgentRegistry({ includeCompiled: true });
          const updatedLabel = targetAgentId ? formatRuntimeAgentDisplay(targetAgentId) : "";
          return {
            agent_id: targetAgentId || String(updated?.created?.id || "").trim(),
            text: updatedLabel ? `✅ agent 수정 완료: ${updatedLabel}` : "✅ agent 수정 완료",
          };
        },
      });
    },
    createAgentDefinition: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "create_agent_definition",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("create_agent_definition requires MEMORY_MODE=goc");
          }
          const rawSpec = action?.agent_spec && typeof action.agent_spec === "object"
            ? action.agent_spec
            : {};
          const spec = buildGocAgentCreateSpec(rawSpec);
          if (!spec.name) {
            throw new Error("create_agent_definition requires agent_spec.name");
          }
          let membershipTarget = null;
          const { created, createdId, addedToConversation, convRowsAfterAdd, addMutationResponse } = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.createAgent !== "function") {
              throw new Error("GoC createAgent API unavailable");
            }
            const created = await client.createAgent(spec);
            const createdId = String(created?.id || "").trim();
            let addedToConversation = false;
            let convRowsAfterAdd = null;
            let addMutationResponse = null;
            if (action?.add_to_conversation === true && runtime?.map?.threadId && createdId) {
              membershipTarget = await resolveMembershipTargetForThread(client, {
                threadId: runtime.map.threadId,
                jobId,
                source: "create_agent_definition",
                ensureConversation: true,
              });
              addMutationResponse = await client.addConversationAgent(membershipTarget, createdId, action?.enabled !== false);
              if (typeof client.listConversationAgents === "function") {
                convRowsAfterAdd = await client.listConversationAgents(membershipTarget);
              }
              addedToConversation = true;
            }
            return {
              created,
              createdId,
              addedToConversation,
              convRowsAfterAdd,
              addMutationResponse,
            };
          });
          const membershipChange = (action?.add_to_conversation === true && createdId)
            ? verifyConversationMembershipMutation({
              actionType: "add_agent_to_conversation",
              threadId: String(membershipTarget?.thread_id || runtime?.map?.threadId || "").trim(),
              conversationId: String(membershipTarget?.conversation_id || "").trim(),
              targetAgentId: createdId,
              expectedPresent: true,
              expectedEnabled: action?.enabled !== false,
              conversationRows: Array.isArray(convRowsAfterAdd) ? convRowsAfterAdd : [],
              source: "create_agent_definition",
              extra: {
                job_id: String(jobId || "").trim(),
                membership_target: membershipTarget ? summarizeMembershipTarget(membershipTarget) : undefined,
                ensured_thread_mismatch: membershipTarget?.ensured_thread_mismatch === true,
                mutation_response: summarizeMembershipMutationResponse(addMutationResponse),
              },
            })
            : null;
          if (membershipChange && membershipChange.confirmed !== true) {
            recordMembershipMutationDiagnostic(jobId, membershipChange, {
              stage: "membership_confirmation_failed",
            });
            throw createMembershipConfirmationError(membershipChange);
          }
          if (Array.isArray(convRowsAfterAdd)) {
            syncRuntimeConversationTeamState(runtime, {
              conversationRows: convRowsAfterAdd,
              membershipTarget,
              summarizeSelectionState,
            });
          }
          await refreshAgentRegistry({ includeCompiled: true });
          const createdName = String(created?.name || spec.name || "").trim() || "(unnamed)";
          const createdModel = String(created?.model || spec.model || "").trim() || "n/a";
          const createdLabel = createdId ? formatRuntimeAgentDisplay(createdId) : createdName;
          const createdTools = Array.isArray(created?.tools) && created.tools.length > 0
            ? created.tools
            : (Array.isArray(spec.tools) ? spec.tools : []);
          const toolsText = createdTools.length > 0 ? createdTools.join(", ") : "(none)";
          return {
            id: createdId,
            agent_id: createdId,
            name: createdName,
            model: createdModel,
            tools: createdTools,
            added_to_conversation: addedToConversation,
            membership_change: membershipChange || undefined,
            text: [
              "✅ agent definition 생성 완료",
              `- name: ${createdName}`,
              `- agent: ${createdLabel || "unknown"}`,
              `- model: ${createdModel}`,
              `- tools: ${toolsText}`,
              `- conversation 추가: ${addedToConversation ? "yes" : "no"}`,
            ].join("\n"),
          };
        },
      });
    },
    forkAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "fork_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("fork_agent requires MEMORY_MODE=goc");
          }
          const sourceId = String(action?.agent_id || "").trim().toLowerCase();
          if (!sourceId) throw new Error("fork_agent requires agent_id");
          const forkBody = {
            visibility: 'private',
            reason: String(action?.reason || '').trim() || undefined,
            purpose: String(action?.goal || '').trim() || undefined,
            scope: action?.scope && typeof action.scope === 'object' ? action.scope : undefined,
            scope_node_ids: Array.isArray(action?.scope_node_ids) ? action.scope_node_ids : undefined,
            source_surface_ids: Array.isArray(action?.source_surface_ids) ? action.source_surface_ids : undefined,
            publish_surface_ids: Array.isArray(action?.publish_surface_ids) ? action.publish_surface_ids : undefined,
            source_thread_id: String(action?.source_thread_id || '').trim() || undefined,
            source_run_id: String(action?.source_run_id || '').trim() || undefined,
            rejoin_strategy: String(action?.rejoin_strategy || '').trim().toLowerCase() || undefined,
          };
          const forked = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.forkAgent !== "function") {
              throw new Error("GoC forkAgent API unavailable");
            }
            return await client.forkAgent(sourceId, forkBody);
          });
          const forkedId = String(forked?.id || "").trim().toLowerCase();
          await refreshAgentRegistry({ includeCompiled: true });
          const sourceLabel = formatRuntimeAgentDisplay(sourceId);
          const forkedLabel = forkedId ? formatRuntimeAgentDisplay(forkedId) : "";
          return {
            id: forkedId,
            agent_id: forkedId,
            source_agent_id: sourceId,
            fork_operation_id: String(forked?.fork_operation_id || forked?.fork?.id || '').trim() || undefined,
            scope_mode: String(forked?.fork?.scope_mode || action?.scope?.mode || '').trim().toLowerCase() || undefined,
            reason: forkBody.reason,
            goal: forkBody.purpose,
            rejoin_strategy: forkBody.rejoin_strategy,
            publish_surface_ids: Array.isArray(forked?.fork?.publish_surface_ids) ? forked.fork.publish_surface_ids : (forkBody.publish_surface_ids || []),
            text: forkedLabel
              ? `✅ agent fork 완료: ${sourceLabel} -> ${forkedLabel}`
              : `✅ agent fork 요청 완료: ${sourceLabel}`,
          };
        },
      });
    },
    rejoinAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "rejoin_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("rejoin_agent requires MEMORY_MODE=goc");
          }
          const forkedId = String(action?.agent_id || '').trim().toLowerCase();
          if (!forkedId) throw new Error('rejoin_agent requires agent_id');
          const rejoined = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.rejoinAgent !== 'function') {
              throw new Error('GoC rejoinAgent API unavailable');
            }
            return await client.rejoinAgent(forkedId, {
              target_agent_id: String(action?.target_agent_id || '').trim().toLowerCase() || undefined,
              summary: String(action?.summary || '').trim() || undefined,
              publish_surface_ids: Array.isArray(action?.publish_surface_ids) ? action.publish_surface_ids : undefined,
              artifact_ids: Array.isArray(action?.artifact_ids) ? action.artifact_ids : undefined,
              include_recent_outputs: action?.include_recent_outputs !== false,
            });
          });
          return {
            agent_id: forkedId,
            source_agent_id: String(rejoined?.fork?.source_agent_id || rejoined?.source_agent_id || rejoined?.target_agent_id || '').trim().toLowerCase() || undefined,
            fork_operation_id: String(rejoined?.fork?.id || rejoined?.fork_operation_id || '').trim() || undefined,
            publish_surface_ids: Array.isArray(rejoined?.fork?.publish_surface_ids) ? rejoined.fork.publish_surface_ids : (Array.isArray(action?.publish_surface_ids) ? action.publish_surface_ids : []),
            summary: String(action?.summary || '').trim() || undefined,
            status: 'rejoined',
            text: String(rejoined?.message || '').trim() || `✅ agent rejoin 완료: ${formatRuntimeAgentDisplay(forkedId)}`,
          };
        },
      });
    },
    addAgentToConversation: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "add_agent_to_conversation",
        work: async () => {
          const agentId = String(action?.agent_id || "").trim().toLowerCase();
          if (!agentId) throw new Error("add_agent_to_conversation requires agent_id");
          const mutation = await withBoundGocActor(async () => await applyConversationAgentMutation({
            runtime,
            jobId,
            actionType: "add",
            agentId,
            enabled: action?.enabled !== false,
            source: "chat_executor_add_agent",
            summarizeSelectionState,
            recordDiagnostic: recordMembershipMutationDiagnostic,
          }));
          const agentDisplay = formatRuntimeAgentDisplay(agentId);
          return {
            agent_id: agentId,
            enabled_agents: runtime?.enabledAgentIds || [],
            membership_change: mutation?.verification || null,
            source: "conversation_agents",
            text: `✅ conversation에 ${agentDisplay} 추가 완료`,
          };
        },
      });
    },
    removeAgentFromConversation: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "remove_agent_from_conversation",
        work: async () => {
          const agentId = String(action?.agent_id || "").trim().toLowerCase();
          if (!agentId) throw new Error("remove_agent_from_conversation requires agent_id");
          const mutation = await withBoundGocActor(async () => await applyConversationAgentMutation({
            runtime,
            jobId,
            actionType: "remove",
            agentId,
            source: "chat_executor_remove_agent",
            summarizeSelectionState,
            recordDiagnostic: recordMembershipMutationDiagnostic,
          }));
          const agentDisplay = formatRuntimeAgentDisplay(agentId);
          return {
            agent_id: agentId,
            enabled_agents: runtime?.enabledAgentIds || [],
            membership_change: mutation?.verification || null,
            source: "conversation_agents",
            text: `🛑 conversation에서 ${agentDisplay} 제거 완료`,
          };
        },
      });
    },
    openContext: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "open_context",
        work: async () => {
          const target = action.scope === "global" ? "global" : jobId;
          const info = await buildContextInfo(target, { chatId, userId: currentTelegramUserId || undefined });
          return {
            scope: info.scope,
            link: info.link,
            text: info.lines.join("\n"),
          };
        },
      });
    },
    needMoreDetail: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "need_more_detail",
        work: async () => {
          if (!runtime.map?.ctxSharedId || memoryModeWithFallback() !== "goc") {
            throw new Error("need_more_detail requires MEMORY_MODE=goc");
          }
          const contextSetId = String(action.context_set_id || runtime.map.ctxSharedId).trim() || runtime.map.ctxSharedId;
          return await expandDetailContext({
            client: requireGocClient(),
            contextSetId,
            nodeIds: action.node_ids || [],
            depth: action.depth || 1,
            maxChars: action.max_chars || 7000,
          });
        },
      });
    },
    getStatus: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "get_status",
        work: async () => {
          return buildChatStatusCard(chatId, runtime);
        },
      });
    },
    interrupt: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "interrupt",
        work: async () => {
          const mode = String(action?.mode || "").trim().toLowerCase() === "cancel" ? "cancel" : "replan";
          requestChatInterrupt(chatId, {
            mode,
            reason: String(action?.note || "").trim(),
          });
          if (mode === "cancel") {
            chatSessionStore.upsert(chatId, {
              pending_user_messages: [],
              pending_approval: null,
              state: "idle",
            });
          }
          return {
            mode,
            text: mode === "cancel"
              ? "⛔️ 현재 실행을 중단했어요. 다음 지시를 주세요."
              : "🔄 현재 실행을 중단하고 새 지시로 재계획할게요.",
          };
        },
      });
    },
    summarize: async ({ action, results }) => {
      return await runActionWithGraph({
        action,
        toolName: "summarize",
        work: async () => {
          const okCount = results.filter((row) => row.status === "ok").length;
          const errorCount = results.filter((row) => row.status === "error").length;
          return { text: `실행 완료: ok=${okCount}, error=${errorCount}` };
        },
      });
    },
    searchPublicAgents: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "search_public_agents",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("search_public_agents requires MEMORY_MODE=goc");
          }
          const client = requireGocClient();
          const allBlueprints = await listPublicBlueprints(client);
          const filtered = filterPublicBlueprintCandidates(
            allBlueprints,
            action.query || "",
            action.limit || 5
          );
          chatSessionStore.upsert(chatId, {
            public_search_cache: filtered.map((row) => ({
              blueprint_id: row.blueprint_id,
              public_node_id: row.public_node_id,
              agent_id: row.agent_id,
              title: row.title,
              tags: row.tags,
              updated_at: new Date().toISOString(),
            })),
          });
          return { items: filtered, total: allBlueprints.length };
        },
      });
    },
    installAgentBlueprint: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "install_agent_blueprint",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("install_agent_blueprint requires MEMORY_MODE=goc");
          }
          if (!runtime.agentsSlot?.threadId || !runtime.agentsSlot?.ctxId) {
            throw new Error("agents thread/context is not ready");
          }
          const client = requireGocClient();
          const allBlueprints = await listPublicBlueprints(client);
          const byNode = new Map(allBlueprints.map((row) => [String(row.public_node_id || "").trim(), row]));
          const byBlueprintId = new Map(allBlueprints.map((row) => [String(row.blueprint_id || "").trim(), row]));
          const byAgentId = new Map(
            allBlueprints
              .map((row) => [String(row.agent_id || "").trim().toLowerCase(), row])
              .filter((entry) => entry[0])
          );

          let selected = null;
          const requestedNode = String(action.public_node_id || "").trim();
          const requestedBlueprint = String(action.blueprint_id || "").trim();
          const override = String(action.agent_id_override || "").trim().toLowerCase();
          if (requestedNode && byNode.has(requestedNode)) selected = byNode.get(requestedNode);
          if (!selected && requestedBlueprint && byBlueprintId.has(requestedBlueprint)) selected = byBlueprintId.get(requestedBlueprint);
          if (!selected && override && byAgentId.has(override)) selected = byAgentId.get(override);
          if (!selected) {
            const session = chatSessionStore.get(chatId);
            const cached = resolveInstallCandidateFromSession(session, action);
            if (cached?.public_node_id && byNode.has(cached.public_node_id)) {
              selected = byNode.get(cached.public_node_id);
            } else if (cached?.blueprint_id && byBlueprintId.has(cached.blueprint_id)) {
              selected = byBlueprintId.get(cached.blueprint_id);
            } else if (cached?.agent_id && byAgentId.has(cached.agent_id)) {
              selected = byAgentId.get(cached.agent_id);
            }
          }
          if (!selected && allBlueprints.length === 1) selected = allBlueprints[0];
          if (!selected) {
            throw new Error("설치할 blueprint를 특정하지 못했습니다. 먼저 public agent 검색 후 후보를 지정하세요.");
          }

          const installed = await installBlueprint(client, selected.resource || selected, {
            agentsThreadId: runtime.agentsSlot.threadId,
            ctxId: runtime.agentsSlot.ctxId,
            agentIdOverride: override || "",
          });
          await refreshAgentRegistry({ includeCompiled: true });
          tracking.append(jobId, "decisions", [
            "## /chat install_agent_blueprint",
            `- blueprint_id: ${installed.blueprint_id || selected.blueprint_id || "unknown"}`,
            `- public_node_id: ${installed.public_node_id || selected.public_node_id || "unknown"}`,
            `- installed_agent_id: ${installed.agent_id || "unknown"}`,
            `- created_node: ${installed.created?.id || "unknown"}`,
          ].join("\n"));
          return {
            ...installed,
            node_id: installed?.created?.id || "",
          };
        },
      });
    },
    publishAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "publish_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("publish_agent requires MEMORY_MODE=goc");
          }
          if (!runtime.agentsSlot?.threadId || !runtime.agentsSlot?.ctxId) {
            throw new Error("agents thread/context is not ready");
          }
          const client = requireGocClient();
          const targetAgentId = String(action.agent_id || "").trim().toLowerCase();
          if (targetAgentId && typeof client.publishAgent === "function") {
            const published = await client.publishAgent(targetAgentId, true);
            tracking.append(jobId, "decisions", [
              "## /chat publish_agent",
              `- agent_id: ${targetAgentId}`,
              `- published: ${published?.published === true ? "true" : "requested"}`,
              `- note: GoC agents catalog publish`,
            ].join("\n"));
            return {
              request_id: String(published?.id || targetAgentId),
              source_node_id: "",
              agent_id: targetAgentId,
            };
          }
          const targetNode = await findLatestAgentProfileNodeForPublish(
            client,
            runtime.agentsSlot,
            {
              agentNodeId: action.agent_node_id || "",
              agentId: action.agent_id || "",
            }
          );
          if (!targetNode?.id) {
            throw new Error("publish 대상 agent_profile node를 찾지 못했습니다.");
          }
          const request = await client.createPublishRequest(String(targetNode.id));
          tracking.append(jobId, "decisions", [
            "## /chat publish_agent",
            `- source_node_id: ${String(targetNode.id)}`,
            `- request_id: ${request.request_id || "unknown"}`,
            "- note: admin approval required",
          ].join("\n"));
          return request;
        },
      });
    },
    listAgents: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "list_agents",
        work: async () => {
          const result = await runConversationAgentTeamCommand({
            command: "list",
            runtime,
            jobId,
            source: "chat_executor_list_agents",
            agentRegistry,
            buildAgentDisplayIndex,
            formatAgentRef,
            refreshAgentRegistry,
            summarizeSelectionState,
            recordDiagnostic: recordMembershipMutationDiagnostic,
          });
          return { text: result.message };
        },
      });
    },
    listTools: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "list_tools",
        work: async () => {
          const enabled = normalizeCatalogIds(runtime.toolSelection?.enabled_ids || runtime.tools || []);
          const disabled = action?.include_disabled === false
            ? []
            : normalizeCatalogIds(runtime.toolSelection?.disabled_ids || []);
          const lines = ["현재 job tool 상태"];
          lines.push(enabled.length > 0
            ? `- enabled: ${enabled.join(", ")}`
            : "- enabled: (none)");
          if (action?.include_disabled !== false) {
            lines.push(disabled.length > 0
              ? `- disabled: ${disabled.join(", ")}`
              : "- disabled: (none)");
          }
          return { text: lines.join("\n") };
        },
      });
    },
    updateJobConfigSelection: async ({ action, op, kind, id }) => {
      return await runActionWithGraph({
        action,
        toolName: action?.type || "update_job_config_selection",
        work: async () => {
          const cleanKind = String(kind || "").trim().toLowerCase();
          const cleanOp = String(op || "").trim().toLowerCase();
          const cleanId = String(id || "").trim().toLowerCase();
          if (cleanKind === "agent" && ["enable", "disable"].includes(cleanOp) && cleanId) {
            const mutation = await withBoundGocActor(async () => await applyConversationAgentMutation({
              runtime,
              jobId,
              actionType: cleanOp,
              agentId: cleanId,
              source: "update_job_config_selection",
              summarizeSelectionState,
              recordDiagnostic: recordMembershipMutationDiagnostic,
            }));
            return {
              source: "conversation_agents",
              op: cleanOp,
              kind: cleanKind,
              id: cleanId,
              conversationAgents: mutation?.convRows || runtime.conversationAgents || [],
              enabledAgentIds: runtime.enabledAgentIds || [],
              membership_change: mutation?.verification || null,
              enabled_agent_ids: runtime.enabledAgentIds || [],
              enabled_tool_ids: runtime.enabledToolIds || [],
            };
          }

          if (memoryModeWithFallback() !== "goc") {
            throw new Error("tool selection update requires GoC mode");
          }
          const updated = await withBoundGocActor(async () => {
            return await updateJobConfigSelection(requireGocClient(), {
              jobId,
              op,
              kind,
              id,
              actor: `telegram:${userId}`,
              agentsCatalog: runtime.agentsCatalog || runtime.agents || [],
              toolsCatalog: runtime.toolsCatalog || runtime.tools || [],
            });
          });
          const normalized = normalizeSupervisorJobConfig(
            updated.config || {},
            {
              agentsCatalog: runtime.agentsCatalog || runtime.agents || [],
              toolsCatalog: runtime.toolsCatalog || runtime.tools || [],
            }
          );
          const enabledAgentSet = new Set(
            (Array.isArray(normalized.enabledAgentIds) ? normalized.enabledAgentIds : [])
              .map((entry) => String(entry || "").trim().toLowerCase())
              .filter(Boolean)
          );
          const enabledToolSet = new Set(
            (Array.isArray(normalized.enabledToolIds) ? normalized.enabledToolIds : [])
              .map((entry) => String(entry || "").trim().toLowerCase())
              .filter(Boolean)
          );
          runtime.jobConfig = normalized.configNormalized;
          runtime.enabledAgentIds = normalized.enabledAgentIds;
          runtime.enabledToolIds = normalized.enabledToolIds;
          runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
            .filter((agent) => enabledAgentSet.has(String(agent?.id || "").trim().toLowerCase()));
          runtime.tools = (Array.isArray(runtime.toolsCatalog) ? runtime.toolsCatalog : [])
            .filter((tool) => enabledToolSet.has(String(tool?.id || "").trim().toLowerCase()));
          runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
          runtime.toolSelection = summarizeSelectionState({ catalog: runtime.toolsCatalog || [], enabled: runtime.tools });
          return {
            ...updated,
            enabled_agent_ids: runtime.enabledAgentIds,
            enabled_tool_ids: runtime.enabledToolIds,
          };
        },
      });
    },
  };
}

async function runSupervisorChat(
  bot,
  chatId,
  userId,
  message,
  {
    debug = false,
    chatInfo = null,
    inputKind = "chat_message",
    telegramMessageId = null,
    userReplyToMessageId = null,
    forceMode = "normal",
    teamConfig = null,
    installAutoResumeDepth = 0,
  } = {}
) {
  const chatKey = String(chatId);
  const currentTurnStartedAtMs = Date.now();
  const verbose = !!(debug || CHAT_VERBOSE);
  const cleanForceMode = normalizeForceMode(forceMode);
  let currentJobId = resolveCurrentJobIdForChat(chatId);
  let createdNewJob = false;
  if (currentJobId) {
    try {
      runDir(currentJobId);
    } catch {
      currentJobId = "";
    }
  }
  if (!currentJobId) {
    const preflightTeamState = getSessionTeamState(chatSessionStore, chatId);
    const seedTeamConfig = preflightTeamState?.active_team && typeof preflightTeamState.active_team === 'object'
      ? preflightTeamState.active_team
      : null;
    const job = await createJob(message, { ownerUserId: userId, ownerChatId: chatId, teamConfig: seedTeamConfig });
    currentJobId = String(job.jobId);
    createdNewJob = true;
    if (memoryModeWithFallback() === "goc") {
      try {
        await loadSupervisorRuntime(currentJobId, {
          chatMeta: chatInfo,
          includeContext: false,
          includeGlobal: false,
          telegramUserId: userId,
        });
      } catch (e) {
        jobs.log(currentJobId, `conversation membership preload failed: ${String(e?.message ?? e)}`);
      }
    }
  }
  tracking.init(currentJobId);
  rememberLastChatJob(chatId, currentJobId);
  chatSessionStore.upsert(chatId, {
    jobId: currentJobId,
    state: "routing",
    pending_approval: null,
    interrupt: null,
    agent_status: {},
  });

  if (!createdNewJob) {
    jobs.appendConversation(currentJobId, "user", message, {
      kind: inputKind || "chat_message",
      chat_id: String(chatId || ""),
      user_id: String(userId || ""),
      telegram_message_id: telegramMessageId || undefined,
    });
  }
  try {
    recordUserFactEvents(runDir(currentJobId), message, {
      source: inputKind || "chat_message",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    jobs.log(currentJobId, `user fact extraction skipped: ${String(e?.message ?? e)}`);
  }

  const userMessageGoc = await appendChatMessageToGoc(currentJobId, {
    role: "user",
    text: message,
    kind: inputKind || "chat_message",
    chatId,
    userId,
  });

  const controller = resetJobAbortController(currentJobId);
  activeJobByChat.set(chatKey, currentJobId);
  let executionGraph = null;
  let runEventSink = null;
  let executionInsights = null;
  let executionFeedback = null;
  let runtime = null;
  let contextEngine = null;
  let finalAssistantText = "";
  let patternConflictState = null;
  let temporaryExecutionOverride = null;
  let patternRecoveryState = null;
  let pendingTeamApprovalNotice = '';
  const sessionAtStart = chatSessionStore.get(chatId);
  const chatRuntimeRulesBlock = formatChatRuntimeRulesBlock(sessionAtStart);
  let currentTurnAckMessageId = Number(sessionAtStart?.current_turn_ack_message_id || 0);
  if (!(Number.isFinite(currentTurnAckMessageId) && currentTurnAckMessageId > 0)) {
    currentTurnAckMessageId = Number(await sendRouterAckMessage(bot, chatId, {
      replyToMessageId: telegramMessageId,
    }) || 0);
  }

  try {
    runtime = await loadSupervisorRuntime(currentJobId, {
      chatMeta: chatInfo,
      telegramUserId: userId,
    });
    const { installedHarnessState } = bootstrapTelegramRuntimeSession({
      runtime,
      sessionStore: chatSessionStore,
      chatId,
      telegramUserId: userId,
      currentTurnId: currentJobId,
      jobId: currentJobId,
      runsDir: jobs?.runsDir || '',
      jobDir: runDir(currentJobId),
    });
    setRuntimeCurrentTurn(runtime, currentJobId);
    const lockedTeamState = await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime }).catch(() => getSessionTeamState(chatSessionStore, chatId));
    let activeTeamConfig = teamConfig && typeof teamConfig === 'object'
      ? teamConfig
      : (lockedTeamState?.active_team && typeof lockedTeamState.active_team === 'object' ? lockedTeamState.active_team : null);
    if (!activeTeamConfig) {
      if (isExplicitTeamConfigurationIntentMessage(message)) {
        throw new Error('이 요청은 team 구성을 직접 지정하는 성격입니다. /team suggest 또는 /team create 로 team을 먼저 정의해 주세요.');
      }
      const starterTeam = buildStarterSingleAgentTeamConfiguration({ taskText: message, runtime, source: 'chat_autostart' });
      storePendingTeam(chatSessionStore, chatId, starterTeam);
      activeTeamConfig = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime }).catch(() => starterTeam);
    }
    const normalizedActiveTeamConfig = validateTeamConfiguration(activeTeamConfig, { runtime });
    applyTeamConfigurationToRuntime(runtime, normalizedActiveTeamConfig);
    try {
      const kbSync = tracking.reconcileProfile(currentJobId, normalizedActiveTeamConfig.knowledge_base_profile || normalizedActiveTeamConfig.structure_v2?.knowledge_surface || {}, { migrate: true });
      if (kbSync?.migration?.changed) {
        const moved = Array.isArray(kbSync.migration.moved_slots) ? kbSync.migration.moved_slots : [];
        const created = Array.isArray(kbSync.migration.created_files) ? kbSync.migration.created_files : [];
        tracking.append(currentJobId, "decisions", [
          "## Knowledge base migration",
          `- profile: ${kbSync.profile?.profile_id || 'unknown'}`,
          ...(moved.length > 0 ? moved.map((row) => `- migrated ${row.doc_id}: ${row.from} -> ${row.to}`) : ["- migrated slots: none"]),
          ...(created.length > 0 ? [`- created files: ${created.join(', ')}`] : []),
        ].join("\n"));
      }
    } catch {}
    patternConflictState = detectPatternConflict({ message, teamConfig: normalizedActiveTeamConfig });
    temporaryExecutionOverride = patternConflictState?.override || null;
    patternRecoveryState = temporaryExecutionOverride
      ? buildPatternRecoveryState({
        originalPattern: normalizedActiveTeamConfig?.structure_v2?.topology?.pattern || runtime?.teamTopologyPattern || '',
        activePattern: temporaryExecutionOverride?.effective_pattern || runtime?.teamTopologyPattern || '',
        reason: patternConflictState?.reason || 'latest_user_interrupt_priority',
        status: 'temporary_override_active',
        recoveryPolicy: temporaryExecutionOverride?.recovery_policy || 'next_turn_retry',
      })
      : null;
    chatSessionStore.upsert(chatId, {
      pattern_conflict: patternConflictState?.classification && patternConflictState.classification !== 'no_conflict' ? patternConflictState : null,
      temporary_execution_override: temporaryExecutionOverride,
      pattern_recovery: patternRecoveryState,
    });
    if (patternConflictState?.classification === 'structure_override_required') {
      const refineDraftState = await maybeBuildStructureConflictRefineDraft({
        sessionStore: chatSessionStore,
        chatId,
        teamConfig: normalizedActiveTeamConfig,
        instruction: message,
        runtime,
      });
      const draftPreview = refineDraftState?.draft
        ? formatTeamProposalMessage(refineDraftState.draft).split('\n').slice(0, 12)
        : [];
      const structureConflictButtons = [];
      if (refineDraftState?.stored) structureConflictButtons.push({ text: '✅ Apply refine draft', callback_data: 'team_state:apply_pending' });
      if (refineDraftState?.draft) structureConflictButtons.push({ text: '👀 Show pending draft', callback_data: 'team_state:show_pending' });
      if (normalizedActiveTeamConfig) structureConflictButtons.push({ text: '📌 Show active team', callback_data: 'team_state:show_active' });
      const structureConflictOptions = {
        ...(Number.isFinite(Number(currentTurnAckMessageId)) ? { reply_to_message_id: Number(currentTurnAckMessageId) } : {}),
        ...(structureConflictButtons.length > 0 ? { reply_markup: { inline_keyboard: [structureConflictButtons] } } : {}),
      };
      await sendLong(bot, chatId, [
        '🧭 현재 요청은 active team의 구조 변경에 가깝습니다.',
        patternConflictState.reason,
        refineDraftState?.stored ? 'pending refine draft를 자동 생성했습니다. 버튼으로 바로 확인/적용하거나 /team refine 로 다시 조정할 수 있습니다.' : '',
        refineDraftState?.draft && !refineDraftState?.stored ? 'refine draft preview를 생성했지만 기존 pending team이 있어 자동 저장하지는 않았습니다.' : '',
        refineDraftState?.error ? `draft generation: ${refineDraftState.error}` : '',
        draftPreview.length > 0 ? '' : '',
        ...draftPreview,
        '',
        '이번 turn은 현재 team 안에서 최대한 처리합니다.',
      ].filter(Boolean).join('\n'), Object.keys(structureConflictOptions).length > 0 ? structureConflictOptions : undefined).catch(() => null);
    } else if (temporaryExecutionOverride) {
      await bot.sendMessage(
        chatId,
        [
          '↪️ 최신 유저 요청을 우선해 이번 turn에 한해 임시 execution override를 적용합니다.',
          ...summarizePatternConflictLines(patternConflictState),
          '- 팀 구조 자체는 유지됩니다. 계속 쓰려면 /team refine 로 반영하세요.',
        ].filter(Boolean).join('\n'),
        Number.isFinite(Number(currentTurnAckMessageId)) ? { reply_to_message_id: Number(currentTurnAckMessageId) } : undefined,
      ).catch(() => null);
    }
    await syncTeamConfigurationToConversationStore({ runtime, teamConfig: normalizedActiveTeamConfig, source: 'chat_runtime_bootstrap' }).catch(() => null);
    const runtimeCapabilities = runtime?.capabilities && typeof runtime.capabilities === "object"
      ? runtime.capabilities
      : composeCapabilitiesForRun({ jobId: currentJobId, runtime }).capabilities;
    runtime.capabilities = runtimeCapabilities;
    contextEngine = runtimeCapabilities?.contextStore || null;
    if (typeof contextEngine.setRuntime === "function") {
      contextEngine.setRuntime(runtime);
    }
    const runtimeAuthority = buildRunAuthority(runtime);
    executionGraph = (
      runtimeAuthority?.mode === "goc"
      && runtime?.map?.threadId
      && runtime?.map?.ctxSharedId
    )
      ? new GocExecutionGraphRecorder({
        client: requireGocClient(),
        threadId: runtime.map.threadId,
        contextSetId: runtime.map.ctxSharedId,
        sharedContextSetId: runtime.map.ctxSharedId,
        contextMeta: runtime.contextMeta || null,
        runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatId: String(chatId || ""),
        jobId: String(currentJobId || ""),
        logger: (line) => jobs.log(currentJobId, line),
        harnessPackage: installedHarnessState?.package_ref || null,
        runtimePolicy: resolveRuntimePolicyForRuntime(runtime, installedHarnessState?.runtime_policy || null),
      })
      : null;
    const currentRunId = String(executionGraph?.runId || '').trim() || undefined;
    runEventSink = runtimeCapabilities?.createRunEventSink
      ? runtimeCapabilities.createRunEventSink({ executionGraph, runtimePolicy: resolveRuntimePolicyForRuntime(runtime, installedHarnessState?.runtime_policy || null) })
      : null;
    runtime.runEventSink = runEventSink || null;
    runtime.run_event_sink = runEventSink || null;
    runtime.currentJobId = String(currentJobId || '').trim();
    runtime.current_job_id = String(currentJobId || '').trim();
    if (runEventSink && typeof runEventSink.startRun === "function") {
      await runEventSink.startRun({
        userMessageNodeId: String(userMessageGoc?.id || "").trim(),
        userText: message,
        metadata: {
          runtime_team_snapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
          harness_package_ref: installedHarnessState?.package_ref || undefined,
          ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
        },
      }, {
        jobId: currentJobId,
      });
    }
    let runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
    let continuousImprovementPolicy = runtimeExecutionPolicy.continuous_improvement || {};
    const checkpointPolicy = runtimeExecutionPolicy.checkpointing || {};
    let autopilotEnabled = AUTOPILOT_ENABLED || continuousImprovementPolicy.enabled === true;
    let maxTurns = continuousImprovementPolicy.enabled === true
      ? Number(continuousImprovementPolicy.max_turns || AUTOPILOT_MAX_TURNS || 1)
      : (autopilotEnabled ? AUTOPILOT_MAX_TURNS : 1);
    let maxTotalActions = continuousImprovementPolicy.enabled === true
      ? Number(continuousImprovementPolicy.max_total_actions || AUTOPILOT_MAX_TOTAL_ACTIONS || 4)
      : (autopilotEnabled ? AUTOPILOT_MAX_TOTAL_ACTIONS : 4);
    let activeWatchTaskContract = null;
    let activeWatchIteration = null;
    const callbacks = buildSupervisorExecutionCallbacks({
      bot,
      chatId,
      userId,
      jobId: currentJobId,
      runtime,
      controller,
      verbose,
      contextEngine,
      onAgentStatusChanged: async ({ agentId = "", state = "", goal = "", error = "" } = {}) => {
        await sendAgentStatusTransitionMessage(bot, chatId, {
          agentId,
          state,
          goal,
          error,
          replyToMessageId: getCurrentTurnReplyMessageId(chatId),
        });
      },
      executionGraph,
      runEventSink,
      getRoutePlan: () => routePlan,
    });

    let turn = 0;
    let totalActions = 0;
    let lastUserText = message;
    let routePlan = null;
    let execution = null;
    let followupHint = "";
    let stopReason = "done";
    let stalledTurns = 0;
    let previousRemainingSignature = "";
    let forcedAwaitReason = "";

    let deliverables = [];
    let completedDeliverables = [];
    let suggestedActions = [];
    let mergedResults = [];
    let mergedOutputs = [];
    let previousTurnFingerprint = '';
    const runThreadId = String(runtime?.map?.threadId || "").trim();
    const sharedCtxId = String(runtime?.map?.ctxSharedId || "").trim();

    let turnRuntimeTeamSnapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === 'object'
      ? runtime.runtimeTeamSnapshot
      : null;
    let turnAgentsCatalog = Array.isArray(runtime?.agents) ? runtime.agents : [];
    let turnEnabledAgentIds = Array.isArray(runtime?.enabledAgentIds) ? runtime.enabledAgentIds : [];
    if (temporaryExecutionOverride && turnRuntimeTeamSnapshot) {
      const overrideState = applyTemporaryExecutionOverrideToRuntimeSnapshot(turnRuntimeTeamSnapshot, temporaryExecutionOverride);
      if (overrideState?.applied) {
        turnRuntimeTeamSnapshot = overrideState.runtimeTeamSnapshot;
        runtime.runtimeTeamSnapshot = turnRuntimeTeamSnapshot;
        const targetIds = new Set((temporaryExecutionOverride?.target_participant_ids || []).map((row) => String(row || '').trim().toLowerCase()).filter(Boolean));
        if (targetIds.size > 0) {
          turnAgentsCatalog = turnAgentsCatalog.filter((agent) => targetIds.has(String(agent?.participant_id || agent?.id || agent?.agent_id || '').trim().toLowerCase()));
          turnEnabledAgentIds = turnEnabledAgentIds.filter((agentId) => targetIds.has(String(agentId || '').trim().toLowerCase()));
        }
      }
    }

    const shortcutCandidate = planAgentFollowupShortcut({
      message,
      session: sessionAtStart,
      runtime,
      teamConfig: normalizedActiveTeamConfig,
      replyToMessageId: getCurrentTurnReplyMessageId(chatId),
    });
    if (shortcutCandidate?.matched && shortcutCandidate?.action && (!temporaryExecutionOverride || (temporaryExecutionOverride.target_participant_ids || []).length === 0 || temporaryExecutionOverride.target_participant_ids.includes(String(shortcutCandidate.target_agent_id || '').trim().toLowerCase()))) {
      const runtimeTeamSnapshot = turnRuntimeTeamSnapshot && typeof turnRuntimeTeamSnapshot === "object"
        ? turnRuntimeTeamSnapshot
        : createRuntimeTeamSnapshot({
          source: "team_builder",
          runtimeAgents: Array.isArray(runtime?.runtimeTeamSnapshot?.runtime_agents) ? runtime.runtimeTeamSnapshot.runtime_agents : [],
        });
      const shortcutActions = decoratePlanActionsWithAgentMetadata([shortcutCandidate.action], runtime);
      routePlan = {
        reason: "direct_agent_followup_shortcut",
        action_source: "shortcut_followup",
        plan_source: "local_shortcut",
        actions: shortcutActions,
        done: true,
        await_user: false,
        deliverables: [],
        completed_deliverables: [],
        final_response_style: "concise",
        runtime_team_snapshot: runtimeTeamSnapshot,
        shortcut_followup: {
          target_agent_id: shortcutCandidate.target_agent_id,
          intent_score: shortcutCandidate?.intent?.score || 0,
          reason: shortcutCandidate.reason,
        },
      };
      chatSessionStore.upsert(chatId, {
        state: "executing",
        agent_status: buildQueuedAgentStatusFromActions(shortcutActions),
        last_route: {
          reason: routePlan.reason,
          action_source: routePlan.action_source,
          plan_source: routePlan.plan_source,
          actions: routePlan.actions,
          runtime_team_snapshot: runtimeTeamSnapshot,
          done: true,
          await_user: false,
          deliverables: [],
          completed_deliverables: [],
          followup_hint: undefined,
          turn: 0,
          total_actions: 1,
          final_response_style: "concise",
        },
      });
      if (runEventSink && typeof runEventSink.queueMainSteps === "function") {
        await runEventSink.queueMainSteps(shortcutActions, {
          metadata: {
            runtime_team_snapshot: runtimeTeamSnapshot,
            action_source: routePlan.action_source,
            ...buildRunAuthorityPatch(runtime),
          },
          jobId: currentJobId,
        }).catch(() => null);
      }
      const shortcutResult = await callbacks.runAgent({
        action: shortcutActions[0],
        detailContext: "",
      });
      mergedResults = [{
        label: chatActionLabel(shortcutActions[0], { agentIndex: buildTelegramAgentIndex({ runtime, routePlan, actions: routePlan.actions }) }),
        status: "ok",
        note: "shortcut_followup",
      }];
      mergedOutputs = [{
        agentId: String(shortcutCandidate.target_agent_id || "").trim().toLowerCase(),
        provider: String(shortcutResult?.provider || "").trim().toLowerCase(),
        mode: String(shortcutResult?.mode || ""),
        output: String(shortcutResult?.output || ""),
        jobId: String(currentJobId || ""),
      }];
      execution = {
        results: mergedResults,
        outputs: mergedOutputs,
        currentJobId: String(currentJobId || ""),
        pendingApproval: null,
        blocked_index: -1,
        remaining_actions: [],
      };
      stopReason = "direct_shortcut";
      tracking.append(currentJobId, "decisions", [
        "## /chat shortcut followup",
        `- message: ${clip(message, 220)}`,
        `- agent: ${String(shortcutCandidate.target_agent_id || "").trim().toLowerCase()}`,
        `- score: ${Number(shortcutCandidate?.intent?.score || 0)}`,
        `- reasons: ${(Array.isArray(shortcutCandidate?.intent?.reasons) ? shortcutCandidate.intent.reasons : []).join(", ") || "(none)"}`,
      ].join("\n"));
    }

    while (!execution && turn < maxTurns) {
      turn += 1;
      const runtimeAuthority = buildRunAuthority(runtime);
      const routerRunMeta = {
        runId: String(executionGraph?.runId || "").trim() || undefined,
        threadId: runThreadId,
        sharedContextSetId: sharedCtxId,
        ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
      };
      let routerCtx = {
        contextText: String(runtime?.contextSummary || "").trim(),
        meta: {},
      };
      if (contextEngine && typeof contextEngine.prepareRouterContext === "function") {
        if (typeof contextEngine.setRuntime === "function") {
          contextEngine.setRuntime(runtime);
        }
        await contextEngine.onRunStart({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          runMeta: routerRunMeta,
        }).catch(() => null);
        const preparedRouter = await contextEngine.prepareRouterContext({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          agentId: "router",
          stepKind: "router",
          goal: lastUserText,
          userMessageText: lastUserText,
          budgetTokens: 900,
          runMeta: routerRunMeta,
        }).catch(() => null);
        if (preparedRouter && typeof preparedRouter === "object") {
          routerCtx = {
            contextText: String(preparedRouter.contextText || "").trim(),
            meta: preparedRouter.meta && typeof preparedRouter.meta === "object"
              ? preparedRouter.meta
              : {},
          };
        }
        await contextEngine.recordMeta({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          agentId: "router",
          stepKind: "router",
          goal: lastUserText,
          userMessageText: lastUserText,
          runMeta: routerRunMeta,
          meta: routerCtx.meta,
        }).catch(() => {});
      }
      if (routerCtx.contextText) {
        runtime.contextSummary = routerCtx.contextText;
      }
      const progressSummary = buildAutopilotProgressSummary({
        turn,
        maxTurns,
        deliverables,
        completedDeliverables,
        results: mergedResults,
        outputs: mergedOutputs,
        suggestedActions,
        followupHint,
      });
      const teamRecommendation = runtime.activeTeamConfig
        ? {
          selected_existing_agents: (Array.isArray(turnAgentsCatalog) && turnAgentsCatalog.length > 0 ? turnAgentsCatalog : (Array.isArray(runtime.activeTeamConfig.agents) ? runtime.activeTeamConfig.agents : [])).map((agent) => ({
            role: agent.role,
            agent_id: agent.agent_id,
            name: agent.name,
            provider: agent.provider || '',
            model: agent.model || '',
            skills: Array.isArray(agent.attached_skill_ids) ? agent.attached_skill_ids : (Array.isArray(agent.skills) ? agent.skills : []),
            capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : (Array.isArray(agent.skills) ? agent.skills : []),
            purpose: agent.purpose || '',
            source: 'active_team',
            why: agent.purpose || 'configured team member',
          })),
          missing_capabilities: [],
          can_satisfy_without_creation: true,
          team_composition_intent: false,
          candidates: [],
        }
        : recommendTeamForTask(lastUserText, runtime);
      const selectedExistingAgents = Array.isArray(teamRecommendation?.selected_existing_agents)
        ? teamRecommendation.selected_existing_agents
        : [];
      const interpretedTask = interpretTask({
        goal: lastUserText,
        task: lastUserText,
        message: lastUserText,
        mode: 'run',
        preferredRoles: selectedExistingAgents.map((row) => String(row?.role || '').trim().toLowerCase()).filter(Boolean),
        registry: { agents: turnAgentsCatalog },
        toolHints: Array.isArray(runtime?.tools) ? runtime.tools.map((tool) => String(tool?.id || tool?.name || '').trim()).filter(Boolean) : [],
      });
      const existingRuntimeSnapshot = turnRuntimeTeamSnapshot && typeof turnRuntimeTeamSnapshot === 'object'
        ? turnRuntimeTeamSnapshot
        : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === 'object'
          ? runtime.runtime_team_snapshot
          : null);
      const fallbackTeamPlan = {
        mode: "chat_supervisor",
        roles: selectedExistingAgents
          .map((row) => ({
            id: String(row?.role || "").trim().toLowerCase(),
            role_type: String(row?.role || "").trim().toLowerCase(),
            role_label: String(row?.role || "").trim().toLowerCase(),
            template_id: String(row?.agent_id || "").trim().toLowerCase(),
            provider: String(row?.provider || "").trim().toLowerCase() || undefined,
            model: String(row?.model || "").trim() || undefined,
            assigned_goal: String(lastUserText || "").trim() || undefined,
            capability_tags: Array.isArray(row?.capabilities)
              ? row.capabilities
              : (Array.isArray(row?.skills) ? row.skills : []),
          }))
          .filter((row) => row.id),
        dependencies: [],
        execution_order: selectedExistingAgents
          .map((row) => String(row?.role || "").trim().toLowerCase())
          .filter(Boolean),
        reason: String(teamRecommendation?.can_satisfy_without_creation === true
          ? "selected_existing_agents"
          : "missing_capabilities").trim(),
        budget: {},
        task_interpretation: interpretedTask,
      };
      const fallbackRuntimeAgents = selectedExistingAgents
        .map((row) => ({
          instance_id: `chat_role_${String(row?.role || "").trim().toLowerCase() || "role"}_${String(row?.agent_id || "").trim().toLowerCase() || "ephemeral"}`,
          template_id: String(row?.agent_id || "").trim().toLowerCase() || undefined,
          display_label: String(row?.name || '').trim() || undefined,
          role_id: String(row?.role || '').trim().toLowerCase() || undefined,
          role_label: String(row?.role || "").trim().toLowerCase() || "role",
          provider: String(row?.provider || "").trim().toLowerCase() || undefined,
          model: String(row?.model || '').trim() || undefined,
          attached_skill_ids: Array.isArray(row?.skills) ? row.skills : [],
          assigned_goal: String(row?.purpose || lastUserText || "").trim() || undefined,
          capability_tags: Array.isArray(row?.capabilities)
            ? row.capabilities
            : (Array.isArray(row?.skills) ? row.skills : []),
          lens_spec: undefined,
          status: "ready",
          ephemeral: false,
          fallback: false,
        }));
      const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
        runtime_team_snapshot: {
          ...(existingRuntimeSnapshot && typeof existingRuntimeSnapshot === 'object' ? existingRuntimeSnapshot : {}),
          source: 'team_builder',
          generated_at: new Date().toISOString(),
          task_interpretation: interpretedTask,
          team_plan: (existingRuntimeSnapshot?.team_plan && typeof existingRuntimeSnapshot.team_plan === 'object')
            ? { ...existingRuntimeSnapshot.team_plan, task_interpretation: existingRuntimeSnapshot.team_plan.task_interpretation || interpretedTask }
            : fallbackTeamPlan,
          runtime_agents: Array.isArray(existingRuntimeSnapshot?.runtime_agents) && existingRuntimeSnapshot.runtime_agents.length > 0
            ? existingRuntimeSnapshot.runtime_agents
            : fallbackRuntimeAgents,
          runtime_authority: buildRunAuthority(runtime),
        },
      });
      const attachedSkillIds = [];
      for (const agent of Array.isArray(turnAgentsCatalog) ? turnAgentsCatalog : []) {
        for (const skillId of [
          ...(Array.isArray(agent?.attached_skill_ids) ? agent.attached_skill_ids : []),
          ...(Array.isArray(agent?.skills) ? agent.skills : []),
        ]) {
          const cleanSkillId = String(skillId || '').trim();
          if (cleanSkillId && !attachedSkillIds.includes(cleanSkillId)) attachedSkillIds.push(cleanSkillId);
        }
      }
      const autonomyDecision = scoreTaskAutonomy({
        userText: lastUserText,
        availableAgents: Math.max(1, (Array.isArray(turnEnabledAgentIds) && turnEnabledAgentIds.length > 0 ? turnEnabledAgentIds.length : (Array.isArray(turnAgentsCatalog) ? turnAgentsCatalog.length : 1))),
        attachedSkills: attachedSkillIds,
        traceStats: {
          prompt_chars: String(routerCtx.contextText || runtime.contextSummary || '').length,
          trace_count: Array.isArray(mergedOutputs) ? mergedOutputs.length : 0,
        },
        recentFailures: (Array.isArray(mergedResults) ? mergedResults : []).filter((row) => String(row?.status || '').toLowerCase() === 'error').length,
        memoryStats: {
          bytes: String(runtime.contextSummary || '').length + String(routerCtx.contextText || '').length,
          files: Array.isArray(runtime.contextDocs) ? runtime.contextDocs.length : 0,
        },
      });
      const typedMemoryNeeds = inferTypedMemoryNeeds({
        userText: lastUserText,
        currentTaskKind: String(interpretedTask?.task_kind || interpretedTask?.kind || '').trim(),
      });
      const autonomyPolicyHint = [
        'Autonomy decision:',
        `- score=${autonomyDecision.score}`,
        `- mode=${autonomyDecision.mode}`,
        `- reasons=${autonomyDecision.reasons.join(', ') || '(none)'}`,
        `- typed_memory=${typedMemoryNeeds.slots.map((slot) => `${slot.slot}:${slot.operation}`).join(', ') || '(none)'}`,
        'Use this as a quantitative hint, not as a hard override. Prefer single-agent unless score crosses threshold and enabled agents/skills exist.',
      ].join('\n');
      const rawRoutePlan = await routeWithSupervisor(lastUserText, {
        agents: turnAgentsCatalog,
        agentsCatalog: runtime.agentsCatalog,
        teamRecommendation,
        enabledAgentIds: turnEnabledAgentIds,
        teamLocked: runtime.teamLocked === true,
        teamCompositionMode: runtime.teamCompositionMode || runtime.activeTeamConfig?.composition_mode || 'structured',
        teamInteractionSpec: runtime.teamInteractionSpec || runtime.activeTeamConfig?.interaction_spec || null,
        tools: runtime.tools,
        jobConfig: runtime.jobConfig,
        currentJobId,
        currentContextSetId: sharedCtxId,
        progressSummary,
        suggestedActions,
        originalUserMessage: message,
        autopilotTurn: turn,
        workspaceRoot: runWorkspaceDir(currentJobId),
        cwd: runWorkspaceDir(currentJobId),
        signal: controller.signal,
        locale: "ko-KR",
        routerPolicy: [memory.getRouterPrompt(), chatRuntimeRulesBlock, autonomyPolicyHint].filter(Boolean).join('\n\n'),
        autonomyDecision,
        typedMemoryNeeds,
        contextSummary: routerCtx.contextText || runtime.contextSummary,
        geminiConcurrencyKey: `job:${String(currentJobId || "").trim()}`,
        onGeminiRetry: async ({ retryCount = 0, maxRetries = 0 } = {}) => {
          await runtimeUiHelpers.sendGeminiRetryMessage(bot, chatId, {
            retryCount,
            maxRetries,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
          resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
        });
        },
        onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
          await runtimeUiHelpers.sendGeminiModelSwitchMessage(bot, chatId, {
            toModel,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
          resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
        });
        },
        onGeminiGiveUp: async ({ reason = "" } = {}) => {
          await runtimeUiHelpers.sendGeminiGiveUpMessage(bot, chatId, {
            reason,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          getFallbackReplyId: () => getCurrentTurnReplyMessageId(chatId),
          resolveAgentLabel: (id) => formatChatAgentDisplayName(id, buildTelegramAgentIndex({ runtime })),
        });
        },
        runtimeTeamSnapshot,
        activeTeam: runtime?.activeTeamConfig || null,
      });
      routePlan = sanitizeSupervisorRoutePlan(rawRoutePlan, {
        message: lastUserText,
        agents: runtime.agents,
        allowReadOnlyControl: false,
        forceMode: cleanForceMode,
      });
      routePlan.team_locked = runtime.teamLocked === true;
      routePlan.autonomy_decision = autonomyDecision;
      routePlan.typed_memory_needs = typedMemoryNeeds;
      routePlan.interaction_spec = runtime.teamInteractionSpec || runtime.activeTeamConfig?.interaction_spec || null;
      let usedSuggestedActionsFallback = false;
      if (
        (!Array.isArray(routePlan?.actions) || routePlan.actions.length === 0)
        && routePlan?.done !== true
        && routePlan?.await_user !== true
        && Array.isArray(suggestedActions)
        && suggestedActions.length > 0
      ) {
        usedSuggestedActionsFallback = true;
        routePlan = {
          ...routePlan,
          reason: `${String(routePlan.reason || "supervisor route")}; suggested_actions_fallback`,
          actions: suggestedActions.slice(0, 4),
        };
      }
      routePlan = rewritePlanToReuseAgents(routePlan, runtime, {
        message: lastUserText,
        teamRecommendation,
      });
      routePlan = repairRoutePlanForTeamExecution(routePlan, {
        message: lastUserText,
        runtime,
        runtimeTeamSnapshot,
      });
      const routeActionSource = (
        usedSuggestedActionsFallback
        || String(routePlan?.reason || "").trim().toLowerCase().includes("fallback")
      )
        ? "default_fallback_route"
        : "explicit_route_plan";
      const routePlanSource = String(
        routePlan?.plan_source
        || runtime?.runtimeAuthority?.plan_source
        || runtime?.runtime_authority?.plan_source
        || "local"
      ).trim().toLowerCase() || "local";
      applyRunAuthority(runtime, {
        plan_source: routePlanSource,
      });
      runtime.runtimeTeamSnapshot = runtimeTeamSnapshot;
      if (temporaryExecutionOverride) routePlan = { ...routePlan, temporary_execution_override: temporaryExecutionOverride, pattern_conflict: patternConflictState };
      routePlan = {
        ...routePlan,
        runtime_team_snapshot: runtimeTeamSnapshot,
        action_source: routeActionSource,
        ...buildRunAuthorityPatch(runtime),
      };
      followupHint = String(routePlan?.followup_hint || "").trim();
      deliverables = normalizeDeliverableList([
        ...deliverables,
        ...(Array.isArray(routePlan?.deliverables) ? routePlan.deliverables : []),
      ], { max: 24 });
      completedDeliverables = normalizeDeliverableList([
        ...completedDeliverables,
        ...(Array.isArray(routePlan?.completed_deliverables) ? routePlan.completed_deliverables : []),
      ], { max: 24 });
      completedDeliverables = completedDeliverables.filter((entry) => {
        if (deliverables.length === 0) return true;
        return deliverables.some((item) => item.toLowerCase() === String(entry || "").trim().toLowerCase());
      });

      const planActions = decoratePlanActionsWithAgentMetadata(Array.isArray(routePlan?.actions) ? routePlan.actions : [], runtime)
        .map((action) => {
          if (!chatRuntimeRulesBlock || !action || typeof action !== 'object') return action;
          return {
            ...action,
            inputs: {
              ...(action.inputs && typeof action.inputs === 'object' ? action.inputs : {}),
              _runtime_rules_text: chatRuntimeRulesBlock,
            },
          };
        });
      routePlan = {
        ...routePlan,
        actions: planActions,
      };
      const workflowInstall = installWorkflowContractFromRoute(runtime, routePlan, { jobId: currentJobId, source: 'telegram_route_turn' });
      if (workflowInstall.changed) {
        runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
        continuousImprovementPolicy = runtimeExecutionPolicy.continuous_improvement || {};
        autopilotEnabled = AUTOPILOT_ENABLED || continuousImprovementPolicy.enabled === true;
        maxTurns = continuousImprovementPolicy.enabled === true
          ? Number(continuousImprovementPolicy.max_turns || AUTOPILOT_MAX_TURNS || 1)
          : (autopilotEnabled ? AUTOPILOT_MAX_TURNS : 1);
        maxTotalActions = continuousImprovementPolicy.enabled === true
          ? Number(continuousImprovementPolicy.max_total_actions || AUTOPILOT_MAX_TOTAL_ACTIONS || 4)
          : (autopilotEnabled ? AUTOPILOT_MAX_TOTAL_ACTIONS : 4);
      }
      const workflowContract = routePlan.team_workflow_contract
        || routePlan.teamWorkflowContract
        || routePlan.planner_metadata?.team_workflow_contract
        || routePlan.plannerMetadata?.teamWorkflowContract
        || routePlan.task_interpretation?.team_workflow_contract
        || routePlan.taskInterpretation?.teamWorkflowContract
        || runtime?.team_workflow_contract
        || runtime?.teamWorkflowContract
        || null;
      const watchInstall = ensureWatchTaskContract({
        jobDir: runDir(currentJobId),
        jobId: currentJobId,
        threadId: runThreadId,
        userText: message,
        workflowContract,
        runtimeExecutionPolicy,
        source: 'telegram_route_turn',
      });
      if (watchInstall?.contract) {
        activeWatchTaskContract = watchInstall.contract;
        activeWatchIteration = startWatchIteration({
          jobDir: runDir(currentJobId),
          contract: activeWatchTaskContract,
          userText: lastUserText,
          routePlan,
        });
        if (activeWatchIteration) {
          routePlan = {
            ...routePlan,
            watch_task_contract: activeWatchTaskContract,
            watch_iteration: activeWatchIteration,
          };
        }
        if (runThreadId) {
          try {
            const goc = requireGocClient();
            if (goc && typeof goc.recordWatchTask === 'function') {
              await goc.recordWatchTask(runThreadId, {
                source: 'ddalggak',
                run_id: currentJobId,
                contract: activeWatchTaskContract,
                iterations: activeWatchIteration ? [activeWatchIteration] : [],
              });
            }
          } catch (e) {
            jobs.log(currentJobId, `watch task GoC sync skipped: ${String(e?.message ?? e)}`);
          }
        }
      }
      if ((totalActions + planActions.length) > maxTotalActions) {
        forcedAwaitReason = `자동 실행 한도(${maxTotalActions} actions)에 도달했습니다.`;
        stopReason = "max_total_actions";
        break;
      }
      totalActions += planActions.length;

      if (runEventSink && typeof runEventSink.queueMainSteps === "function") {
        const runtimeAuthority = buildRunAuthority(runtime, {
          plan_source: String(routePlan?.plan_source || runtime?.runtimeAuthority?.plan_source || "local"),
        });
        await runEventSink.queueMainSteps(planActions, {
          metadata: {
            runtime_team_snapshot: runtimeTeamSnapshot,
            action_source: routeActionSource,
            ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
          },
          jobId: currentJobId,
        });
      }
      const queuedAgentStatus = buildQueuedAgentStatusFromActions(planActions);

      chatSessionStore.upsert(chatId, {
        state: "executing",
        agent_status: queuedAgentStatus,
        last_route: {
          reason: routePlan.reason,
          action_source: routePlan.action_source || routeActionSource,
          plan_source: routePlan.plan_source || runtime?.runtimeAuthority?.plan_source || "local",
          actions: planActions,
          runtime_team_snapshot: runtimeTeamSnapshot,
          runtime_authority: routePlan.runtime_authority || runtime?.runtimeAuthority || undefined,
          done: routePlan.done === true,
          await_user: routePlan.await_user === true,
          deliverables,
          completed_deliverables: completedDeliverables,
          followup_hint: followupHint || undefined,
          turn,
          total_actions: totalActions,
          final_response_style: routePlan.final_response_style || runtime.jobConfig?.final_response_style || "concise",
        },
      });
      const planPreviewMessageId = await sendPlanPreviewMessage(bot, chatId, {
        actions: planActions,
        replyToMessageId: currentTurnAckMessageId,
        activeTeam: runtime?.activeTeamConfig || null,
        runtimeTeamSnapshot,
        routeReason: routePlan.reason || "",
      });
      if (Number.isFinite(Number(planPreviewMessageId)) && Number(planPreviewMessageId) > 0) {
        chatSessionStore.upsert(chatId, {
          current_turn_plan_message_id: Number(planPreviewMessageId),
        });
      }

      if (verbose) {
        await bot.sendMessage(chatId, [
          `🧭 /chat(supervisor) route turn=${turn}`,
          `reason=${routePlan.reason || "(none)"}`,
          `done=${routePlan.done === true ? "true" : "false"}`,
          `await_user=${routePlan.await_user === true ? "true" : "false"}`,
          ...(planActions.map((row) => `- ${chatActionLabel(row)}`)),
        ].join("\n"));
      }

      if (routePlan.await_user === true && planActions.length === 0) {
        execution = {
          results: [],
          outputs: [],
          currentJobId: String(currentJobId || ""),
          pendingApproval: null,
          blocked_index: -1,
          remaining_actions: [],
        };
        stopReason = "await_user";
        break;
      }

      execution = await executeSupervisorActions({
        chatId,
        userId,
        jobId: currentJobId,
        plan: routePlan,
        originalUserText: message,
        forceMode: cleanForceMode,
        jobConfig: runtime.jobConfig,
        agents: Array.isArray(runtime?.agentsCatalog) && runtime.agentsCatalog.length > 0
          ? runtime.agentsCatalog
          : runtime.agents,
        tools: runtime.tools,
        sessionStore: chatSessionStore,
        callbacks,
      });
      const turnResults = Array.isArray(execution?.results) ? execution.results : [];
      const turnOutputs = Array.isArray(execution?.outputs) ? execution.outputs : [];
      const turnRemainingActions = Array.isArray(execution?.remaining_actions)
        ? execution.remaining_actions
        : [];
      const turnAwaitUserRequest = execution?.await_user_request && typeof execution.await_user_request === 'object'
        ? execution.await_user_request
        : null;
      if (turnAwaitUserRequest && !execution?.pendingApproval) {
        routePlan = {
          ...routePlan,
          await_user: true,
          done: false,
          followup_hint: String(turnAwaitUserRequest.followup_hint || routePlan?.followup_hint || '').trim() || routePlan?.followup_hint,
        };
        chatSessionStore.upsert(chatId, (session) => ({
          ...session,
          state: 'awaiting_user',
          pending_user_request: turnAwaitUserRequest,
          last_route: session?.last_route && typeof session.last_route === 'object'
            ? {
              ...session.last_route,
              await_user: true,
              followup_hint: String(turnAwaitUserRequest.followup_hint || session?.last_route?.followup_hint || '').trim() || session?.last_route?.followup_hint,
            }
            : session?.last_route || null,
        }));
      }
      mergedResults = [...mergedResults, ...turnResults];
      mergedOutputs = [...mergedOutputs, ...turnOutputs];

      const interruptedByReplan = wasInterruptedByReplan({
        results: turnResults,
        remainingActions: turnRemainingActions,
        pendingApproval: execution.pendingApproval,
      });
      if (turnRemainingActions.length > 0 && !execution.pendingApproval) {
        await markActionsSkipped(executionGraph, turnRemainingActions, {
          reason: interruptedByReplan ? "superseded_by_replan" : "superseded",
        });
      }

      const suggestedFromTurn = collectSuggestedActionsFromOutputs(turnOutputs);
      if (suggestedFromTurn.length > 0) {
        suggestedActions = mergeSuggestedActions(suggestedActions, suggestedFromTurn, { max: 16 });
      }
      completedDeliverables = updateCompletedDeliverablesFromOutputs(
        deliverables,
        completedDeliverables,
        turnOutputs
      );
      const activeStopSignals = collectActiveRouteSignals(mergedOutputs);
      if (activeWatchTaskContract) {
        const watchCompletion = completeWatchIteration({
          jobDir: runDir(currentJobId),
          contract: activeWatchTaskContract,
          iteration: activeWatchIteration,
          execution,
          routePlan,
          stopReason,
          stopSignals: activeStopSignals,
        });
        if (watchCompletion) {
          routePlan = { ...routePlan, watch_iteration_completion: watchCompletion };
          activeWatchTaskContract = {
            ...activeWatchTaskContract,
            current_iteration: watchCompletion.iteration,
            status: watchCompletion.status,
          };
          if (runThreadId) {
            try {
              const goc = requireGocClient();
              if (goc && typeof goc.recordWatchTask === 'function') {
                await goc.recordWatchTask(runThreadId, {
                  source: 'ddalggak',
                  run_id: currentJobId,
                  contract: activeWatchTaskContract,
                  iterations: [watchCompletion],
                });
              }
            } catch (e) {
              jobs.log(currentJobId, `watch iteration GoC sync skipped: ${String(e?.message ?? e)}`);
            }
          }
        }
      }
      const turnFingerprint = buildTurnDeltaFingerprint(turnOutputs);
      const syntheticStopSignals = [];
      if (continuousImprovementPolicy.enabled === true && routePlan.done === true && previousTurnFingerprint && turnFingerprint && previousTurnFingerprint === turnFingerprint) {
        syntheticStopSignals.push('no_further_delta');
      }
      if (turnFingerprint) previousTurnFingerprint = turnFingerprint;
      const matchedContinuousStopSignals = continuousStopSignalsMatched([...activeStopSignals, ...syntheticStopSignals], continuousImprovementPolicy);
      if (checkpointPolicy.enabled === true && checkpointPolicy.write_on_turn_end === true) {
        try {
          writeRuntimeCheckpointBundle({
            sharedDir: runSharedDir(currentJobId),
            jobId: currentJobId,
            stage: 'turn_end',
            trigger: execution.pendingApproval ? 'pending_approval' : 'turn_complete',
            userText: lastUserText,
            reason: String(routePlan?.reason || '').trim(),
            results: mergedResults,
            outputs: mergedOutputs,
            remainingActions: turnRemainingActions,
            pendingApproval: execution.pendingApproval || null,
            routePlan,
            continuousState: { turn, max_turns: maxTurns, stop_signals: matchedContinuousStopSignals },
          });
        } catch {}
      }
      const willStopAfterThisTurn = continuousImprovementPolicy.enabled === true
        && matchedContinuousStopSignals.length > 0
        && turn >= Number(continuousImprovementPolicy.min_turns || 1);
      if (continuousImprovementPolicy.enabled === true
        && continuousImprovementPolicy.progress_report_each_turn !== false
        && !willStopAfterThisTurn) {
        await bot.sendMessage(
          chatId,
          buildContinuousImprovementProgressMessage({
            turn,
            maxTurns,
            deliverables,
            completedDeliverables,
            stopSignals: matchedContinuousStopSignals,
          }),
          Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
            : undefined
        ).catch(() => null);
      }

      tracking.append(currentJobId, "decisions", [
        "## /chat supervisor routing",
        `- turn: ${turn}`,
        `- message: ${clip(lastUserText, 260)}`,
        `- reason: ${routePlan.reason || "(none)"}`,
        `- runtime_team_source: ${String(routePlan?.runtime_team_snapshot?.source || "team_builder")}`,
        `- action_source: ${String(routePlan?.action_source || routeActionSource || "explicit_route_plan")}`,
        ...(patternConflictState && patternConflictState.classification !== 'no_conflict' ? summarizePatternConflictLines(patternConflictState) : []),
        ...summarizeRunAuthorityLines(runtime, routePlan, {
          modeLabel: "capability_mode",
          fallbackReasonEmpty: "(none)",
        }),
        `- actions: ${planActions.map((row) => chatActionLabel(row)).join(" -> ") || "(none)"}`,
        turnAwaitUserRequest ? `- recovery_await_user: ${clip(String(turnAwaitUserRequest.reason || turnAwaitUserRequest.followup_hint || ''), 220)}` : '',
        `- mode: ${runtime.mode}`,
        `- pending_approval: ${execution.pendingApproval ? execution.pendingApproval.reason : "none"}`,
        `- done: ${routePlan.done === true ? "true" : "false"}`,
        `- await_user: ${routePlan.await_user === true ? "true" : "false"}`,
      ].join("\n"));

      if (execution.pendingApproval) {
        const pendingRows = Array.isArray(execution?.remaining_actions)
          ? execution.remaining_actions
          : [];
        await markActionsSkipped(executionGraph, pendingRows, {
          reason: "awaiting_approval",
        });
        if (checkpointPolicy.enabled === true && checkpointPolicy.write_on_approval_pause !== false) {
          try {
            const approvalCheckpoint = writeRuntimeCheckpointBundle({
              sharedDir: runSharedDir(currentJobId),
              jobId: currentJobId,
              stage: 'approval_pause',
              trigger: 'pending_approval',
              userText: lastUserText,
              reason: execution.pendingApproval.reason || 'awaiting approval',
              results: mergedResults,
              outputs: mergedOutputs,
              remainingActions: pendingRows,
              pendingApproval: execution.pendingApproval,
              routePlan,
              continuousState: { turn, max_turns: maxTurns },
            });
            const approvalCheckpointRef = summarizeRuntimeCheckpointRef(approvalCheckpoint);
            execution.pendingApproval.runtime_checkpoint = approvalCheckpointRef;
            const latestSession = chatSessionStore.get(chatId);
            if (latestSession?.pending_approval) {
              chatSessionStore.upsert(chatId, {
                pending_approval: {
                  ...latestSession.pending_approval,
                  runtime_checkpoint: approvalCheckpointRef,
                },
              });
            }
          } catch {}
        }
        stopReason = "pending_approval";
        break;
      }
      if (continuousImprovementPolicy.enabled === true
        && matchedContinuousStopSignals.length > 0
        && turn >= Number(continuousImprovementPolicy.min_turns || 1)) {
        stopReason = 'continuous_goal_met';
        break;
      }
      if (routePlan.await_user === true) {
        stopReason = "await_user";
        break;
      }
      if (routePlan.done === true && continuousImprovementPolicy.enabled !== true) {
        stopReason = "done";
        break;
      }
      if (routePlan.done === true && continuousImprovementPolicy.enabled === true) {
        if (turn >= maxTurns) {
          stopReason = 'max_turns';
          break;
        }
        if (!runtimeUiHelpers.useCompactProgressUpdates(false)) {
          await bot.sendMessage(
            chatId,
            '♻️ 결과를 더 끌어올리기 위해 self-refine를 계속합니다…',
            Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
              ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
              : undefined
          ).catch(() => null);
        }
        lastUserText = buildContinuousImprovementFollowup({
          originalUserText: message,
          followupHint,
          deliverables,
          completedDeliverables,
          stopSignals: matchedContinuousStopSignals,
          turn: turn + 1,
          maxTurns,
          customPrompt: String(continuousImprovementPolicy.self_refine_prompt || '').trim(),
        });
        continue;
      }

      if (!autopilotEnabled) {
        stopReason = "single_turn";
        break;
      }
      if (turn >= maxTurns) {
        stopReason = "max_turns";
        break;
      }

      const remaining = deliverables.filter((item) => {
        const key = String(item || "").trim().toLowerCase();
        return !completedDeliverables.some((doneItem) => String(doneItem || "").trim().toLowerCase() === key);
      });
      const remainingSignature = remaining
        .map((row) => String(row || "").trim().toLowerCase())
        .sort()
        .join("|");
      if (remaining.length > 0 && remainingSignature && remainingSignature === previousRemainingSignature) {
        stalledTurns += 1;
      } else {
        stalledTurns = 0;
      }
      previousRemainingSignature = remainingSignature;
      if (remaining.length > 0 && stalledTurns >= 1) {
        forcedAwaitReason = `남은 deliverable(${remaining.join(", ")}) 진행에 추가 지시가 필요합니다.`;
        stopReason = "stalled";
        break;
      }

      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(
          chatId,
          "🔄 다음 단계 진행 중…",
          Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
            : undefined
        );
      }
      lastUserText = buildAutopilotFollowupMessage({
        originalUserText: message,
        deliverables,
        completedDeliverables,
        followupHint,
        suggestedActions,
      });
    }

    routePlan = routePlan && typeof routePlan === "object"
      ? routePlan
      : {
        reason: "autopilot_no_route",
        actions: [],
        final_response_style: "concise",
        done: false,
        await_user: true,
        deliverables,
        completed_deliverables: completedDeliverables,
      };
    execution = execution && typeof execution === "object"
      ? execution
      : {
        results: [],
        outputs: [],
        currentJobId: String(currentJobId || ""),
        pendingApproval: null,
        blocked_index: -1,
        remaining_actions: [],
      };

    const mergedExecution = {
      ...execution,
      currentJobId: String(currentJobId || ""),
      results: mergedResults,
      outputs: mergedOutputs,
    };

    executionInsights = buildExecutionInsightSnapshot({
      runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
      actions: routePlan?.actions || [],
      outputs: mergedOutputs,
      recentTurns: chatSessionStore.get(chatId)?.recent_agent_turns || [],
      currentJobId,
    });
    executionFeedback = recordExecutionFeedback({
      jobDir: runDir(currentJobId),
      runId: String(executionGraph?.runId || '').trim(),
      executionInsights,
      runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
      status: mergedExecution.pendingApproval || routePlan.await_user === true ? 'await_user' : 'done',
    });
    recordTeamMotifFeedback({
      runsDir: jobs?.runsDir || '',
      jobDir: runDir(currentJobId),
      runId: String(executionGraph?.runId || '').trim(),
      goal: message,
      status: mergedExecution.pendingApproval || routePlan.await_user === true ? 'await_user' : 'done',
      plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
      runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
      executionInsights,
      executionFeedback,
    });
    const executionQualitySignals = buildExecutionQualitySignals({
      status: mergedExecution.pendingApproval || routePlan.await_user === true ? 'await_user' : 'done',
      routePlan,
      execution: mergedExecution,
      executionInsights,
      executionFeedback,
      runtime,
      runtimeSessionState: runtime?.runtimeSessionState || runtime?.runtime_session_state || null,
      capabilityGapCount: detectCapabilityGapsFromExecution(mergedExecution).length,
    });
    const channelVerification = recordChannelExperimentVerification({
      runsDir: jobs?.runsDir || '',
      jobDir: runDir(currentJobId),
      runEventSink: runtime?.runEventSink || runtime?.run_event_sink || null,
      jobId: String(currentJobId || ''),
      runId: String(executionGraph?.runId || '').trim(),
      goal: message,
      status: mergedExecution.pendingApproval || routePlan.await_user === true ? 'await_user' : 'done',
      runtimePolicy: runtime?.openharnessInstallState?.runtime_policy || runtime?.harnessRuntimePolicy || runtime?.runtimePolicy || null,
      runtimeBehavior: runtime?.runtimeBehavior || runtime?.runtime_behavior || null,
      plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
      runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
      executionInsights,
      executionFeedback,
      runtimeSessionState: runtime?.runtimeSessionState || runtime?.runtime_session_state || null,
      runtime,
      executionQualitySignals,
    });
    recordChannelPromotion({
      runsDir: jobs?.runsDir || '',
      jobDir: runDir(currentJobId),
      runEventSink: runtime?.runEventSink || runtime?.run_event_sink || null,
      jobId: String(currentJobId || ''),
      verificationRecord: channelVerification?.record || null,
      verificationSummary: channelVerification?.summary || null,
      runtimeBehavior: runtime?.runtimeBehavior || runtime?.runtime_behavior || null,
    });
    recordAdaptiveExecutionOutcome({
      runtime,
      status: mergedExecution.pendingApproval || routePlan.await_user === true ? 'await_user' : 'done',
      plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
      capabilityGapCount: detectCapabilityGapsFromExecution(mergedExecution).length,
      qualitySignals: executionQualitySignals,
    });

    let installProposalState = null;
    let autoInstallResumeRequest = null;
    let autoInstallResumeTeam = null;
    const existingPendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const compatibilityRecovery = inferCompatibilityFallbackState(routePlan);
    if (compatibilityRecovery) {
      patternRecoveryState = compatibilityRecovery;
      chatSessionStore.upsert(chatId, { pattern_recovery: compatibilityRecovery });
    }
    if (!mergedExecution.pendingApproval) {
      const teamStateForInstall = getSessionTeamState(chatSessionStore, chatId);
      installProposalState = buildInstallProposalStateFromExecution({
        team: normalizedActiveTeamConfig,
        runtime,
        execution: mergedExecution,
        applyState: teamStateForInstall?.pending_team ? 'active' : 'pending',
        resumeRequest: {
          message,
          input_kind: inputKind || 'chat_message',
          force_mode: cleanForceMode,
          telegram_message_id: telegramMessageId || null,
          user_reply_to_message_id: userReplyToMessageId || null,
          chat_info: chatInfo && typeof chatInfo === 'object' ? chatInfo : { chat_id: String(chatId || '') },
        },
        source: 'execution_gap',
      });
      if (installProposalState?.proposal?.gap_count > 0) {
        const automaticInstallAction = installAutoResumeDepth < 1
          ? resolveAutomaticInstallProposalAction(installProposalState)
          : null;
        if (automaticInstallAction) {
          const baseTeam = teamStateForInstall?.pending_team || teamStateForInstall?.active_team || normalizedActiveTeamConfig || teamConfig || null;
          if (baseTeam) {
            const patched = applyInstallProposalActionsToTeam(baseTeam, installProposalState.proposal || {}).team;
            storePendingTeam(chatSessionStore, chatId, patched);
            pendingTeamApprovalNotice = '🟡 필요한 team 변경을 pending으로 준비했습니다. 검토 후 /team apply confirm 으로 승인해 주세요.';
          }
          const appliedRuntimeSupport = autoInstallRuntimeSupport({ proposal: installProposalState.proposal || {}, jobs, jobId: currentJobId });
          if (runtime && typeof runtime === 'object' && Array.isArray(appliedRuntimeSupport) && appliedRuntimeSupport.length > 0) {
            const capabilityIds = new Set([...(Array.isArray(runtime.availableCapabilityIds) ? runtime.availableCapabilityIds : []), ...(Array.isArray(runtime.available_capability_ids) ? runtime.available_capability_ids : [])]);
            const toolIds = new Set([...(Array.isArray(runtime.availableToolIds) ? runtime.availableToolIds : []), ...(Array.isArray(runtime.available_tool_ids) ? runtime.available_tool_ids : [])]);
            for (const entry of appliedRuntimeSupport) {
              const capabilityId = String(entry?.capability_id || '').trim();
              const toolId = String(entry?.tool_id || '').trim();
              if (capabilityId) capabilityIds.add(capabilityId);
              if (toolId) toolIds.add(toolId);
            }
            runtime.availableCapabilityIds = [...capabilityIds];
            runtime.available_capability_ids = [...capabilityIds];
            runtime.availableToolIds = [...toolIds];
            runtime.available_tool_ids = [...toolIds];
          }
          setPendingInstallProposal(chatSessionStore, chatId, {
            ...installProposalState,
            status: 'installed_pending',
            apply_state: 'pending',
            summary: `${automaticInstallAction.message} · team approval required`,
          });
          autoInstallResumeRequest = null;
          autoInstallResumeTeam = null;
          installProposalState = null;
        } else {
          setPendingInstallProposal(chatSessionStore, chatId, installProposalState);
        }
      } else if (existingPendingInstallProposal?.source === 'execution_gap') {
        clearPendingInstallProposal(chatSessionStore, chatId, { preserveLast: true });
      }
    }

    if (autoInstallResumeRequest?.message) {
      await bot.sendMessage(
        chatId,
        'ℹ️ filesystem read 권한을 자동 활성화하고 같은 요청을 재개합니다.',
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined,
      );
      return runSupervisorChat(bot, chatId, userId, autoInstallResumeRequest.message, {
        debug,
        chatInfo: autoInstallResumeRequest.chat_info && typeof autoInstallResumeRequest.chat_info === 'object'
          ? autoInstallResumeRequest.chat_info
          : (chatInfo && typeof chatInfo === 'object' ? chatInfo : { chat_id: String(chatId || '') }),
        inputKind: autoInstallResumeRequest.input_kind || 'install_auto_resume',
        telegramMessageId: autoInstallResumeRequest.telegram_message_id || telegramMessageId || null,
        userReplyToMessageId: autoInstallResumeRequest.user_reply_to_message_id || userReplyToMessageId || null,
        forceMode: normalizeForceMode(autoInstallResumeRequest.force_mode || cleanForceMode),
        teamConfig: autoInstallResumeTeam || getSessionTeamState(chatSessionStore, chatId)?.active_team || teamConfig,
        installAutoResumeDepth: installAutoResumeDepth + 1,
      });
    }

    if (forcedAwaitReason && !mergedExecution.pendingApproval) {
      routePlan = {
        ...routePlan,
        done: false,
        await_user: true,
        followup_hint: forcedAwaitReason,
      };
    }

    if (mergedExecution.pendingApproval) {
      const pendingApproval = {
        ...mergedExecution.pendingApproval,
        action_source: String(routePlan?.action_source || "explicit_route_plan").trim() || "explicit_route_plan",
        plan_source: String(routePlan?.plan_source || runtime?.runtimeAuthority?.plan_source || "local").trim().toLowerCase() || "local",
        runtime_team_snapshot: routePlan?.runtime_team_snapshot && typeof routePlan.runtime_team_snapshot === "object"
          ? routePlan.runtime_team_snapshot
          : undefined,
        ...buildRunAuthorityPatch(
          routePlan?.runtime_authority
            ? { runtime_authority: routePlan.runtime_authority }
            : runtime
        ),
        blocked_index: Number.isFinite(Number(mergedExecution.blocked_index))
          ? Number(mergedExecution.blocked_index)
          : Number(mergedExecution.pendingApproval?.blocked_index ?? -1),
        remaining_actions: Array.isArray(mergedExecution.remaining_actions)
          ? mergedExecution.remaining_actions
          : (Array.isArray(mergedExecution.pendingApproval?.remaining_actions)
            ? mergedExecution.pendingApproval.remaining_actions
            : []),
        already_done: {
          results: mergedResults,
          outputs: mergedOutputs,
        },
      };
      chatSessionStore.upsert(chatId, {
        jobId: currentJobId,
        state: "awaiting_approval",
        pending_approval: pendingApproval,
      });
      mergedExecution.pendingApproval = pendingApproval;
      tracking.append(currentJobId, "decisions", [
        "## /chat approval required",
        `- reason: ${pendingApproval.reason}`,
        `- action: ${String(pendingApproval?.action_display_label || "").trim() || chatActionLabel(pendingApproval.action)}`,
      ].join("\n"));
    }

    const contextOutputs = (Array.isArray(mergedExecution.outputs) ? mergedExecution.outputs : [])
      .filter((row) => String(row?.mode || "") === "context_link")
      .map((row) => String(row?.output || "").trim())
      .filter(Boolean);
    const hasAgentOutput = (Array.isArray(mergedExecution.outputs) ? mergedExecution.outputs : [])
      .some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
    const pendingPrompt = mergedExecution.pendingApproval?.id
      ? buildPendingApprovalPrompt(mergedExecution.pendingApproval)
      : null;
    const isMutatingConfirm = String(mergedExecution.pendingApproval?.gate_type || "").trim().toLowerCase() === "mutating_confirm";
    const finalReply = isMutatingConfirm
      ? String(pendingPrompt?.text || "변경 적용 전 확인이 필요합니다.")
      : (routePlan.await_user === true && mergedOutputs.length === 0
        ? String(routePlan.followup_hint || forcedAwaitReason || "다음 진행을 위해 추가 입력이 필요합니다.")
        : ((!hasAgentOutput && contextOutputs.length > 0)
          ? contextOutputs.join("\n\n")
          : await synthesizeChatReply(message, routePlan, mergedExecution)));
    let replyText = mergedExecution.pendingApproval
      ? (isMutatingConfirm
        ? finalReply
        : `${finalReply}\n\n⚠️ 승인 필요: ${mergedExecution.pendingApproval.reason}\n다음 명령으로 risk를 낮추거나 요청을 분할해 주세요.`)
      : finalReply;

    if (!mergedExecution.pendingApproval && pendingTeamApprovalNotice) {
      replyText = `${replyText}

${pendingTeamApprovalNotice}`.trim();
    }

    if (!mergedExecution.pendingApproval && routePlan.await_user === true) {
      const hint = String(routePlan.followup_hint || forcedAwaitReason || "").trim();
      if (hint) {
        replyText = `${replyText}\n\n🧩 추가 입력 필요: ${hint}`;
      }
    }

    if (!mergedExecution.pendingApproval) {
      replyText = appendResponseModelBadge(replyText, { routePlan, execution: mergedExecution });
    }

    if (verbose) {
      await sendLong(bot, chatId, formatChatSummary(routePlan, mergedExecution.results));
      await bot.sendMessage(chatId, `autopilot_stop_reason=${stopReason}`);
    }
    const assistantReplyMessages = [];
    finalAssistantText = replyText;
    if (!isMutatingConfirm) {
      assistantReplyMessages.push(...(await sendLong(bot, chatId, replyText)));
    }
    jobs.appendConversation(currentJobId, "assistant", replyText, {
      kind: mergedExecution.pendingApproval ? "chat_reply_pending_approval" : "chat_reply",
      chat_id: String(chatId || ""),
      user_id: String(userId || ""),
    });
    await appendChatMessageToGoc(currentJobId, {
      role: "assistant",
      text: replyText,
      kind: mergedExecution.pendingApproval ? "chat_reply_pending_approval" : "chat_reply",
      chatId,
      userId,
      replyTo: String(userMessageGoc?.id || "").trim(),
    });
    if (runEventSink && typeof runEventSink.finishRun === "function") {
      const resultRows = Array.isArray(mergedExecution.results) ? mergedExecution.results : [];
      const errorCount = resultRows.filter((row) => String(row?.status || '').trim().toLowerCase() === 'error').length;
      const blockedCount = resultRows.filter((row) => ['blocked', 'skip'].includes(String(row?.status || '').trim().toLowerCase())).length;
      if (typeof runEventSink.updateRunMetadata === 'function') {
        await runEventSink.updateRunMetadata({
          runtime_team_snapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
          execution_insights: executionInsights || undefined,
          execution_feedback: executionFeedback?.summary || undefined,
          ...buildRunAuthorityPatch(runtime),
        }, {
          jobId: currentJobId,
        }).catch(() => null);
      }
      await runEventSink.finishRun({
        status: (mergedExecution.pendingApproval || routePlan.await_user === true)
          ? "await_user"
          : ((errorCount > 0 && !hasAgentOutput)
            ? "error"
            : "done"),
        summary: clip(replyText || (blockedCount > 0 ? 'run finished with blocked steps' : 'run finished'), 900),
        result_summary: {
          errors: errorCount,
          blocked: blockedCount,
          outputs: Array.isArray(mergedExecution.outputs) ? mergedExecution.outputs.length : 0,
        },
      }, {
        jobId: currentJobId,
      });
    }
    if (mergedExecution.pendingApproval?.id) {
      const prompt = pendingPrompt || buildPendingApprovalPrompt(mergedExecution.pendingApproval);
      const promptMessage = await bot.sendMessage(
        chatId,
        prompt.text,
        {
          reply_to_message_id: Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? Number(getCurrentTurnReplyMessageId(chatId))
            : undefined,
          reply_markup: {
            inline_keyboard: prompt.keyboard,
          },
        }
      );
      if (promptMessage) assistantReplyMessages.push(promptMessage);
    } else if (installProposalState?.proposal?.gap_count > 0) {
      const installPrompt = buildInstallProposalPrompt(installProposalState, { hasPendingTeam: !!getSessionTeamState(chatSessionStore, chatId)?.pending_team, chatId, sessionStore: chatSessionStore });
      if (installPrompt?.text) {
        const installMessage = await bot.sendMessage(
          chatId,
          installPrompt.text,
          {
            reply_to_message_id: Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
              ? Number(getCurrentTurnReplyMessageId(chatId))
              : undefined,
            reply_markup: {
              inline_keyboard: installPrompt.keyboard,
            },
          }
        );
        if (installMessage) assistantReplyMessages.push(installMessage);
      }
    }
    const capsules = buildAnswerCapsules({
      telegramMessages: assistantReplyMessages,
      replyToMessageId: userReplyToMessageId,
      runId: currentRunId,
      jobId: currentJobId,
      routePlan,
      execution: mergedExecution,
      replyText,
      originalGoal: message,
    });
    if (capsules.length > 0) {
      replyAnchorStore.append(chatId, capsules);
    }
    await maybeSendArtifactSummary(bot, chatId, currentJobId, {
      execution: mergedExecution,
      replyToMessageId: getCurrentTurnReplyMessageId(chatId),
      sinceMs: currentTurnStartedAtMs,
    }).catch(() => null);
    return { routePlan, execution: mergedExecution, jobId: currentJobId };
  } catch (e) {
    if (runEventSink && typeof runEventSink.finishRun === "function") {
      try {
        await runEventSink.finishRun({
          status: "error",
          error: String(e?.message ?? e),
          summary: "supervisor run failed",
        }, {
          jobId: currentJobId,
        });
      } catch {}
    } else if (memoryModeWithFallback() === "goc") {
      try {
        const runtime = await loadSupervisorRuntime(currentJobId, {
          chatMeta: chatInfo,
          telegramUserId: userId,
        });
        if (runtime?.map?.ctxSharedId) {
          try {
            const meta = await requireGocClient().getContextSet(runtime.map.ctxSharedId);
            runtime.contextMeta = {
              context_set_id: runtime.map.ctxSharedId,
              version: String(meta?.version || "").trim(),
              active_node_ids: Array.isArray(meta?.activeNodeIds)
                ? meta.activeNodeIds.map((row) => String(row || "").trim()).filter(Boolean)
                : [],
            };
          } catch {
            runtime.contextMeta = null;
          }
        }
        if (runtime?.map?.threadId && runtime?.map?.ctxSharedId) {
          executionGraph = new GocExecutionGraphRecorder({
            client: requireGocClient(),
            threadId: runtime.map.threadId,
            contextSetId: runtime.map.ctxSharedId,
            sharedContextSetId: runtime.map.ctxSharedId,
            contextMeta: runtime.contextMeta || null,
            runId: `run_err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            chatId: String(chatId || ""),
            jobId: String(currentJobId || ""),
            logger: (line) => jobs.log(currentJobId, line),
            harnessPackage: runtime?.openharnessInstallState?.package_ref || runtime?.harnessPackageRef || null,
          });
          await executionGraph.startRun({
            userMessageNodeId: String(userMessageGoc?.id || "").trim(),
            userText: message,
            metadata: {
              runtime_team_snapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
                ? runtime.runtimeTeamSnapshot
                : undefined,
              harness_package_ref: runtime?.openharnessInstallState?.package_ref || runtime?.harnessPackageRef || undefined,
              harness_runtime_policy: runtime?.openharnessInstallState?.runtime_policy || runtime?.harnessRuntimePolicy || undefined,
              ...buildRunAuthorityPatch(runtime),
            },
          });
          await executionGraph.finishRun({
            status: "error",
            error: String(e?.message ?? e),
            summary: "supervisor run failed",
          });
        }
      } catch {}
    }
    try {
      recordTeamMotifFeedback({
        runsDir: jobs?.runsDir || '',
        jobDir: currentJobId ? runDir(currentJobId) : '',
        runId: String(executionGraph?.runId || '').trim(),
        goal: message,
        status: 'error',
        plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
        runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
        executionInsights,
        executionFeedback,
      });
      const executionQualitySignals = buildExecutionQualitySignals({
        status: 'error',
        routePlan,
        execution,
        executionInsights,
        executionFeedback,
        runtime,
        runtimeSessionState: runtime?.runtimeSessionState || runtime?.runtime_session_state || null,
        capabilityGapCount: detectCapabilityGapsFromExecution(execution || {}).length,
      });
      const channelVerification = recordChannelExperimentVerification({
        runsDir: jobs?.runsDir || '',
        jobDir: currentJobId ? runDir(currentJobId) : '',
        runEventSink: runtime?.runEventSink || runtime?.run_event_sink || null,
        jobId: String(currentJobId || ''),
        runId: String(executionGraph?.runId || '').trim(),
        goal: message,
        status: 'error',
        runtimePolicy: runtime?.openharnessInstallState?.runtime_policy || runtime?.harnessRuntimePolicy || runtime?.runtimePolicy || null,
        runtimeBehavior: runtime?.runtimeBehavior || runtime?.runtime_behavior || null,
        plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
        runtimeTeamSnapshot: routePlan?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || runtime?.runtime_team_snapshot || null,
        executionInsights,
        executionFeedback,
        runtimeSessionState: runtime?.runtimeSessionState || runtime?.runtime_session_state || null,
        runtime,
        executionQualitySignals,
      });
      recordChannelPromotion({
        runsDir: jobs?.runsDir || '',
        jobDir: currentJobId ? runDir(currentJobId) : '',
        runEventSink: runtime?.runEventSink || runtime?.run_event_sink || null,
        jobId: String(currentJobId || ''),
        verificationRecord: channelVerification?.record || null,
        verificationSummary: channelVerification?.summary || null,
        runtimeBehavior: runtime?.runtimeBehavior || runtime?.runtime_behavior || null,
      });
      recordAdaptiveExecutionOutcome({
        runtime,
        status: 'error',
        plannerMetadata: routePlan?.runtime_team_snapshot?.team_plan?.planner_metadata || routePlan?.runtime_team_snapshot?.team_plan?.plannerMetadata || routePlan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.planner_metadata || runtime?.runtimeTeamSnapshot?.team_plan?.plannerMetadata || runtime?.plannerMetadata || null,
        capabilityGapCount: detectCapabilityGapsFromExecution(execution || {}).length,
        qualitySignals: executionQualitySignals,
      });
    } catch {}
    throw e;
  } finally {
    if (contextEngine && typeof contextEngine.onRunEnd === "function") {
      const runThreadId = String(runtime?.map?.threadId || "").trim();
      const sharedCtxId = String(runtime?.map?.ctxSharedId || "").trim();
      if (typeof contextEngine.setRuntime === "function") {
        contextEngine.setRuntime(runtime);
      }
      await contextEngine.onRunEnd({
        jobId: currentJobId,
        chatId: String(chatId || ""),
        threadId: runThreadId,
        lastUserText: message,
        lastAssistantText: finalAssistantText,
        runMeta: {
          runId: String(executionGraph?.runId || "").trim() || undefined,
          threadId: runThreadId,
          sharedContextSetId: sharedCtxId,
          ...buildRunAuthorityPatch(runtime),
        },
      }).catch(() => null);
    }
    if (activeJobByChat.get(chatKey) === currentJobId) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(currentJobId);
    chatSessionStore.upsert(chatId, (session) => ({
      ...session,
      last_route: session?.last_route && typeof session.last_route === "object"
        ? {
          ...session.last_route,
          execution_insights: executionInsights,
          execution_feedback: executionFeedback?.summary || undefined,
        }
        : session?.last_route || null,
      state: session.pending_approval
        ? "awaiting_approval"
        : (session.pending_install_proposal ? 'awaiting_install_approval' : "idle"),
      pattern_conflict: session.pending_approval || session.pending_install_proposal ? session.pattern_conflict : null,
      temporary_execution_override: null,
      pattern_recovery: session.pending_approval || session.pending_install_proposal
        ? session.pattern_recovery
        : (patternRecoveryState
          ? buildPatternRecoveryState({
            originalPattern: patternRecoveryState.original_pattern,
            activePattern: patternRecoveryState.original_pattern || patternRecoveryState.active_pattern,
            reason: patternRecoveryState.reason || 'restored_after_turn',
            status: 'restored',
            recoveryPolicy: patternRecoveryState.recovery_policy || 'next_turn_retry',
          })
          : null),
    }));
  }
}

async function executeChatActions(
  bot,
  chatId,
  userId,
  message,
  routePlan,
  {
    verbose = CHAT_VERBOSE,
    runtime = null,
    telegramUserId = "",
  } = {}
) {
  const effectiveTelegramUserId = String(telegramUserId || userId || "").trim();
  const actions = Array.isArray(routePlan?.actions) ? routePlan.actions : [];
  const results = [];
  const outputs = [];
  let currentJobId = resolveCurrentJobIdForChat(chatId);

  for (const action of actions) {
    const label = chatActionLabel(action, { agentIndex: buildTelegramAgentIndex({ runtime, routePlan, actions }) });
    try {
      if (action.type === "show_agents") {
        const reg = await refreshAgentRegistry();
        await sendLong(bot, chatId, formatRegistryLines(reg));
        results.push({ label, status: "ok", note: `${reg.agents.length} agents` });
        continue;
      }

      if (action.type === "open_context") {
        const target = action.scope === "global"
          ? "global"
          : String(action.jobId || currentJobId || "").trim();
        await sendContextInfo(bot, chatId, target, {
          userId,
          createIfMissing: true,
        });
        results.push({ label, status: "ok", note: target || "current" });
        continue;
      }

      if (action.type === "create_agent") {
        if (memoryModeWithFallback() !== "goc") throw new Error("create_agent requires MEMORY_MODE=goc");
        const created = await createAgentProfile(requireGocClient(), {
          baseDir: jobs.baseDir,
          profile: action.agent,
          format: action.format || "json",
          actor: `telegram:${userId}`,
        });
        await refreshAgentRegistry({ includeCompiled: true });
        results.push({ label, status: "ok", note: `node=${created.created?.id || "unknown"}` });
        continue;
      }

      if (action.type === "update_agent") {
        if (memoryModeWithFallback() !== "goc") throw new Error("update_agent requires MEMORY_MODE=goc");
        const updated = await updateAgentProfile(requireGocClient(), {
          baseDir: jobs.baseDir,
          agentId: action.agentId,
          patch: action.patch || {},
          format: action.format || "json",
          actor: `telegram:${userId}`,
        });
        await refreshAgentRegistry({ includeCompiled: true });
        results.push({ label, status: "ok", note: `node=${updated.created?.id || "unknown"}` });
        continue;
      }

      if (action.type === "run_agent") {
        const agentId = resolveAgentId(action.agent || "");
        const prompt = String(action.prompt || "").trim();
        if (!agentId || !prompt) throw new Error("run_agent requires agent and prompt");

        let targetJobId = String(action.jobId || currentJobId || "").trim();
        if (!targetJobId) {
          const job = await createJob(message || prompt, { ownerUserId: userId, ownerChatId: chatId });
          targetJobId = String(job.jobId);
          currentJobId = targetJobId;
          if (verbose) await bot.sendMessage(chatId, `✅ /chat job created: ${targetJobId}\nworkspace: ${runWorkspaceDir(targetJobId)}`);
        } else {
          runDir(targetJobId);
        }

        const controller = resetJobAbortController(targetJobId);
        const chatKey = String(chatId);
        activeJobByChat.set(chatKey, targetJobId);
        rememberLastChatJob(chatId, targetJobId);
        const agentDisplay = formatChatAgentDisplayName(
          agentId,
          buildTelegramAgentIndex({ runtime })
        );
        if (!runtimeUiHelpers.useCompactProgressUpdates(verbose)) await bot.sendMessage(chatId, `🤖 ${agentDisplay} 실행 중…`);

        try {
          const result = await enqueue(
            () => executeAgentRun(
              bot,
              chatId,
              targetJobId,
              { type: "agent_run", agent: agentId, prompt },
              {
                signal: controller.signal,
                notify: verbose,
                runtime,
                telegramUserId: effectiveTelegramUserId,
              }
            ),
            { jobId: targetJobId, signal: controller.signal, label: `chat_agent_run_${agentId}` }
          );
          if (verbose) await sendLong(bot, chatId, `🤖 ${agentDisplay} 완료 (${result.mode})\n${clip(result.output, 3000)}`);
          outputs.push({
            agentId,
            provider: result.provider,
            model: result.model,
            mode: result.mode,
            output: String(result.output || ""),
            jobId: targetJobId,
          });
          currentJobId = targetJobId;
          results.push({ label, status: "ok", note: `jobId=${targetJobId}` });
        } finally {
          if (activeJobByChat.get(chatKey) === targetJobId) activeJobByChat.delete(chatKey);
          jobAbortControllers.delete(targetJobId);
        }
        continue;
      }

      results.push({ label, status: "skip", note: "unsupported action" });
    } catch (e) {
      results.push({ label, status: "error", note: clip(String(e?.message ?? e), 180) });
    }
  }

  return { results, currentJobId, outputs };
}

async function executeAgentRun(
  bot,
  chatId,
  jobId,
  act,
  {
    runtime = null,
    telegramUserId = "",
    signal = null,
    notify = true,
    onGeminiRetry = null,
    onGeminiModelSwitch = null,
    onGeminiGiveUp = null,
    geminiConcurrencyKey = "",
  } = {}
) {
  const cleanTelegramUserId = String(telegramUserId || "").trim();
  const restoreActor = bindGocActor(cleanTelegramUserId);
  try {
    const agentId = resolveAgentId(act.agent || "");
    const taskPrompt = String(act.prompt || "").trim();
    if (!agentId || !taskPrompt) throw new Error("invalid agent_run action");

    const agent = findAgentConfigInRuntime(agentId, runtime) || findAgentConfig(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}. Check conversation runtime/catalog.`);
    const authority = evaluateActionAuthority({
      action: {
        type: "agent_run",
        agent: agentId,
        prompt: taskPrompt,
        inputs: act?.inputs && typeof act.inputs === "object" ? act.inputs : {},
      },
      runtimeSnapshot: runtime,
    });
    if (authority.enforced && (!authority.execute_allowed || authority.requires_approval)) {
      throw createAuthorityDeniedError(authority, {
        fallbackMessage: `authority denied for agent=${agentId}`,
      });
    }

    const provider = String(agent.provider || "gemini").trim().toLowerCase();
    const model = String(agent.model || provider).trim() || provider;
    const rolePrompt = String(agent.prompt || "").trim();
    const roleId = String(act?.inputs?.role_id || act?.inputs?.roleId || agent.role || agent.role_id || agent.roleId || "").trim().toLowerCase();
    const displayLabel = String(act?.inputs?.display_label || act?.inputs?.displayLabel || act?.inputs?.agent_name || act?.inputs?.agentName || agent?.name || agentId).trim();
    appendAgentActivityEvent({
      jobDir: safeRunDir(jobId),
      event: 'agent_start',
      agentId,
      roleId,
      provider,
      model,
      summary: displayLabel || agentId,
      metadata: { action_type: act.type || 'agent_run' },
    });
    const publishContractCheck = enforceAgentPublishContract(jobId, {
      runtime,
      agentId,
      agent,
      provider,
      roleId,
      displayLabel,
      finalSynthesis: act?.inputs?.final_synthesis === true,
      requestedSurface: act?.inputs?.final_synthesis === true ? 'final_answer' : '',
    });
    if (!publishContractCheck.allowed) {
      tracking.append(jobId, 'decisions', [
        '## publish contract blocked',
        `- agent: ${displayLabel || agentId}`,
        `- provider: ${provider}`,
        `- role: ${roleId || '(unknown)'}`,
        `- publish_surfaces: ${(publishContractCheck.contract.publish_surface_ids || []).join(', ') || '(none)'}`,
        `- publish_targets: ${(publishContractCheck.contract.publish_targets || []).join(', ') || '(none)'}`,
        `- final_owner_required: ${publishContractCheck.contract.final_owner_required ? 'true' : 'false'}`,
        publishContractCheck.contract.final_owner_label ? `- final_owner: ${publishContractCheck.contract.final_owner_label}` : '',
        `- reason: ${publishContractCheck.summary}`,
      ].filter(Boolean).join('\n'));
      const error = new Error(publishContractCheck.summary);
      error.code = 'EPUBLISHCONTRACT';
      error.publish_contract = publishContractCheck.contract;
      throw error;
    }
    const agencyRoleOverlay = resolveAgencyRoleOverlay(
      act?.inputs?.agency_role_overlay,
      act?.inputs?.agencyRoleOverlay,
      agent?.agency_overlay,
      agent?.agencyOverlay,
      agent?.metadata?.agency_overlay,
    );
    const agencyRoleOverlayBlock = buildAgencyRoleOverlayPromptBlock(agencyRoleOverlay, { maxBullets: 4 });
    const combinedRoleMemo = [rolePrompt, agencyRoleOverlayBlock].filter(Boolean).join("\n\n");
    const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
    const providerOptions = resolveProviderRuntimeOptionsForJob({ runtime, provider, action: act, agent, jobId });
    const kbContract = buildAgentKnowledgeBaseBlock(jobId, { provider, roleId, agentId });
    ensureCliWorkspaceSupportFiles(jobId, { provider, roleMemo: combinedRoleMemo, kbContract, goal: taskPrompt, instruction: taskPrompt, runtimeExecutionPolicy, providerOptions });
    const taskBody = kbContract
      ? `${kbContract}

[ASSIGNED TASK]
${taskPrompt}`
      : taskPrompt;
    const combinedInstruction = combinedRoleMemo
      ? `[ROLE]
${combinedRoleMemo}

${taskBody}`
      : taskBody;
    const combinedGoal = combinedRoleMemo
      ? `[ROLE]
${combinedRoleMemo}

${taskBody}`
      : taskBody;
    const combinedChatQuestion = combinedRoleMemo
      ? `[AGENT ROLE]
${combinedRoleMemo}

${taskBody}`
      : taskBody;

    const appendLocalLogs = (output, mode) => {
      const section = `## Agent ${agentId} output (${mode})`;
      const rolePurpose = provider === 'codex'
        ? (act?.inputs?.final_synthesis === true ? 'final' : 'implementation')
        : (['reviewer', 'critic'].includes(roleId) ? 'review' : 'research');
      appendRoleAwareTracking(jobId, `${section}

${output}
`, {
        provider,
        roleId,
        purpose: rolePurpose,
        fallbackDoc: provider === 'codex' ? 'progress' : 'research',
      });
      jobs.appendConversation(jobId, agentId, output, { kind: "agent_run", provider, model, mode });
    };

    const providerResult = await runAgentProviderExecution({
      provider,
      agentId,
      agent,
      model,
      bot,
      chatId,
      jobId,
      notify,
      signal,
      roleId,
      act,
      providerOptions,
      runtimeExecutionPolicy,
      geminiConcurrencyKey,
      onGeminiRetry,
      onGeminiModelSwitch,
      onGeminiGiveUp,
      prompts: provider === 'gemini'
        ? {
          instruction: combinedInstruction,
          goal: taskPrompt,
          chatQuestion: combinedChatQuestion,
          roleMemo: combinedRoleMemo,
          userRequest: String(act?.inputs?.user_request || act?.inputs?.userRequest || extractLatestUserRequestFromTaskText(taskPrompt) || taskPrompt).trim(),
          chatRuntimeRules: String(act?.inputs?._runtime_rules_text || act?.inputs?.runtime_rules_text || '').trim(),
        }
        : {
          instruction: combinedInstruction,
          goal: combinedGoal,
          chatQuestion: combinedChatQuestion,
        },
      callbacks: {
        codexImplement,
        codexAssist,
        geminiResearch,
        sendChatGPTPrompt: routePlanning.sendChatGPTPrompt,
        appendLocalLogs,
        memoryModeWithFallback,
        takeGocFallbackReason: () => {
          const key = String(jobId);
          const reason = gocFallbackByJob.get(key);
          if (reason) gocFallbackByJob.delete(key);
          return reason || '';
        },
        summarizeUserSafeGocFallbackReason: runtimeUiHelpers.summarizeUserSafeGocFallbackReason,
      },
    });
    appendAgentActivityEvent({
      jobDir: safeRunDir(jobId),
      event: 'agent_complete',
      agentId,
      roleId,
      provider: providerResult?.provider || provider,
      model: providerResult?.model || model,
      summary: String(providerResult?.output || '').slice(0, 500),
      metadata: { mode: providerResult?.mode || undefined, failover: providerResult?.failover || undefined },
    });
    appendAgentHandoffEvent({
      jobDir: safeRunDir(jobId),
      fromAgent: agentId,
      toAgent: act?.inputs?.final_synthesis === true ? 'user' : 'next_agent',
      messageType: act?.inputs?.final_synthesis === true ? 'final_synthesis' : 'agent_output',
      summary: String(providerResult?.output || '').slice(0, 500),
      payload: { provider: providerResult?.provider || provider, model: providerResult?.model || model },
    });
    return providerResult;
  } finally {
    restoreActor();
  }
}

async function executeRoutedPlan(bot, chatId, jobId, route, signal = null, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
  installWorkflowContractFromRoute(runtime, route, { jobId, source: 'execute_routed_plan' });
  const runtimeAuthority = buildRunAuthority(runtime);
  const agentIndex = buildTelegramAgentIndex({ runtime, routePlan: route, actions: route?.actions || [] });
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const baseRuntimeTeamSnapshot = opts?.runtimeTeamSnapshot && typeof opts.runtimeTeamSnapshot === "object"
    ? opts.runtimeTeamSnapshot
    : (runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
      ? runtime.runtimeTeamSnapshot
      : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === "object"
        ? runtime.runtime_team_snapshot
        : null));
  let runtimeTeamSnapshot = mergePreferredRuntimeTeamSnapshot({
    baseSnapshot: baseRuntimeTeamSnapshot,
    routePlan: route,
    runtimeAuthority,
    source: "team_builder",
  });
  let askedChatGPT = false;
  const sanitizedRoute = sanitizeExecutablePlan({
    plan: route,
    runtimeSnapshot: runtimeTeamSnapshot,
  });
  const actions = Array.isArray(sanitizedRoute?.plan?.actions) ? sanitizedRoute.plan.actions : [];
  const executionContractNotes = Array.isArray(sanitizedRoute?.notes) ? sanitizedRoute.notes : [];
  if (executionContractNotes.length > 0) {
    tracking.append(jobId, "decisions", [
      "## route execution contract",
      ...executionContractNotes.map((note) => `- ${note.action_type} downgraded to sequential run_agent: ${note.reason}`),
    ].join("\n"));
  }

  const scopedRuntimeMode = isScopedContextMode(runtimeTeamSnapshot?.context_runtime_mode || "shared_memory");
  let scopeHydrationError = null;
  if (scopedRuntimeMode) {
    const threadId = String(runtime?.map?.threadId || "").trim();
    const hasPreMaterializedScopes = Array.isArray(runtimeTeamSnapshot?.materialized_scopes) && runtimeTeamSnapshot.materialized_scopes.length > 0;
    if (threadId) {
      try {
        runtimeTeamSnapshot = await hydrateRuntimeScopesViaGoC({
          client: requireGocClient(),
          threadId,
          runtimeSnapshot: runtimeTeamSnapshot,
        });
      } catch (error) {
        scopeHydrationError = error;
      }
    } else if (!hasPreMaterializedScopes) {
      scopeHydrationError = new Error("missing GoC thread binding for scoped execution");
    }
    if (scopeHydrationError) {
      runtimeTeamSnapshot = {
        ...runtimeTeamSnapshot,
        scope_materialization_error: String(scopeHydrationError?.message || scopeHydrationError || '').trim() || 'scope hydration failed',
      };
    }
  }

  const prepareScopedAction = (action = {}, { finalSynthesis = false } = {}) => {
    const cleanAction = action && typeof action === "object" ? action : {};
    const inputs = cleanAction.inputs && typeof cleanAction.inputs === "object" ? cleanAction.inputs : {};
    const scopedMode = isScopedContextMode(runtimeTeamSnapshot?.context_runtime_mode || "shared_memory");
    if (!scopedMode) {
      return {
        blocked: false,
        reason: "",
        action: cleanAction,
      };
    }
    const scopeState = resolveScopeExecutionState({
      runtimeSnapshot: runtimeTeamSnapshot,
      action: cleanAction,
      agentId: String(cleanAction.agent || "").trim().toLowerCase(),
      runtimeInstanceId: String(inputs.runtime_instance_id || inputs.runtimeInstanceId || "").trim(),
      slotId: String(inputs.slot_id || inputs.slotId || "").trim(),
      scopeId: String(inputs.scope_id || inputs.scopeId || "").trim(),
    });
    if (scopeState.blocked) {
      return {
        blocked: true,
        reason: scopeState.reason,
        action: cleanAction,
        scopeBinding: scopeState.scope_binding,
      };
    }
    const prepared = buildScopedPromptAssembly({
      goal: String(cleanAction.prompt || "").trim(),
      detailContext: "",
      runtime,
      scopeBinding: scopeState.scope_binding,
    });
    return {
      blocked: false,
      reason: "",
      scopeBinding: scopeState.scope_binding,
      action: {
        ...cleanAction,
        prompt: String(prepared?.final_prompt || cleanAction.prompt || "").trim(),
        inputs: {
          ...inputs,
          ...(prepared?.context_info && typeof prepared.context_info === "object"
            ? {
              scope_context_info: prepared.context_info,
            }
            : {}),
          final_synthesis: finalSynthesis === true || inputs.final_synthesis === true || undefined,
        },
      },
    };
  };

  if (runtimeTeamSnapshot && Array.isArray(runtimeTeamSnapshot.runtime_agents) && runtimeTeamSnapshot.runtime_agents.length > 0) {
    tracking.append(jobId, "decisions", [
      "## Runtime team snapshot",
      ...summarizeRuntimeTeamSnapshotLines(runtimeTeamSnapshot, {
        actionSource: String(route?.action_source || "unknown"),
      }),
    ].join("\n"));
  }

  const scopedPreflightFailures = [];
  if (scopedRuntimeMode) {
    const collectFailure = (label, result) => {
      if (!result?.blocked) return;
      scopedPreflightFailures.push({
        label,
        reason: String(result.reason || 'scoped execution blocked').trim(),
      });
    };
    for (const rawAct of actions) {
      const act = normalizeActionShape(rawAct);
      if (!act?.type) continue;
      if (act.type === 'agent_run') {
        collectFailure(formatChatAgentDisplayName(act.agent, agentIndex), prepareScopedAction(act));
        continue;
      }
      if (act.type === 'synthesize_final') {
        collectFailure(
          formatChatAgentDisplayName(act.agent, agentIndex),
          prepareScopedAction({
            type: 'agent_run',
            agent: act.agent,
            prompt: act.prompt,
            inputs: {
              ...(act.inputs && typeof act.inputs === 'object' ? act.inputs : {}),
              final_synthesis: true,
            },
          }, { finalSynthesis: true })
        );
        continue;
      }
      if (act.type === 'spawn_parallel') {
        for (const child of Array.isArray(act.agents) ? act.agents : []) {
          collectFailure(formatChatAgentDisplayName(child?.agent || '', agentIndex), prepareScopedAction(withAgentOutputContract(child, {
            runtimeExecutionPolicy: resolveRuntimeExecutionPolicyForRuntime(runtime),
    harnessRuntimePolicy: runtime?.harnessRuntimePolicy || runtime?.openharnessInstallState?.runtime_policy || null,
          })));
        }
      }
    }
  }

  if (scopedPreflightFailures.length > 0) {
    const lines = [
      "⛔️ scoped route blocked before execution",
      runtimeTeamSnapshot?.scope_materialization_error
        ? `- hydration: ${runtimeTeamSnapshot.scope_materialization_error}`
        : "",
      ...scopedPreflightFailures.map((entry) => `- ${entry.label}: ${entry.reason}`),
    ].filter(Boolean);
    await sendLong(bot, chatId, lines.join("\n"));
    return {
      askedChatGPT,
      route_blocked: true,
      route_block_reason: "scoped_preflight_failed",
      scope_preflight_failures: scopedPreflightFailures,
      runtime_team_snapshot: runtimeTeamSnapshot,
      ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
    };
  }

  const activeRouteSignals = new Set();
  const legacyDirectRuntimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);

  for (const rawAct of actions) {
    const act = normalizeActionShape(rawAct);
    if (!act?.type) continue;
    const authority = evaluateActionAuthority({
      action: act,
      runtimeSnapshot: runtimeTeamSnapshot,
    });
    if (authority.enforced && authority.allowed !== true) {
      await bot.sendMessage(chatId, `⛔️ authority denied: ${authority.reasons.join("; ") || "action blocked"}`);
      continue;
    }
    if (authority.requires_approval) {
      await bot.sendMessage(chatId, `🟡 authority approval required: ${authority.reasons.join("; ") || act.type}`);
      break;
    }

    const routeDecision = evaluateIncomingConditions(act, { activeSignals: activeRouteSignals });
    const routeConditionBypass = ["gate_wait", "human_checkpoint", "checkpoint", "committee_consensus", "supervisor_decision"].includes(String(act?.type || "").trim().toLowerCase());
    if (!routeDecision.allowed && !routeConditionBypass) {
      await bot.sendMessage(chatId, `⏭️ route skipped: ${routeDecision.missing_conditions.join(', ') || 'conditions not satisfied'}`);
      continue;
    }

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfigInRuntime(act.agent, runtime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🤖 ${displayName} 실행 중… (${provider})`);
      const scopedActState = prepareScopedAction(withAgentOutputContract(act, {
        runtimeExecutionPolicy: legacyDirectRuntimeExecutionPolicy,
      }));
      if (scopedActState.blocked) {
        await bot.sendMessage(chatId, `⛔️ scoped execution blocked: ${scopedActState.reason}`);
        continue;
      }
      const result = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, scopedActState.action, {
          signal,
          runtime,
          telegramUserId,
        }),
        { jobId, signal, label: `agent_run_${act.agent}` }
      );
      const routeSignals = resolveActionRouteSignals({ action: act, result });
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, runtimeUiHelpers.buildCompactExecutionUpdateText({ displayName, output: result.output, routeSignals }));
      } else {
        await sendLong(bot, chatId, `🤖 ${displayName} 완료 (${result.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(result.output, 3500)}`);
      }
      if (result.provider === "chatgpt") askedChatGPT = true;
      continue;
    }

    if (act.type === "synthesize_final") {
      const agentInfo = findAgentConfigInRuntime(act.agent, runtime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🧩 ${displayName} 최종 합성 중… (${provider})`);
      const scopedSynthesisState = prepareScopedAction(withAgentOutputContract({
        type: "agent_run",
        agent: act.agent,
        prompt: act.prompt,
        inputs: {
          ...(act.inputs && typeof act.inputs === "object" ? act.inputs : {}),
          final_synthesis: true,
        },
      }, {
        runtimeExecutionPolicy: legacyDirectRuntimeExecutionPolicy,
      }), { finalSynthesis: true });
      if (scopedSynthesisState.blocked) {
        await bot.sendMessage(chatId, `⛔️ scoped execution blocked: ${scopedSynthesisState.reason}`);
        continue;
      }
      const result = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, scopedSynthesisState.action, {
          signal,
          runtime,
          telegramUserId,
        }),
        { jobId, signal, label: `synthesize_final_${act.agent}` }
      );
      const routeSignals = resolveActionRouteSignals({ action: act, result });
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, runtimeUiHelpers.buildCompactExecutionUpdateText({ displayName, output: result.output, routeSignals, final: true }));
      } else {
        await sendLong(bot, chatId, `🧩 ${displayName} 최종 합성 완료 (${result.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(result.output, 3500)}`);
      }
      if (result.provider === "chatgpt") askedChatGPT = true;
      continue;
    }

    if (act.type === "spawn_parallel") {
      const children = Array.isArray(act.agents) ? act.agents : [];
      if (children.length === 0) continue;
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `📣 병렬 실행 시작 (${children.length})`);
      const settled = await Promise.allSettled(children.map((child) => {
        const scopedChildState = prepareScopedAction(withAgentOutputContract(child, {
          runtimeExecutionPolicy: legacyDirectRuntimeExecutionPolicy,
        }));
        if (scopedChildState.blocked) {
          return Promise.reject(new Error(`scoped execution blocked: ${scopedChildState.reason}`));
        }
        return enqueue(
        () => executeAgentRun(bot, chatId, jobId, scopedChildState.action, {
          signal,
          runtime,
          telegramUserId,
          notify: false,
        }),
        { jobId, signal, label: `spawn_parallel_${child.agent}` }
      );
      }));
      let okCount = 0;
      let errorCount = 0;
      const summaries = [];
      for (let index = 0; index < settled.length; index += 1) {
        const row = settled[index];
        const child = children[index];
        const displayName = formatChatAgentDisplayName(child?.agent || "", agentIndex);
        if (row.status === "fulfilled") {
          okCount += 1;
          if (row.value?.provider === "chatgpt") askedChatGPT = true;
          summaries.push(`- ${displayName}: ok`);
        } else {
          errorCount += 1;
          summaries.push(`- ${displayName}: ${String(row.reason?.message || row.reason || "error")}`);
        }
      }
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, `📣 병렬 실행 완료: ok=${okCount}, error=${errorCount}`);
      } else {
        await sendLong(bot, chatId, [
          `📣 병렬 실행 완료: ok=${okCount}, error=${errorCount}`,
          ...summaries,
        ].join("\n"));
      }
      continue;
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId, signal);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}\n\n커밋: /commit ${jobId} <message>`);
      continue;
    }

    if (act.type === "chatgpt_prompt") {
      const q = String(act.question || "현재 상태에서 다음 단계 action plan(JSON)을 제안해줘.").trim();
      await routePlanning.sendChatGPTPrompt(bot, chatId, jobId, q);
      askedChatGPT = true;
      continue;
    }

    if (act.type === "checkpoint") {
      const approvalRequired = act?.inputs?.approval_required === true;
      const label = String(act.label || act.prompt || act.inputs?.checkpoint_id || "checkpoint").trim();
      await bot.sendMessage(
        chatId,
        approvalRequired
          ? `🟡 checkpoint reached: ${label}\n승인이 필요해 실행을 멈춥니다.`
          : `⏸️ checkpoint reached: ${label}`
      );
      if (approvalRequired) break;
      continue;
    }

    if (act.type === "gate_wait") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "gate").trim();
      const needsApproval = act.inputs?.approval_required === true || String(act.inputs?.gate_type || '').trim().toLowerCase() === 'approval';
      const detail = summarizeConditions(act.inputs?.incoming_conditions);
      const routeSignals = resolveActionRouteSignals({ action: act, result: { route_signals: act?.inputs?.selected_route_signals || [] } });
      await bot.sendMessage(chatId, `${needsApproval ? '🟡' : '⏸️'} gate reached: ${label}${detail ? `
조건: ${detail}` : ''}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      if (needsApproval) break;
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      continue;
    }

    if (act.type === "human_checkpoint") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "human checkpoint").trim();
      const routeSignals = resolveActionRouteSignals({ action: act, result: { route_signals: act?.inputs?.selected_route_signals || [] } });
      await bot.sendMessage(chatId, `🧑 checkpoint required: ${label}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}
사람 확인이 필요해 실행을 멈춥니다.`);
      break;
    }

    if (act.type === "tool_proxy_call") {
      const proxyResult = await runToolProxyStep({ action: act, jobId, signal, runtime, chatId });
      const routeSignals = resolveActionRouteSignals({ action: act, result: proxyResult });
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      await sendLong(bot, chatId, String(proxyResult?.text || 'tool proxy step'));
      continue;
    }

    if (act.type === "memory_sync") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "memory sync").trim();
      const memoryKeys = Array.isArray(act.inputs?.memory_keys) ? act.inputs.memory_keys.filter(Boolean) : [];
      const routeSignals = resolveActionRouteSignals({ action: act, result: {} });
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      await bot.sendMessage(chatId, `🧠 memory sync: ${label}${memoryKeys.length > 0 ? `
keys=${memoryKeys.join(', ')}` : ''}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      continue;
    }

    if (act.type === "committee_consensus") {
      const routeSignals = resolveActionRouteSignals({ action: act, result: {} });
      for (const signal of routeSignals) activeRouteSignals.add(signal);
      await bot.sendMessage(chatId, `🏛️ ${String(act.label || act.prompt || 'committee consensus').trim()}${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}`);
      continue;
    }

    if (act.type === "supervisor_decision") {
      const label = String(act.label || act.prompt || "Supervisor decision").trim();
      await bot.sendMessage(chatId, `🧭 ${label}`);
      continue;
    }

    if (["pause_children", "cancel_child", "reroute_child"].includes(act.type)) {
      await bot.sendMessage(chatId, `🧭 control action noted: ${act.type}`);
      continue;
    }
  }

  return {
    askedChatGPT,
    runtime_team_snapshot: runtimeTeamSnapshot,
    ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
  };
}

async function executeActions(bot, chatId, jobId, plan, signal = null, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
  const rawPlan = plan && typeof plan === "object" ? plan : {};
  const rawActions = Array.isArray(rawPlan.actions) ? rawPlan.actions : [];
  if (rawActions.length === 0) return;

  const normalizedPlan = normalizeActionPlan(rawPlan, {
    maxActions: Math.max(4, Math.min(24, rawActions.length || 4)),
  });
  const planForExecution = normalizedPlan.actions.length > 0
    ? {
      ...rawPlan,
      ...normalizedPlan,
      actions: normalizedPlan.actions,
    }
    : rawPlan;
  const runtimeSnapshot = mergePreferredRuntimeTeamSnapshot({
    baseSnapshot: runtime?.runtime_team_snapshot || runtime?.runtimeTeamSnapshot || null,
    routePlan: planForExecution,
    source: String(planForExecution?.action_source || rawPlan?.action_source || "team_builder").trim() || "team_builder",
  });
  const sanitizedPlan = sanitizeExecutablePlan({
    plan: planForExecution,
    runtimeSnapshot,
  });
  const executionContractNotes = Array.isArray(sanitizedPlan?.notes) ? sanitizedPlan.notes : [];
  const executablePlan = sanitizedPlan?.plan && typeof sanitizedPlan.plan === "object"
    ? {
      ...planForExecution,
      ...sanitizedPlan.plan,
      runtime_team_snapshot: runtimeSnapshot,
    }
    : {
      ...planForExecution,
      runtime_team_snapshot: runtimeSnapshot,
    };
  const effectiveRuntime = runtimeSnapshot
    ? {
      ...(runtime && typeof runtime === "object" ? runtime : {}),
      runtime_team_snapshot: runtimeSnapshot,
    }
    : runtime;
  const agentIndex = buildTelegramAgentIndex({ runtime: effectiveRuntime, routePlan: executablePlan, actions: executablePlan?.actions || [] });
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const allowed = new Set([
    "track_append",
    "agent_run",
    "run_agent",
    "gemini",
    "codex",
    "git_summary",
    "chatgpt_prompt",
    "chatgpt",
    "commit_request",
    "checkpoint",
    "gate_wait",
    "human_checkpoint",
    "supervisor_decision",
    "tool_proxy_call",
    "memory_sync",
    "committee_consensus",
    "synthesize_final",
    "spawn_parallel",
    "spawn_agents",
    "pause_children",
    "cancel_child",
    "reroute_child",
  ]);
  const activeRouteSignals = new Set();
  const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(effectiveRuntime);

  for (const note of executionContractNotes) {
    await bot.sendMessage(
      chatId,
      `ℹ️ execution contract: ${String(note?.action_type || 'action').trim()} downgraded (${Number(note?.child_count || 0)})
reason=${String(note?.reason || 'parallel spawn unavailable').trim()}`
    );
  }

  for (const rawAct of executablePlan.actions || []) {
    if (!rawAct || !allowed.has(String(rawAct.type || "").trim().toLowerCase())) continue;
    const act = normalizeActionShape(rawAct);
    if (!act) continue;

    const routeDecision = evaluateIncomingConditions(act, { activeSignals: activeRouteSignals });
    const routeConditionBypass = ["gate_wait", "human_checkpoint", "checkpoint", "committee_consensus", "supervisor_decision"].includes(String(act?.type || "").trim().toLowerCase());
    if (!routeDecision.allowed && !routeConditionBypass) {
      await bot.sendMessage(chatId, `⏭️ route skipped: ${routeDecision.missing_conditions.join(', ') || 'conditions not satisfied'}`);
      continue;
    }

    if (act.type === "track_append") {
      const cleanProvider = String(act.provider || act.inputs?.provider || 'chatgpt').trim().toLowerCase();
      const cleanRoleId = String(act.role_id || act.roleId || act.inputs?.role_id || act.inputs?.roleId || 'operator').trim().toLowerCase();
      const cleanPurpose = String(act.memory_purpose || act.memoryPurpose || act.inputs?.memory_purpose || act.inputs?.memoryPurpose || '').trim().toLowerCase();
      const cleanMarkdown = String(act.markdown || "");
      const { writeEvent, blocked } = appendRoleAwareTrackingWithStatus(jobId, cleanMarkdown, {
        provider: cleanProvider,
        roleId: cleanRoleId,
        purpose: cleanPurpose,
        fallbackDoc: 'progress',
        requestedDoc: act.doc || "plan",
      });
      if (blocked) {
        await bot.sendMessage(chatId, `⛔ 기록 업데이트 차단: ${String(writeEvent?.reason || 'memory write rejected').trim()}`);
      } else {
        const resolvedDocName = String(writeEvent?.resolved_doc || tracking.resolveDocName(jobId, act.doc || "plan")).trim();
        const rerouteNote = writeEvent?.requested_doc && writeEvent?.requested_doc !== resolvedDocName
          ? ` (requested=${writeEvent.requested_doc} → resolved=${resolvedDocName})`
          : '';
        await bot.sendMessage(chatId, `📝 기록 업데이트: ${resolvedDocName}${rerouteNote}`);
      }
      continue;
    }

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfigInRuntime(act.agent, effectiveRuntime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🤖 ${displayName} 실행 중… (${provider})`);
      const r = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, withAgentOutputContract(act, {
          runtimeExecutionPolicy,
        }), {
          signal,
          runtime: effectiveRuntime,
          telegramUserId,
        }),
        { jobId, signal, label: `agent_run_${act.agent}` }
      );
      const routeSignals = resolveActionRouteSignals({ action: act, result: r });
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, runtimeUiHelpers.buildCompactExecutionUpdateText({ displayName, output: r.output, routeSignals }));
      } else {
        await sendLong(bot, chatId, `🤖 ${displayName} 결과 (${r.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(r.output, 3500)}`);
      }
      continue;
    }

    if (act.type === "synthesize_final") {
      const agentInfo = findAgentConfigInRuntime(act.agent, effectiveRuntime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🧩 ${displayName} 최종 합성 중… (${provider})`);
      const r = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, withAgentOutputContract({
          type: "agent_run",
          agent: act.agent,
          prompt: act.prompt,
          inputs: {
            ...(act.inputs && typeof act.inputs === "object" ? act.inputs : {}),
            final_synthesis: true,
          },
        }, {
          runtimeExecutionPolicy,
        }), {
          signal,
          runtime: effectiveRuntime,
          telegramUserId,
        }),
        { jobId, signal, label: `synthesize_final_${act.agent}` }
      );
      const routeSignals = resolveActionRouteSignals({ action: act, result: r });
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, runtimeUiHelpers.buildCompactExecutionUpdateText({ displayName, output: r.output, routeSignals, final: true }));
      } else {
        await sendLong(bot, chatId, `🧩 ${displayName} 최종 합성 완료 (${r.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(r.output, 3500)}`);
      }
      continue;
    }

    if (act.type === "spawn_parallel") {
      const children = Array.isArray(act.agents) ? act.agents : [];
      if (children.length === 0) continue;
      if (!runtimeUiHelpers.useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `📣 병렬 실행 시작 (${children.length})`);
      const settled = await Promise.allSettled(children.map((child) => enqueue(
        () => executeAgentRun(bot, chatId, jobId, withAgentOutputContract(child, {
          runtimeExecutionPolicy,
        }), {
          signal,
          runtime: effectiveRuntime,
          telegramUserId,
          notify: false,
        }),
        { jobId, signal, label: `spawn_parallel_${child.agent}` }
      )));
      let okCount = 0;
      let errorCount = 0;
      const summaries = [];
      for (let index = 0; index < settled.length; index += 1) {
        const row = settled[index];
        const child = children[index];
        const displayName = formatChatAgentDisplayName(child?.agent || "", agentIndex);
        if (row.status === "fulfilled") {
          okCount += 1;
          summaries.push(`- ${displayName}: ok`);
        } else {
          errorCount += 1;
          summaries.push(`- ${displayName}: ${String(row.reason?.message || row.reason || "error")}`);
        }
      }
      if (runtimeUiHelpers.useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, `📣 병렬 실행 완료: ok=${okCount}, error=${errorCount}`);
      } else {
        await sendLong(bot, chatId, [
          `📣 병렬 실행 완료: ok=${okCount}, error=${errorCount}`,
          ...summaries,
        ].join("\n"));
      }
      continue;
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId, signal);
      await sendLong(bot, chatId, `📌 git status
${FENCE}
${clip(status, 1500)}
${FENCE}

📌 git diff(일부)
${FENCE}diff
${clip(diff, 2500)}
${FENCE}`);
      continue;
    }

    if (act.type === "chatgpt_prompt") {
      const q = String(act.question || act.prompt || "").trim();
      if (!q) continue;
      await routePlanning.sendChatGPTPrompt(bot, chatId, jobId, q);
      continue;
    }

    if (act.type === "checkpoint") {
      const approvalRequired = act?.inputs?.approval_required === true;
      const label = String(act.label || act.prompt || act.inputs?.checkpoint_id || "checkpoint").trim();
      await bot.sendMessage(chatId, `🧭 checkpoint: ${label}`);
      if (approvalRequired) {
        await bot.sendMessage(chatId, `🧑 checkpoint required: ${label}`);
        break;
      }
      continue;
    }

    if (act.type === "gate_wait") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "gate").trim();
      const detail = summarizeConditions(act.inputs?.incoming_conditions);
      const routeSignals = resolveActionRouteSignals({ action: act, result: { route_signals: act?.inputs?.selected_route_signals || [] } });
      await bot.sendMessage(chatId, `⏸️ gate reached: ${label}${detail ? `
조건: ${detail}` : ''}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      if (act.inputs?.approval_required === true) break;
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      continue;
    }

    if (act.type === "human_checkpoint") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "human checkpoint").trim();
      const routeSignals = resolveActionRouteSignals({ action: act, result: { route_signals: act?.inputs?.selected_route_signals || [] } });
      await bot.sendMessage(chatId, `🧑 checkpoint required: ${label}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      break;
    }

    if (act.type === "tool_proxy_call") {
      const proxyResult = await runToolProxyStep({ action: act, jobId, signal, runtime: effectiveRuntime, chatId });
      const routeSignals = resolveActionRouteSignals({ action: act, result: proxyResult });
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      await sendLong(bot, chatId, String(proxyResult?.text || 'tool proxy step'));
      continue;
    }

    if (act.type === "memory_sync") {
      const label = String(act.label || act.prompt || act.inputs?.slot_id || "memory sync").trim();
      const memoryKeys = Array.isArray(act.inputs?.memory_keys) ? act.inputs.memory_keys.filter(Boolean) : [];
      const routeSignals = resolveActionRouteSignals({ action: act, result: {} });
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      await bot.sendMessage(chatId, `🧠 memory sync: ${label}${memoryKeys.length > 0 ? `
keys=${memoryKeys.join(', ')}` : ''}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      continue;
    }

    if (act.type === "committee_consensus") {
      const label = String(act.label || act.prompt || "committee consensus").trim();
      const routeSignals = resolveActionRouteSignals({ action: act, result: {} });
      for (const nextSignal of routeSignals) activeRouteSignals.add(nextSignal);
      await bot.sendMessage(chatId, `🏛️ ${label}${routeSignals.length > 0 ? `
route_signals=${routeSignals.join(', ')}` : ''}`);
      continue;
    }

    if (act.type === "supervisor_decision") {
      const label = String(act.label || act.prompt || "Supervisor decision").trim();
      await bot.sendMessage(chatId, `🧭 ${label}`);
      continue;
    }

    if (["pause_children", "cancel_child", "reroute_child"].includes(act.type)) {
      await bot.sendMessage(chatId, `🧭 control action noted: ${act.type}`);
      continue;
    }

    if (act.type === "commit_request") {
      const message = String(act.message || "").trim();
      if (!message) continue;
      const rec = approvals.request(jobId, { purpose: "git commit", summary: `Commit changes with message: ${message}`, payload: { action: "git_commit", message } });
      await bot.sendMessage(chatId,
        `🟡 커밋 승인 필요
jobId=${jobId}
message=${message}
token=${rec.token}`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve:${jobId}:${rec.token}` }, { text: "❌ Deny", callback_data: `deny:${jobId}:${rec.token}` }]] } }
      );
    }
  }

  await maybeSendArtifactSummary(bot, chatId, jobId, {
    replyToMessageId: getCurrentTurnReplyMessageId(chatId),
  }).catch(() => null);
}



export {
  buildSupervisorExecutionCallbacks,
  formatChatSummary,
  summarizeSpecialChatOutputs,
  buildChatSynthesisFallback,
  synthesizeChatReply,
  runSupervisorChat,
  executeChatActions,
  executeAgentRun,
  executeRoutedPlan,
  executeActions,
  compactTaskText,
  deriveGocMemorySurfaceSpec,
  deriveGocMemoryNodePayload,
  formatGocProjectionContext,
};
