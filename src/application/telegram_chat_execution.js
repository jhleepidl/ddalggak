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
import { isScopedContextMode, normalizeContextRuntimeMode } from "../domain/context_runtime.js";
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
import { applyTeamConfigurationToRuntime, buildAutoRefineDraftFromStructureConflict, formatTeamProposalMessage, getSessionTeamState, hydrateSessionTeamStateFromConversationStore, storePendingTeam, syncTeamConfigurationToConversationStore, validateTeamConfiguration } from "./team_configuration.js";
import { appendRecentAgentTurn, planAgentFollowupShortcut } from "./agent_followup_shortcuts.js";
import { buildAnswerCapsules } from "./answer_capsules.js";
import { detectCapabilityGapsFromExecution } from "./capability_gap_detector.js";
import { buildInstallProposalPrompt, buildInstallProposalStateFromExecution, setPendingInstallProposal, getPendingInstallProposal, clearPendingInstallProposal } from './install_proposal_state.js';
import { resolveCredentialEnvForChat } from './credential_binding.js';
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
import { normalizeRuntimeExecutionPolicy } from "./runtime_execution_policy.js";
import { resolveProviderRuntimeOptions } from "./provider_runtime_policy.js";
import { summarizeProviderInteractionCapabilities } from "./provider_interaction_capabilities.js";
import { summarizeRuntimeCheckpointRef, writeRuntimeCheckpointBundle } from "./runtime_checkpointing.js";
import { appendPromptTelemetry, estimateTextTokens as estimatePromptTelemetryTokens } from "./prompt_telemetry.js";
import { readIterationDelta, readRoleSummary, updateRoleSummary } from "./summary_memory.js";

import * as runtimeState from "./telegram_runtime_state.js";
import * as runtimeIo from "./telegram_runtime_io.js";
import * as routePlanning from "./telegram_route_planning.js";
import * as gocRuntime from "./telegram_goc_runtime.js";
import * as runtimeUi from "./telegram_runtime_ui.js";

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
  TELEGRAM_PROGRESS_DETAIL_MODE,
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
const {
  appendChatMessageToGoc,
  buildContextInfo,
  buildWorkspaceFilesPromptSection,
  ensureCommandOk,
  loadContextDocs,
  sendContextInfo,
  maybeSendArtifactSummary,
  sendLong,
} = runtimeIo;

const replyAnchorStore = new ReplyAnchorStore({ sessionStore: chatSessionStore });
const {
  getGoalFromResearch,
  normalizeActionShape,
  actionLabel,
  formatRegistryLines,
  chatActionLabel,
  buildQueuedAgentStatusFromActions,
  getCurrentTurnReplyMessageId,
  sendRouterAckMessage,
  sendPlanPreviewMessage,
  normalizeForceMode,
  buildAutopilotProgressSummary,
  buildAutopilotFollowupMessage,
  sanitizeSupervisorRoutePlan,
  recommendTeamForTask,
  rewritePlanToReuseAgents,
  normalizeDeliverableList,
  mergeSuggestedActions,
  collectSuggestedActionsFromOutputs,
  updateCompletedDeliverablesFromOutputs,
  buildPendingApprovalPrompt,
  sendGeminiRetryMessage,
  sendGeminiModelSwitchMessage,
  sendGeminiGiveUpMessage,
  sendAgentStatusTransitionMessage,
} = routePlanning;


function safeRunDir(jobId = "") {
  try {
    return runDir(jobId);
  } catch {
    return "";
  }
}

function resolveRuntimeExecutionPolicyForRuntime(runtime = null) {
  const structurePolicy = runtime?.activeTeamConfig?.structure_v2?.control_policy?.runtime_execution
    || runtime?.activeTeamConfig?.runtime_execution
    || runtime?.runtimeTeamSnapshot?.structure_v2?.control_policy?.runtime_execution
    || runtime?.runtimeTeamSnapshot?.runtime_execution
    || runtime?.runtime_team_snapshot?.structure_v2?.control_policy?.runtime_execution
    || runtime?.runtime_team_snapshot?.runtime_execution
    || {};
  return normalizeRuntimeExecutionPolicy(structurePolicy);
}

function resolveProviderRuntimeOptionsForJob({ runtime = null, provider = '', action = null, agent = null, jobId = '' } = {}) {
  const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
  let workspaceRoot = process.cwd();
  try {
    if (jobId) workspaceRoot = runWorkspaceDir(jobId);
  } catch {}
  return resolveProviderRuntimeOptions({
    runtimeExecutionPolicy,
    provider,
    workspaceRoot,
    action,
    agent,
  });
}

function continuousStopSignalsMatched(activeSignals = [], policy = {}) {
  const signals = new Set((Array.isArray(activeSignals) ? activeSignals : []).map((row) => String(row || '').trim().toLowerCase()).filter(Boolean));
  return (Array.isArray(policy?.stop_signals) ? policy.stop_signals : [])
    .map((row) => String(row || '').trim().toLowerCase())
    .filter(Boolean)
    .filter((row) => signals.has(row));
}

function shouldRequestQualityDecision({ roleId = '', runtimeExecutionPolicy = {} } = {}) {
  const roleKey = String(roleId || '').trim().toLowerCase();
  if ((runtimeExecutionPolicy?.continuous_improvement || {}).enabled === true) return true;
  return ['reviewer', 'judge', 'synthesizer', 'operator', 'chair'].includes(roleKey);
}

function buildQualityAssessmentInstruction({ roleId = '', runtimeExecutionPolicy = {} } = {}) {
  if (!shouldRequestQualityDecision({ roleId, runtimeExecutionPolicy })) return '';
  const stopSignals = (Array.isArray(runtimeExecutionPolicy?.continuous_improvement?.stop_signals)
    ? runtimeExecutionPolicy.continuous_improvement.stop_signals
    : ['quality_threshold_met', 'ready_for_user', 'final_answer_ready', 'done_enough'])
    .map((row) => String(row || '').trim())
    .filter(Boolean);
  const continueSignals = ['needs_more_revision', 'needs_more_research', 'quality_gap_remaining', 'evidence_gap_remaining', 'not_ready_yet'];
  const exampleStop = JSON.stringify({ decision: 'stop', signals: [stopSignals[0] || 'quality_threshold_met'], reason: 'The output is coherent, verified, and ready for the user.' });
  const exampleContinue = JSON.stringify({ decision: 'continue', signals: ['needs_more_revision'], reason: 'The output still has quality gaps that require another iteration.' });
  return [
    '[QUALITY SIGNAL CONTRACT]',
    '- If you can judge whether the current workspace/output is good enough to stop refining, include a QUALITY_DECISION_JSON block.',
    `- Stop signals (exact strings): ${stopSignals.join(', ') || '(none)'}`,
    `- Continue/refine signals (exact strings): ${continueSignals.join(', ')}`,
    '- Use only exact signal strings. Do not invent new signal names unless the route explicitly asked for them.',
    '- If the work is ready for user delivery, emit at least one stop signal.',
    '- If the work still needs another iteration, emit at least one continue/refine signal.',
    '- Format:',
    'QUALITY_DECISION_JSON',
    '```json',
    exampleStop,
    '```',
    '- Or when not ready:',
    'QUALITY_DECISION_JSON',
    '```json',
    exampleContinue,
    '```',
  ].join('\n');
}

function buildAgentOutputContractBlock({ roleId = '', runtimeExecutionPolicy = {} } = {}) {
  const outputContract = [
    '[OUTPUT CONTRACT]',
    '- 사용자에게 채팅방에 바로 공유할 중간 결과가 있으면 CHAT_UPDATE 블록을 포함하라.',
    '- CHAT_UPDATE는 3~6줄의 자연어 요약으로 쓰고, 근거/핵심 판단/다음 포인트만 남겨라.',
    '- 형식:',
    'CHAT_UPDATE',
    '```text',
    '핵심 발견 2~3개',
    '왜 중요한지',
    '다음으로 넘길 포인트',
    '```',
    '- 필요하면 마지막에 NEXT_ACTIONS_JSON 블록으로 후속 작업을 제안하라.',
    '- 형식:',
    'NEXT_ACTIONS_JSON',
    '```json',
    '{"actions":[{"type":"run_agent","agent_id":"coder","goal":"..."}]}',
    '```',
    '- 후속 제안이 없으면 NEXT_ACTIONS_JSON 블록은 생략한다.',
  ].join('\n');
  const qualityInstruction = buildQualityAssessmentInstruction({ roleId, runtimeExecutionPolicy });
  return [outputContract, qualityInstruction].filter(Boolean).join('\n\n');
}

function withAgentOutputContract(action = {}, { runtimeExecutionPolicy = {} } = {}) {
  const row = action && typeof action === 'object' ? action : {};
  const basePrompt = String(row.prompt || row.goal || '').trim();
  if (!basePrompt) return row;
  if (basePrompt.includes('[OUTPUT CONTRACT]')) return row;
  const inputs = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
  const roleId = String(inputs.role_id || inputs.roleId || row.agent || row.agent_id || '').trim().toLowerCase();
  const contract = buildAgentOutputContractBlock({ roleId, runtimeExecutionPolicy });
  if (!contract) return row;
  return {
    ...row,
    prompt: [basePrompt, contract].filter(Boolean).join('\n\n'),
  };
}

function buildContinuousImprovementFollowup({
  originalUserText = '',
  followupHint = '',
  deliverables = [],
  completedDeliverables = [],
  stopSignals = [],
  turn = 1,
  maxTurns = 1,
  customPrompt = '',
} = {}) {
  const remaining = (Array.isArray(deliverables) ? deliverables : []).filter((item) => {
    const key = String(item || '').trim().toLowerCase();
    return key && !(Array.isArray(completedDeliverables) ? completedDeliverables : []).some((done) => String(done || '').trim().toLowerCase() === key);
  });
  return [
    customPrompt || '현재 workspace 결과를 스스로 검토하고 더 개선하라. 아직 품질이 충분하지 않다면 다음 개선 단계를 이어서 수행하라.',
    `original_request=${String(originalUserText || '').trim()}`,
    `continuous_turn=${turn}/${maxTurns}`,
    remaining.length > 0 ? `remaining_deliverables=${remaining.join(', ')}` : 'remaining_deliverables=(none)',
    followupHint ? `followup_hint=${followupHint}` : '',
    stopSignals.length > 0 ? `observed_stop_signals=${stopSignals.join(', ')}` : '',
    '이번 턴의 목표: 품질을 높이기 위한 self-refine / verify / rewrite / strengthen 작업을 계속하라. 단, stop signal을 충족하면 마무리해도 된다.',
    'quality_contract=가능하면 QUALITY_DECISION_JSON 블록으로 stop/continue 판단과 정확한 signal 문자열을 남겨라.',
  ].filter(Boolean).join('\n');
}


function normalizeComparableDeltaText(text = '') {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 320);
}

function buildTurnDeltaFingerprint(outputs = []) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((row) => {
      const actor = String(row?.agentId || row?.agent || row?.label || '').trim().toLowerCase();
      const body = normalizeComparableDeltaText(row?.output || row?.text || row?.summary || '');
      return actor && body ? `${actor}:${body}` : body;
    })
    .filter(Boolean)
    .slice(-3)
    .join(' || ');
}

function buildContinuousImprovementProgressMessage({ turn = 1, maxTurns = 1, deliverables = [], completedDeliverables = [], stopSignals = [] } = {}) {
  const remaining = (Array.isArray(deliverables) ? deliverables : []).filter((item) => {
    const key = String(item || '').trim().toLowerCase();
    return key && !(Array.isArray(completedDeliverables) ? completedDeliverables : []).some((done) => String(done || '').trim().toLowerCase() === key);
  });
  return [
    `♻️ self-refine progress ${turn}/${maxTurns}`,
    `- completed: ${Array.isArray(completedDeliverables) && completedDeliverables.length > 0 ? completedDeliverables.join(', ') : '(none)'}`,
    `- remaining: ${remaining.length > 0 ? remaining.join(', ') : '(none)'}`,
    stopSignals.length > 0 ? `- stop_signals: ${stopSignals.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}
const {
  createJob,
  composeCapabilitiesForRun,
  loadSupervisorRuntime,
  summarizeSelectionState,
  refreshAgentRegistry,
  resolveMembershipTargetForThread,
  recordMembershipMutationDiagnostic,
  createAgentDraftProposal,
  openAgentsUiInfo,
  findLatestDraftByAgentId,
  findDraftByNodeId,
  updateJobConfigSelection,
  parseNodeCreatedAtMs,
  nodeTypeKey,
  nodeResourceKind,
  messageRoleOf,
  summarizeActiveTypeBreakdown,
  normalizeCatalogIds,
  resolveInstallCandidateFromSession,
  filterPublicBlueprintCandidates,
  findLatestAgentProfileNodeForPublish,
  buildGocAgentCreateSpec,
} = gocRuntime;
const { buildChatStatusCard } = runtimeUi;

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

function buildRuntimeAgentMetadataIndex(runtime = null) {
  const index = new Map();
  const pushRow = (row = {}) => {
    if (!row || typeof row !== 'object') return;
    const id = String(row.id || row.agent_id || row.agentId || row.template_id || row.templateId || row.instance_id || row.instanceId || '').trim().toLowerCase();
    if (!id) return;
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const next = {
      id,
      name: String(row.name || row.display_label || row.displayLabel || row.agent_name || '').trim(),
      role: String(row.role || row.role_id || row.roleId || row.role_label || row.roleLabel || '').trim().toLowerCase(),
      provider: String(row.provider || '').trim().toLowerCase(),
      model: String(row.model || row.configured_model || '').trim(),
      skills: Array.isArray(row.skills)
        ? row.skills
        : (Array.isArray(row.attached_skill_ids) ? row.attached_skill_ids : (Array.isArray(row.attachedSkillIds) ? row.attachedSkillIds : [])),
      purpose: String(row.purpose || row.assigned_goal || row.assignedGoal || '').trim(),
      agency_overlay_id: String(row.agency_overlay_id || row.agencyOverlayId || metadata.agency_overlay_id || '').trim(),
      agency_overlay: row.agency_overlay || row.agencyOverlay || metadata.agency_overlay || null,
    };
    const prev = index.get(id) || {};
    index.set(id, {
      ...prev,
      ...next,
      name: next.name || prev.name || '',
      role: next.role || prev.role || '',
      provider: next.provider || prev.provider || '',
      model: next.model || prev.model || '',
      skills: Array.isArray(next.skills) && next.skills.length > 0 ? next.skills : (Array.isArray(prev.skills) ? prev.skills : []),
      purpose: next.purpose || prev.purpose || '',
      agency_overlay_id: next.agency_overlay_id || prev.agency_overlay_id || '',
      agency_overlay: next.agency_overlay || prev.agency_overlay || null,
    });
  };
  for (const row of (Array.isArray(runtime?.activeTeamConfig?.agents) ? runtime.activeTeamConfig.agents : [])) pushRow(row);
  for (const row of (Array.isArray(runtime?.agents) ? runtime.agents : [])) pushRow(row);
  for (const row of (Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : [])) pushRow(row);
  for (const row of (Array.isArray(runtime?.runtimeTeamSnapshot?.runtime_agents) ? runtime.runtimeTeamSnapshot.runtime_agents : [])) pushRow(row);
  return index;
}

function extractChatUpdateBlock(text = "") {
  const src = String(text || "");
  if (!src) return "";
  const regexes = [
    /CHAT_UPDATE\s*[:：]?\s*```(?:text)?\s*([\s\S]*?)```/i,
    /CHAT_UPDATE\s*[:：]?\s*([\s\S]*?)(?:\n[A-Z0-9_]+_JSON\b|$)/i,
  ];
  for (const re of regexes) {
    const match = src.match(re);
    const candidate = String(match?.[1] || "").trim();
    if (candidate) return candidate;
  }
  return "";
}

function buildAgentChatUpdateText({ agentId = "", output = "" } = {}) {
  const displayName = formatChatAgentDisplayName(agentId, buildTelegramAgentIndex());
  const explicit = extractChatUpdateBlock(output);
  if (explicit) return `🧾 ${displayName} 중간 결과\n${clip(explicit, 2400)}`;
  const cleanOutput = String(output || "").trim();
  if (!cleanOutput) return `🧾 ${displayName} 완료`;
  return `🧾 ${displayName} 중간 결과\n${clip(cleanOutput, 2400)}`;
}


function useCompactProgressUpdates(verbose = false) {
  return !verbose && TELEGRAM_PROGRESS_DETAIL_MODE !== 'full';
}

function buildCompactExecutionUpdateText({ displayName = '', output = '', routeSignals = [], final = false } = {}) {
  const cleanDisplayName = String(displayName || '').trim() || 'Agent';
  const explicit = extractChatUpdateBlock(output);
  const raw = explicit || String(output || '').split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean).slice(0, 3).join(' ');
  const summary = clip(String(raw || (final ? '최종 정리를 마쳤습니다.' : '작업을 마쳤습니다.')).replace(/\s+/g, ' ').trim(), final ? 600 : 220);
  const lines = [final ? `🧩 ${cleanDisplayName} 최종 정리` : `✅ ${cleanDisplayName} 완료`, summary];
  if (Array.isArray(routeSignals) && routeSignals.length > 0) lines.push(`route_signals=${routeSignals.join(', ')}`);
  return lines.join('\n');
}

function buildAgentKnowledgeBaseBlock(jobId, { provider = "", roleId = "", agentId = "", detailLevel = "compact" } = {}) {
  try {
    const profile = tracking.loadProfile(jobId);
    if (!profile) return "";
    return buildAgentKnowledgeBaseGuidance({
      profile,
      sharedDir: runSharedDir(jobId),
      provider,
      roleId,
      agentId,
      detailLevel,
    });
  } catch {
    return "";
  }
}

function compactTaskText(value = '', { maxChars = 2400 } = {}) {
  const text = String(value || '').trim();
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(600, Math.floor(Number(maxChars))) : 2400;
  if (!text || text.length <= limit) return text;
  const head = clip(text, Math.max(400, Math.floor(limit * 0.75)));
  const tail = text.slice(Math.max(0, text.length - Math.max(240, Math.floor(limit * 0.15)))).trim();
  return [
    head,
    '',
    '[truncated for prompt efficiency]',
    '- Full request and working details are preserved in the shared memory surfaces.',
    '- Use mission_brief / working_memory as the source of truth for the complete task context.',
    tail ? `- tail excerpt: ${tail}` : '',
  ].filter(Boolean).join('\n');
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
    const docIds = orderedDocs
      .map((doc) => String(doc?.doc_id || doc?.surface_id || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((docId) => {
        if (seen.has(docId)) return false;
        seen.add(docId);
        return true;
      });
    return docIds.length > 0 ? docIds : fallbackDocIds;
  } catch {
    return fallbackDocIds;
  }
}

function buildRoleAwareContextContract(jobId, { provider = '', roleId = '', maxReadDocs = 4 } = {}) {
  try {
    const profile = tracking.loadProfile(jobId);
    if (!profile) return null;
    return buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs });
  } catch {
    return null;
  }
}

function normalizeComparableId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeStringListLocal(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function resolveRuntimeSnapshotLike(runtime = null) {
  return runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === 'object'
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === 'object' ? runtime.runtime_team_snapshot : null);
}

function resolveRuntimeFinalOwnerContract(runtime = null) {
  const snapshot = resolveRuntimeSnapshotLike(runtime) || {};
  const teamPlan = snapshot?.team_plan && typeof snapshot.team_plan === 'object' ? snapshot.team_plan : {};
  const structure = snapshot?.structure_v2 && typeof snapshot.structure_v2 === 'object' ? snapshot.structure_v2 : {};
  const activeTeam = runtime?.activeTeamConfig && typeof runtime.activeTeamConfig === 'object' ? runtime.activeTeamConfig : {};
  const interaction = teamPlan?.interaction_spec && typeof teamPlan.interaction_spec === 'object'
    ? teamPlan.interaction_spec
    : (activeTeam?.interaction_spec && typeof activeTeam.interaction_spec === 'object' ? activeTeam.interaction_spec : {});
  const controlPolicy = structure?.control_policy && typeof structure.control_policy === 'object' ? structure.control_policy : {};
  const topology = structure?.topology && typeof structure.topology === 'object' ? structure.topology : {};
  return {
    owner_label: String(interaction?.final_answer_owner || '').trim(),
    owner_participant_id: String(controlPolicy?.final_answer_owner_participant_id || topology?.final_participant_id || '').trim().toLowerCase(),
  };
}

function summarizeAgentPublishContract(jobId, { runtime = null, agentId = '', agent = null, provider = '', roleId = '', displayLabel = '' } = {}) {
  let profile = null;
  try {
    profile = tracking.loadProfile(jobId);
  } catch {
    profile = null;
  }
  const publishSummary = summarizeRoleMemoryEnforcement({ profile, provider, roleId });
  const runtimeAgent = findAgentConfigInRuntime(agentId, runtime) || (agent && typeof agent === 'object' ? agent : {});
  const policy = runtimeAgent?.context_policy && typeof runtimeAgent.context_policy === 'object'
    ? runtimeAgent.context_policy
    : (runtimeAgent?.contextPolicy && typeof runtimeAgent.contextPolicy === 'object' ? runtimeAgent.contextPolicy : {});
  const writes = policy?.writes && typeof policy.writes === 'object' ? policy.writes : {};
  const publishTargets = normalizeStringListLocal(writes.publish_targets || writes.publishTargets || []);
  const finalOwner = resolveRuntimeFinalOwnerContract(runtime);
  const identityTokens = [
    agentId,
    displayLabel,
    runtimeAgent?.name,
    runtimeAgent?.display_label,
    runtimeAgent?.displayLabel,
    runtimeAgent?.role,
    runtimeAgent?.role_id,
    runtimeAgent?.roleId,
    runtimeAgent?.template_id,
    runtimeAgent?.templateId,
    runtimeAgent?.participant_id,
    runtimeAgent?.participantId,
  ].map((entry) => normalizeComparableId(entry)).filter(Boolean);
  const ownerTokens = [
    finalOwner.owner_label,
    finalOwner.owner_participant_id,
  ].map((entry) => normalizeComparableId(entry)).filter(Boolean);
  const isFinalOwner = ownerTokens.length === 0
    ? true
    : ownerTokens.some((token) => identityTokens.includes(token));
  return {
    provider: String(provider || '').trim().toLowerCase(),
    role_id: String(roleId || '').trim().toLowerCase(),
    publish_surface_ids: Array.isArray(publishSummary.publish_surface_ids) ? publishSummary.publish_surface_ids : [],
    publish_targets: publishTargets,
    can_publish_final_answer: canRolePublishSurface({ profile, provider, roleId, surfaceId: 'final_answer' }),
    can_publish_artifact_index: canRolePublishSurface({ profile, provider, roleId, surfaceId: 'artifact_index' }),
    final_owner_required: Boolean(finalOwner.owner_label || finalOwner.owner_participant_id),
    final_owner_label: finalOwner.owner_label || finalOwner.owner_participant_id || '',
    is_final_owner: isFinalOwner,
  };
}

function enforceAgentPublishContract(jobId, { runtime = null, agentId = '', agent = null, provider = '', roleId = '', displayLabel = '', finalSynthesis = false, requestedSurface = '' } = {}) {
  const contract = summarizeAgentPublishContract(jobId, { runtime, agentId, agent, provider, roleId, displayLabel });
  const targetSurface = String(requestedSurface || '').trim().toLowerCase().replace(/\.md$/i, '');
  const reasons = [];
  if (targetSurface === 'artifact_index' && !contract.can_publish_artifact_index) {
    reasons.push('declared artifact publish surface가 없습니다');
  }
  if (targetSurface === 'final_answer' && !contract.can_publish_final_answer) {
    reasons.push('declared final_answer publish surface가 없습니다');
  }
  if (finalSynthesis) {
    if (!contract.can_publish_final_answer) reasons.push('final synthesis는 final_answer surface가 선언된 agent만 수행할 수 있습니다');
    if (contract.final_owner_required && !contract.is_final_owner) {
      reasons.push(`현재 final_answer_owner는 ${contract.final_owner_label || '다른 participant'} 입니다`);
    }
  }
  if (reasons.length === 0) {
    return {
      allowed: true,
      summary: '',
      contract,
    };
  }
  return {
    allowed: false,
    summary: `publish contract blocked: ${reasons.join('; ')}`,
    contract,
  };
}

async function loadRoleScopedContextDocs(jobId, { provider = '', roleId = '', fallbackDocIds = ['plan', 'research'], maxCharsPerDoc = 3500 } = {}) {
  const cleanRoleId = String(roleId || '').trim().toLowerCase();
  const cleanProvider = String(provider || '').trim().toLowerCase();
  const docNames = buildRoleAwareContextDocList(jobId, { provider: cleanProvider, roleId: cleanRoleId, fallbackDocIds });
  const contract = buildRoleAwareContextContract(jobId, { provider: cleanProvider, roleId: cleanRoleId, maxReadDocs: 4 });
  const enforcement = summarizeRoleMemoryEnforcement({ profile: tracking.loadProfile(jobId), provider: cleanProvider, roleId: cleanRoleId });
  return loadContextDocs(jobId, docNames, maxCharsPerDoc, {
    roleContract: contract,
    enforceLocalOnly: !!contract,
    enforcementNote: [
      '### MEMORY CONTRACT ENFORCEMENT',
      '',
      '- role-scoped read contract enforced',
      '- shared compiled GoC context skipped for this agent run',
      `- readable surfaces: ${(enforcement.read_surface_ids || []).join(', ') || '(none)'}`,
      `- writable surfaces: ${(enforcement.write_surface_ids || []).join(', ') || '(none)'}`,
      `- publish surfaces: ${(enforcement.publish_surface_ids || []).join(', ') || '(none)'}`,
    ].join('\n'),
  });
}

function appendRoleAwareTracking(jobId, markdown, { provider = '', roleId = '', purpose = 'worklog', fallbackDoc = 'progress', requestedDoc = '' } = {}) {
  const cleanMarkdown = String(markdown || '').trim();
  if (!cleanMarkdown) return null;
  try {
    return tracking.appendWithContract(jobId, requestedDoc || fallbackDoc, cleanMarkdown, {
      provider,
      roleId,
      purpose,
      fallbackDoc,
      strict: false,
      source: 'agent_output',
    });
  } catch {
    tracking.append(jobId, fallbackDoc, cleanMarkdown);
    return { status: 'fallback', resolved_doc: fallbackDoc, reason: 'append_with_contract_failed' };
  }
}

function ensureCliWorkspaceSupportFiles(jobId, { provider = "", roleMemo = "", kbContract = "", goal = "", instruction = "", runtimeExecutionPolicy = {}, providerOptions = {} } = {}) {
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

async function geminiResearch(jobId, goal, signal = null, opts = {}) {
  const runtimeExecutionPolicy = normalizeRuntimeExecutionPolicy(opts.runtimeExecutionPolicy || {});
  const sectionTitle = String(opts.sectionTitle || "Gemini notes");
  const outputGuide = String(opts.outputGuide || "").trim();
  const concurrencyKey = String(opts.concurrencyKey || "").trim() || `job:${String(jobId || "").trim()}`;
  const preferredModel = String(opts.model || "").trim();
  const roleMemo = memory.getAgentRole("gemini");
  const ctx = await loadRoleScopedContextDocs(jobId, { provider: 'gemini', roleId: String(opts.roleId || 'researcher').trim().toLowerCase(), fallbackDocIds: ['plan', 'research', 'progress'], maxCharsPerDoc: 2600 });
  const workspacePath = runWorkspaceDir(jobId);
  const providerOptions = opts.providerOptions && typeof opts.providerOptions === 'object'
    ? opts.providerOptions
    : resolveProviderRuntimeOptions({
      runtimeExecutionPolicy,
      provider: "gemini",
      workspaceRoot: workspacePath,
    });
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, { limitPerBucket: 5 });
  const kbContract = buildAgentKnowledgeBaseBlock(jobId, { provider: "gemini", roleId: String(opts.roleId || 'researcher').trim().toLowerCase(), agentId: String(opts.agentId || 'gemini').trim().toLowerCase() || 'gemini', detailLevel: "compact" });
  ensureCliWorkspaceSupportFiles(jobId, { provider: "gemini", roleMemo, kbContract, goal, runtimeExecutionPolicy, providerOptions });
  const compactGoal = compactTaskText(goal, { maxChars: 2600 });
  const prompt = [
    ctx,
    "",
    "Gemini workspace context is preloaded via GEMINI.md.",
    kbContract,
    `run workspace: ${workspacePath}`,
    workspaceFilesText,
    "",
    "제약:",
    "- 코드 작성/수정/패치 제안 금지",
    "- 터미널 명령 제안 최소화",
    "- 설계/리스크/검증 관점으로만 답변",
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "",
    "다음 목표를 달성하기 위한 구현 단계와 리스크를 한국어로 간결하게 작성해줘.",
    "",
    `목표: ${compactGoal}`,
    "",
    outputGuide || [
      "출력:",
      "- 요약",
      "- 구현 단계(번호)",
      "- 리스크/주의",
      "- 검증(테스트/체크)",
    ].join("\n"),
  ].join("\n");
  appendPromptTelemetry({
    jobDir: runDir(jobId),
    sharedDir: runSharedDir(jobId),
    row: {
      kind: 'provider_prompt',
      provider: 'gemini',
      model: preferredModel || '',
      agent_id: String(opts.agentId || 'gemini').trim().toLowerCase(),
      role_id: String(opts.roleId || 'researcher').trim().toLowerCase(),
      prompt_text: prompt,
      prepared_context_tokens: opts.preparedContextInfo?.compiled_tokens_estimate,
      prepared_context_chars: opts.preparedContextInfo?.compiled_chars,
      components: {
        local_context: ctx,
        kb_contract: kbContract,
        workspace_memory_file: 'GEMINI.md',
        workspace_files: workspaceFilesText,
        task_goal: compactGoal,
        output_guide: outputGuide || [
          "출력:",
          "- 요약",
          "- 구현 단계(번호)",
          "- 리스크/주의",
          "- 검증(테스트/체크)",
        ].join("\n"),
      },
      metadata: {
        concurrency_key: concurrencyKey,
      },
    },
  });
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
    extraEnv: {
      ...(providerOptions.extraEnv || {}),
      ...resolveCredentialEnvForChat(chatSessionStore, opts.chatId || ''),
    },
  });
  const out = (r.stdout || r.stderr || "");
  const researchPurpose = ['reviewer', 'critic'].includes(String(opts.roleId || '').trim().toLowerCase()) ? 'review' : 'research';
  appendRoleAwareTracking(jobId, `## ${sectionTitle}\n\n${out}\n`, {
    provider: 'gemini',
    roleId: String(opts.roleId || 'researcher').trim().toLowerCase(),
    purpose: researchPurpose,
    fallbackDoc: 'research',
    requestedDoc: researchPurpose === "review" ? "critic_log" : "research",
  });
  jobs.appendConversation(jobId, "gemini", out, { kind: "research" });
  ensureCommandOk("Gemini", r);
  return out;
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
  const ctx = await loadRoleScopedContextDocs(jobId, { provider: 'codex', roleId: String(opts.roleId || 'builder').trim().toLowerCase(), fallbackDocIds: ['plan', 'progress', 'research'], maxCharsPerDoc: 3200 });
  const workspacePath = runWorkspaceDir(jobId);
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, { limitPerBucket: 5 });
  const kbContract = buildAgentKnowledgeBaseBlock(jobId, { provider: "codex", roleId: String(opts.roleId || 'builder').trim().toLowerCase(), agentId: String(opts.agentId || 'codex').trim().toLowerCase() || 'codex', detailLevel: "compact" });
  const cliSupport = ensureCliWorkspaceSupportFiles(jobId, { provider: "codex", roleMemo, kbContract, instruction, goal: instruction, runtimeExecutionPolicy, providerOptions });
  const compactInstruction = compactTaskText(instruction, { maxChars: 2800 });
  const prompt = [
    ctx,
    "",
    "Codex workspace context is preloaded via .codex/instructions.md.",
    kbContract,
    "너는 코드 수정 에이전트다.",
    "규칙:",
    "- 네트워크 접근 금지.",
    `- CODEX_WORKSPACE_ROOT(코드 작업 영역) 내부 파일만 수정: ${workspacePath}`,
    `- 현재 run workspace: ${workspacePath}`,
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    workspaceFilesText,
    "- 테스트/빌드 실행은 별도의 tool_proxy 검증 단계가 담당한다. 수정 내용에 맞는 검증 명령을 염두에 두고 변경하라.",
    "- 변경 요약(파일별 이유) 포함.",
    "",
    "작업:",
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
  if (execution && typeof execution === 'object' && !execution.runtime && routePlan?.runtime) execution.runtime = routePlan.runtime;
  const outputs = Array.isArray(execution.outputs) ? execution.outputs : [];
  const hardFailures = Array.isArray(execution?.results)
    ? execution.results.filter((row) => ['error', 'blocked'].includes(String(row?.status || '').trim().toLowerCase()))
    : [];
  const capabilityGapDetected = detectCapabilityGapsFromExecution(execution).length > 0;
  if (outputs.length === 0 || hardFailures.length > 0 || capabilityGapDetected) {
    return buildChatSynthesisFallback(message, execution, execution?.runtime || null);
  }
  const special = summarizeSpecialChatOutputs(outputs);
  const hasAgentOutput = outputs.some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
  if (String(routePlan?.reason || "").trim().toLowerCase() === "direct_agent_followup_shortcut") {
    const direct = outputs.find((row) => String(row?.agentId || "").trim().toLowerCase() !== "system" && String(row?.output || "").trim());
    if (direct) return clip(String(direct.output || "").trim(), 3800);
  }
  if (special && !hasAgentOutput) return special;

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
    "너는 Telegram /chat의 최종 응답 작성기다.",
    "아래 내부 실행 결과를 바탕으로 사용자에게 보여줄 최종 답변 1개만 작성하라.",
    "규칙:",
    "- 한국어로 답하라.",
    "- 내부 라우팅/잡ID/run_dir/provider/agent 이름/로그는 숨겨라.",
    "- 핵심 답변을 먼저 주고, 필요하면 간단한 다음 단계 1~3개를 번호로 제시하라.",
    "",
    "사용자 요청:",
    String(message || ""),
    "",
    "내부 라우팅 요약:",
    `reason=${String(routePlan?.reason || "(none)")}`,
    `actions=${(Array.isArray(routePlan?.actions) ? routePlan.actions : []).map((a) => chatActionLabel(a)).join(", ") || "(none)"}`,
    "",
    "실행 결과:",
    outputText,
    special ? "특수 실행 요약:" : "",
    special ? special : "",
    "",
    "최종 답변:",
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
    if (r?.ok && out) return clip(out, 3800);
  } catch {}

  return buildChatSynthesisFallback(message, execution, execution?.runtime || null);
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
}) {
  const sharedContextSetId = String(runtime?.map?.ctxSharedId || "").trim();
  const threadId = String(runtime?.map?.threadId || "").trim();
  const currentTelegramUserId = String(userId || "").trim();
  const lensCacheByKey = new Map();
  const sharedContextMeta = runtime?.contextMeta && typeof runtime.contextMeta === "object"
    ? runtime.contextMeta
    : null;
  const hasContextEngine = !!(contextEngine && typeof contextEngine.prepareStepContext === "function");
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
    const finalPrompt = [
      String(prepared?.final_prompt || "").trim() || cleanGoal,
      promptRoleSummary ? `[ROLE SUMMARY]\n${clip(promptRoleSummary, 900)}` : "",
      promptIterationDelta ? `[ITERATION DELTA]\n${clip(promptIterationDelta, 700)}` : "",
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
              _prompt_context_info: prepared?.context_info && typeof prepared.context_info === "object"
                ? prepared.context_info
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
              await sendGeminiRetryMessage(bot, chatId, {
                retryCount,
                maxRetries,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
              });
            },
            onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
              await sendGeminiModelSwitchMessage(bot, chatId, {
                toModel,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
              });
            },
            onGeminiGiveUp: async ({ reason = "" } = {}) => {
              await sendGeminiGiveUpMessage(bot, chatId, {
                reason,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
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
          prepared_context_tokens: prepared?.context_info?.compiled_tokens_estimate,
          prepared_context_chars: prepared?.context_info?.compiled_chars,
          components: {
            assembled_context: String(prepared?.final_prompt || '').trim() || cleanGoal,
            role_summary: promptRoleSummary,
            agency_overlay: buildAgencyRoleOverlayPromptBlock(agencyRoleOverlay, { maxBullets: 4 }),
            iteration_delta: promptIterationDelta,
            output_contract: outputContractBlock,
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
        await executionGraph.attachArtifact(String(stepNodeId || "").trim(), {
          name: `artifact:${cleanAgentId}@${new Date().toISOString()}`,
          summary: clip(`${formatChatAgentDisplayName(cleanAgentId, buildTelegramAgentIndex({ runtime, routePlan: plan, actions: plan?.actions || [] }))} output`, 220),
          text: String(result.output || ""),
          uri: `ddalggak://jobs/${jobId}/agents/${cleanAgentId}/output`,
          payload: {
            kind: "agent_output",
            agent_id: cleanAgentId,
            provider: String(result?.provider || "").trim().toLowerCase() || undefined,
          },
        });
      }
      return result;
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
        const childToolCall = executionGraph
          ? await executionGraph.startToolCall(childStepNodeId, {
            toolName: "run_agent",
            inputPreview: clip(`${formatChatAgentDisplayName(agentId, buildTelegramAgentIndex({ runtime, routePlan: plan, actions: plan?.actions || [], extraSources: [{ actions: children }] }))} ${goal}`, 900),
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
          const forked = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.forkAgent !== "function") {
              throw new Error("GoC forkAgent API unavailable");
            }
            return await client.forkAgent(sourceId);
          });
          const forkedId = String(forked?.id || "").trim().toLowerCase();
          await refreshAgentRegistry({ includeCompiled: true });
          const sourceLabel = formatRuntimeAgentDisplay(sourceId);
          const forkedLabel = forkedId ? formatRuntimeAgentDisplay(forkedId) : "";
          return {
            id: forkedId,
            agent_id: forkedId,
            source_agent_id: sourceId,
            text: forkedLabel
              ? `✅ agent fork 완료: ${sourceLabel} -> ${forkedLabel}`
              : `✅ agent fork 요청 완료: ${sourceLabel}`,
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
  } = {}
) {
  const chatKey = String(chatId);
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
  const sessionAtStart = chatSessionStore.get(chatId);
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
    const lockedTeamState = await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime }).catch(() => getSessionTeamState(chatSessionStore, chatId));
    const activeTeamConfig = teamConfig && typeof teamConfig === 'object'
      ? teamConfig
      : (lockedTeamState?.active_team && typeof lockedTeamState.active_team === 'object' ? lockedTeamState.active_team : null);
    if (!activeTeamConfig) {
      throw new Error('active team is required before /chat execution');
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
      })
      : null;
    const currentRunId = String(executionGraph?.runId || '').trim() || undefined;
    runEventSink = runtimeCapabilities?.createRunEventSink
      ? runtimeCapabilities.createRunEventSink({ executionGraph })
      : null;
    if (runEventSink && typeof runEventSink.startRun === "function") {
      await runEventSink.startRun({
        userMessageNodeId: String(userMessageGoc?.id || "").trim(),
        userText: message,
        metadata: {
          runtime_team_snapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
          ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
        },
      }, {
        jobId: currentJobId,
      });
    }
    const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyForRuntime(runtime);
    const continuousImprovementPolicy = runtimeExecutionPolicy.continuous_improvement || {};
    const checkpointPolicy = runtimeExecutionPolicy.checkpointing || {};
    const autopilotEnabled = AUTOPILOT_ENABLED || continuousImprovementPolicy.enabled === true;
    const maxTurns = continuousImprovementPolicy.enabled === true
      ? Number(continuousImprovementPolicy.max_turns || AUTOPILOT_MAX_TURNS || 1)
      : (autopilotEnabled ? AUTOPILOT_MAX_TURNS : 1);
    const maxTotalActions = continuousImprovementPolicy.enabled === true
      ? Number(continuousImprovementPolicy.max_total_actions || AUTOPILOT_MAX_TOTAL_ACTIONS || 4)
      : (autopilotEnabled ? AUTOPILOT_MAX_TOTAL_ACTIONS : 4);
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
        routerPolicy: memory.getRouterPrompt(),
        contextSummary: routerCtx.contextText || runtime.contextSummary,
        geminiConcurrencyKey: `job:${String(currentJobId || "").trim()}`,
        onGeminiRetry: async ({ retryCount = 0, maxRetries = 0 } = {}) => {
          await sendGeminiRetryMessage(bot, chatId, {
            retryCount,
            maxRetries,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
        onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
          await sendGeminiModelSwitchMessage(bot, chatId, {
            toModel,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
        onGeminiGiveUp: async ({ reason = "" } = {}) => {
          await sendGeminiGiveUpMessage(bot, chatId, {
            reason,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
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

      const planActions = decoratePlanActionsWithAgentMetadata(Array.isArray(routePlan?.actions) ? routePlan.actions : [], runtime);
      routePlan = {
        ...routePlan,
        actions: planActions,
      };
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
      if (continuousImprovementPolicy.enabled === true && continuousImprovementPolicy.progress_report_each_turn !== false) {
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
        if (!useCompactProgressUpdates(false)) {
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

      if (!useCompactProgressUpdates(false)) {
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

    let installProposalState = null;
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
        setPendingInstallProposal(chatSessionStore, chatId, installProposalState);
      } else if (existingPendingInstallProposal?.source === 'execution_gap') {
        clearPendingInstallProposal(chatSessionStore, chatId, { preserveLast: true });
      }
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

    if (!mergedExecution.pendingApproval && routePlan.await_user === true) {
      const hint = String(routePlan.followup_hint || forcedAwaitReason || "").trim();
      if (hint) {
        replyText = `${replyText}\n\n🧩 추가 입력 필요: ${hint}`;
      }
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
          });
          await executionGraph.startRun({
            userMessageNodeId: String(userMessageGoc?.id || "").trim(),
            userText: message,
            metadata: {
              runtime_team_snapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
                ? runtime.runtimeTeamSnapshot
                : undefined,
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
        if (!useCompactProgressUpdates(verbose)) await bot.sendMessage(chatId, `🤖 ${agentDisplay} 실행 중…`);

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

    const runProvider = async (providerPrompt) => {
      if (provider === "chatgpt") {
        await routePlanning.sendChatGPTPrompt(bot, chatId, jobId, providerPrompt);
        return `ChatGPT prompt generated by agent=${agentId}\nquestion=${providerPrompt}`;
      }

      throw new Error(`Unsupported provider for agent ${agentId}: ${provider}`);
    };

    const appendLocalLogs = (output, mode) => {
      const section = `## Agent ${agentId} output (${mode})`;
      const rolePurpose = provider === 'codex'
        ? (act?.inputs?.final_synthesis === true ? 'final' : 'implementation')
        : (['reviewer', 'critic'].includes(roleId) ? 'review' : 'research');
      appendRoleAwareTracking(jobId, `${section}\n\n${output}\n`, {
        provider,
        roleId,
        purpose: rolePurpose,
        fallbackDoc: provider === 'codex' ? 'progress' : 'research',
      });
      jobs.appendConversation(jobId, agentId, output, { kind: "agent_run", provider, model, mode });
    };

    if (provider === "codex") {
      const output = await codexImplement(jobId, combinedInstruction, signal, {
        runtimeExecutionPolicy,
        providerOptions,
        chatId,
        agentId,
        roleId,
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
        finalSynthesis: act?.inputs?.final_synthesis === true,
      });
      const fallback = gocFallbackByJob.get(String(jobId));
      if (fallback) {
        if (notify) {
          await bot.sendMessage(chatId, `⚠️ GoC 컨텍스트 조회 실패로 local fallback 사용 중입니다.\nreason=${clip(fallback, 180)}`);
        }
        gocFallbackByJob.delete(String(jobId));
      }
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }
    if (provider === "gemini") {
      const output = await geminiResearch(jobId, combinedGoal, signal, {
        sectionTitle: `${agentId} notes`,
        agentId,
        roleId,
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
        outputGuide: [
          "출력:",
          "- 핵심 요약",
          "- 구현 전 확인사항",
          "- 리스크와 완화책",
          "- 검증 체크리스트",
        ].join("\n"),
        model,
        concurrencyKey: geminiConcurrencyKey || `job:${String(jobId || "").trim()}`,
        onGeminiRetry,
        onGeminiModelSwitch,
        onGeminiGiveUp,
        runtimeExecutionPolicy,
        providerOptions,
        chatId,
      });
      const fallback = gocFallbackByJob.get(String(jobId));
      if (fallback) {
        if (notify) {
          await bot.sendMessage(chatId, `⚠️ GoC 컨텍스트 조회 실패로 local fallback 사용 중입니다.\nreason=${clip(fallback, 180)}`);
        }
        gocFallbackByJob.delete(String(jobId));
      }
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }
    if (provider === "chatgpt") {
      const output = await runProvider(combinedChatQuestion);
      appendLocalLogs(output, memoryModeWithFallback());
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }

    const output = await runProvider(combinedChatQuestion);
    appendLocalLogs(output, memoryModeWithFallback());
    return { output, mode: memoryModeWithFallback(), agent, provider, model };
  } finally {
    restoreActor();
  }
}

async function executeRoutedPlan(bot, chatId, jobId, route, signal = null, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
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
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🤖 ${displayName} 실행 중… (${provider})`);
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
      if (useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, buildCompactExecutionUpdateText({ displayName, output: result.output, routeSignals }));
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
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🧩 ${displayName} 최종 합성 중… (${provider})`);
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
      if (useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, buildCompactExecutionUpdateText({ displayName, output: result.output, routeSignals, final: true }));
      } else {
        await sendLong(bot, chatId, `🧩 ${displayName} 최종 합성 완료 (${result.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(result.output, 3500)}`);
      }
      if (result.provider === "chatgpt") askedChatGPT = true;
      continue;
    }

    if (act.type === "spawn_parallel") {
      const children = Array.isArray(act.agents) ? act.agents : [];
      if (children.length === 0) continue;
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `📣 병렬 실행 시작 (${children.length})`);
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
      if (useCompactProgressUpdates(false)) {
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
      const writeEvent = tracking.appendWithContract(jobId, act.doc || "plan", String(act.markdown || ""), {
        provider: String(act.provider || act.inputs?.provider || 'chatgpt').trim().toLowerCase(),
        roleId: String(act.role_id || act.roleId || act.inputs?.role_id || act.inputs?.roleId || 'operator').trim().toLowerCase(),
        purpose: String(act.memory_purpose || act.memoryPurpose || act.inputs?.memory_purpose || act.inputs?.memoryPurpose || '').trim().toLowerCase(),
        fallbackDoc: 'progress',
        strict: false,
        source: 'plan_action',
      });
      const resolvedDocName = String(writeEvent?.resolved_doc || tracking.resolveDocName(jobId, act.doc || "plan")).trim();
      const rerouteNote = writeEvent?.requested_doc && writeEvent?.requested_doc !== resolvedDocName
        ? ` (requested=${writeEvent.requested_doc} → resolved=${resolvedDocName})`
        : '';
      await bot.sendMessage(chatId, `📝 기록 업데이트: ${resolvedDocName}${rerouteNote}`);
      continue;
    }

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfigInRuntime(act.agent, effectiveRuntime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🤖 ${displayName} 실행 중… (${provider})`);
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
      if (useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, buildCompactExecutionUpdateText({ displayName, output: r.output, routeSignals }));
      } else {
        await sendLong(bot, chatId, `🤖 ${displayName} 결과 (${r.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(r.output, 3500)}`);
      }
      continue;
    }

    if (act.type === "synthesize_final") {
      const agentInfo = findAgentConfigInRuntime(act.agent, effectiveRuntime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      const displayName = formatChatAgentDisplayName(act.agent, agentIndex);
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `🧩 ${displayName} 최종 합성 중… (${provider})`);
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
      if (useCompactProgressUpdates(false)) {
        await bot.sendMessage(chatId, buildCompactExecutionUpdateText({ displayName, output: r.output, routeSignals, final: true }));
      } else {
        await sendLong(bot, chatId, `🧩 ${displayName} 최종 합성 완료 (${r.mode})${routeSignals.length > 0 ? `\nroute_signals=${routeSignals.join(', ')}` : ''}\n${clip(r.output, 3500)}`);
      }
      continue;
    }

    if (act.type === "spawn_parallel") {
      const children = Array.isArray(act.agents) ? act.agents : [];
      if (children.length === 0) continue;
      if (!useCompactProgressUpdates(false)) await bot.sendMessage(chatId, `📣 병렬 실행 시작 (${children.length})`);
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
      if (useCompactProgressUpdates(false)) {
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
};
