import {
  executeRunCommand,
  executeContinueCommand,
} from "../../application/route_executor.js";
import {
  applyPendingTeam,
  buildTeamTransitionGuardrails,
  formatTeamTransitionGuardrailLines,
  buildTeamConfigurationTemplate,
  createFreeformTeamConfiguration,
  createFreeformTeamConfigurationAdvanced,
  buildTeamListMessage,
  buildStarterSingleAgentTeamConfiguration,
  formatSupportedModelLines,
  formatTeamProposalMessage,
  getSessionTeamState,
  hydrateSessionTeamStateFromConversationStore,
  parseTeamTemplate,
  refineTeamConfiguration,
  refineTeamConfigurationAdvanced,
  resetTeamConfiguration,
  storePendingTeam,
  suggestTeamConfiguration,
  validateTeamConfiguration,
  teamConfigChangeRequiresApproval,
  buildTeamSelectionPortfolio,
  formatTeamCandidatePortfolioMessage,
  selectPendingTeamCandidate,
} from "../../application/team_configuration.js";
import { buildTeamBlueprint, installTeamBlueprintToSession, normalizeTeamBlueprint } from '../../application/team_blueprint_runtime.js';
import { buildTeamInstallProposal, formatTeamInstallProposalMessage } from '../../application/install_proposal.js';
import { buildInstallProposalPrompt, createPendingInstallProposalState, getPendingInstallProposal, archivePendingInstallProposal } from '../../application/install_proposal_state.js';
import { formatManifestRequirementLines, normalizeManifestRequirements } from '../../shared/manifest_requirements.js';
import { handleTelegramTeamBlueprintSubcommand } from './team_blueprint_commands.js';
import { handleTelegramCredentialCommand } from './credential_commands.js';
import { getCredentialBindingState } from '../../application/credential_binding.js';
import { buildTeamSchemaOptionsText, buildTeamSchemaOptionsSummaryLines } from '../../shared/team_schema_catalog.js';
import { buildBenchmarkTeamTemplate, buildBenchmarkTemplateCatalogText } from '../../application/benchmark_team_templates.js';
import { syncRawHistoryToGoC } from '../../application/goc_raw_history_sync.js';
import { inspectAndPrepareImprovementJob, loadImprovementExecutionContext, runImprovementAutomation, runImprovementCanary, runImprovementEvalGate, runImprovementReview, runImprovementRollback, runImprovementTests, markImprovementPromotion } from '../../application/improvement_orchestrator.js';
import { writeIdleCompactionCandidate, formatIdleCompactionCandidateForTelegram } from '../../application/idle_compaction.js';
import { formatMemoryTopologyForTelegram, planMemoryTopology } from '../../application/memory_topology.js';
import { listModelNodes } from '../../application/model_node_registry.js';
import { listModelNodesWithHealth } from '../../application/model_node_health.js';
import { readRecentModelNodeUsage } from '../../application/model_node_usage_log.js';

const HELP_TEXT = [
  "Commands:",
  "- /chat <text>: 질문/작업 시작",
  "- /team: 현재 team 상태 보기",
  "- /team suggest <목적>: LLM planner로 필요한 team 초안 만들기",
  "- /team create <설명>: 원하는 team 직접 설명해서 만들기",
  "- /team refine <수정>: 현재/대기 team 수정하기",
  "- /team apply: 대기 team 적용",
  "- /status: 지금 진행 상황 보기",
  "- /models: 연결된 로컬/API model node 보기",
  "- /context: 현재 작업과 GoC 링크 보기",
  "- /artifacts [limit]: 결과물 보기",
  "- /send <번호|path>: 결과물 전송",
  "- /files [all|workspace|uploads] [limit]: 파일 보기",
  "- /stop [jobId]: 실행 중지",
  "- /help more: 고급/확장 명령 보기",
].join("\n");

const ADVANCED_HELP_TEXT = [
  "More commands:",
  "- /whoami: 현재 chat_id / user_id 확인",
  "- /running: 실행/대기 job 목록 확인",
  "- /credential ...: credential 바인딩/확인",
  "- /memory ... 또는 /settings ...: adaptive memory topology와 런타임 메모리/KB 조회·수정",
  "- /skills: 현재/예정 agent roster와 대표 skill 보기",
  "- /models: 연결된 로컬/API model node 보기",
  "- /tools: 현재 job의 tool 상태 보기",
  "- /upload (+파일 첨부) [메모]: 실행 없이 업로드만 저장",
  "- /team more: team의 고급 명령 보기",
  "- /chat [--debug] <message>|reset: supervisor chat 실행 또는 세션 초기화",
  "- /run <goal>: goal 기반 실행 시작",
  "- /continue <jobId>: 기존 job 이어서 실행",
  "- /gptprompt <jobId> <question>: GPT 확인용 프롬프트 생성",
  "- /gptapply [jobId]: GPT 응답 적용",
  "- /gptdone: GPT paste 대기 모드 종료",
  "- /goc history push: GoC Board용 raw history snapshot 동기화",
  "- /goc candidate approve <nodeId> [publish]: Board candidate 승격",
  "- /improve <ddalggak|goc> <instruction>: forge 기준 self-improvement job 생성",
  "- /improve status <jobId>: improvement job 상태 보기",
  "- /improve test <jobId>: 테스트 재실행",
  "- /improve canary <jobId>: canary 재실행",
  "- /improve promote <jobId>: restart/promote hook 실행",
  "- /commit <jobId> <message>: 작업 결과 커밋",
  "",
  "Legacy aliases removed:",
  "- /agents → /team",
  "- /outputs → /artifacts",
  "- /sendfile → /send",
  "- /attach → /upload",
].join("\n");

const TEAM_CORE_HELP_TEXT = [
  "Team commands:",
  "- /team: 현재 team 상태 보기",
  "- /team suggest <목적>: LLM planner로 목적 기반 team 제안 받기",
  "- /team create <설명>: 자연어로 team 만들기",
  "- /team refine <수정>: 현재/대기 team 수정하기",
  "- /team apply: 대기 team 적용",
  "- /team reset: team 초기화",
  "- /team more: 고급 team 명령 보기",
].join("\n");

const TEAM_ADVANCED_HELP_TEXT = [
  "More team commands:",
  "- /team requirements",
  "- /team proposal",
  "- /team export",
  "- /team install <JSON>",
  "- /team pull",
  "- /team push",
  "- /team debug templates: 개발자용 benchmark template 목록 보기",
  "- /team validate <JSON>",
  "- /team options",
  "- /team modes",
  ...buildTeamSchemaOptionsSummaryLines(),
].join("\n");


const TEAM_TEMPLATE_DEPRECATED_TEXT = [
  "/team template은 더 이상 일반 사용 흐름에서 권장되지 않습니다.",
  "",
  "목적 기반 팀 구성은 LLM planner가 처리합니다.",
  "- /team suggest <목적>",
  "- /team create <설명>",
  "- /team refine <수정>",
  "- /team apply",
  "",
  "현재/pending 팀의 structured manifest가 필요하면:",
  "- /team export",
  "",
  "개발자용 benchmark template 목록은:",
  "- /team debug templates",
].join("\n");

const TEAM_DEBUG_HELP_TEXT = [
  "Team debug commands:",
  "- /team debug templates: benchmark template catalog 보기",
  "- /team debug template benchmark <id>: benchmark template을 pending team으로 불러오기",
  "- /team debug template current: 현재 pending/active team의 legacy JSON template 출력",
].join("\n");

export function createTelegramCommandHandler(deps = {}) {
  const telegramUi = deps.telegramUi || {};
  const runtimeOps = deps.runtimeOps || {};
  const jobOps = deps.jobOps || {};
  const sessionOps = deps.sessionOps || {};
  const fileOps = deps.fileOps || {};
  const teamOps = deps.teamOps || {};

  const bot = telegramUi.bot || deps.bot;
  const sendLong = telegramUi.sendLong || deps.sendLong;
  const sendContextInfo = telegramUi.sendContextInfo || deps.sendContextInfo;
  const sendRouterAckMessage = telegramUi.sendRouterAckMessage || deps.sendRouterAckMessage;
  const clip = telegramUi.clip || deps.clip;

  const formatRunningJobs = jobOps.formatRunningJobs || deps.formatRunningJobs;
  const cancelJobExecution = jobOps.cancelJobExecution || deps.cancelJobExecution;
  const createJob = jobOps.createJob || deps.createJob;
  const resetJobAbortController = jobOps.resetJobAbortController || deps.resetJobAbortController;
  const tracking = jobOps.tracking || deps.tracking;
  const jobs = jobOps.jobs || deps.jobs;
  const approvals = jobOps.approvals || deps.approvals;
  const isCancelledError = jobOps.isCancelledError || deps.isCancelledError;
  const actionLabel = jobOps.actionLabel || deps.actionLabel;
  const getGoalFromResearch = jobOps.getGoalFromResearch || deps.getGoalFromResearch;
  const extractCodexInstruction = jobOps.extractCodexInstruction || deps.extractCodexInstruction;

  const getAwait = sessionOps.getAwait || deps.getAwait;
  const clearAwait = sessionOps.clearAwait || deps.clearAwait;
  const setAwait = sessionOps.setAwait || deps.setAwait;
  const rememberLastChatJob = sessionOps.rememberLastChatJob || deps.rememberLastChatJob;
  const resetChatSession = sessionOps.resetChatSession || deps.resetChatSession;
  const activeJobByChat = sessionOps.activeJobByChat || deps.activeJobByChat;
  const lastChatJobByChat = sessionOps.lastChatJobByChat || deps.lastChatJobByChat;
  const chatSessionStore = sessionOps.chatSessionStore || deps.chatSessionStore;
  const chatRunManager = sessionOps.chatRunManager || deps.chatRunManager;
  const jobAbortControllers = sessionOps.jobAbortControllers || deps.jobAbortControllers;

  const resolveLiveJobIdForChat = fileOps.resolveLiveJobIdForChat || deps.resolveLiveJobIdForChat;
  const parseClampedInt = fileOps.parseClampedInt || deps.parseClampedInt;
  const collectWorkspaceFileEntries = fileOps.collectWorkspaceFileEntries || deps.collectWorkspaceFileEntries;
  const formatWorkspaceFileListText = fileOps.formatWorkspaceFileListText || deps.formatWorkspaceFileListText;
  const refreshArtifactIndex = fileOps.refreshArtifactIndex || deps.refreshArtifactIndex;
  const formatArtifactIndexText = fileOps.formatArtifactIndexText || deps.formatArtifactIndexText;
  const resolveArtifactDeliveryContract = fileOps.resolveArtifactDeliveryContract || deps.resolveArtifactDeliveryContract || (() => ({ enabled: false, warnings: [], bundle_allowed: true }));
  const formatArtifactDeliveryContractLines = fileOps.formatArtifactDeliveryContractLines || deps.formatArtifactDeliveryContractLines || (() => []);
  const sendArtifactBySelection = fileOps.sendArtifactBySelection || deps.sendArtifactBySelection;
  const sendArtifactBundle = fileOps.sendArtifactBundle || deps.sendArtifactBundle;
  const parseArtifactBundleSelection = fileOps.parseArtifactBundleSelection || deps.parseArtifactBundleSelection || (() => null);
  const formatByteSize = fileOps.formatByteSize || deps.formatByteSize;
  const runWorkspaceDir = fileOps.runWorkspaceDir || deps.runWorkspaceDir;

  const memory = runtimeOps.memory || deps.memory;
  const formatMemorySummary = runtimeOps.formatMemorySummary || deps.formatMemorySummary;
  const formatAgentMemorySummary = runtimeOps.formatAgentMemorySummary || deps.formatAgentMemorySummary;
  const parseChatMessageWithFlags = runtimeOps.parseChatMessageWithFlags || deps.parseChatMessageWithFlags;
  const runSupervisorChat = runtimeOps.runSupervisorChat || deps.runSupervisorChat;
  const loadSupervisorRuntime = runtimeOps.loadSupervisorRuntime || deps.loadSupervisorRuntime;
  const normalizeForceMode = runtimeOps.normalizeForceMode || deps.normalizeForceMode || ((value) => value || 'normal');
  const decideRunRoute = runtimeOps.decideRunRoute || deps.decideRunRoute;
  const executeRoutedPlan = runtimeOps.executeRoutedPlan || deps.executeRoutedPlan;
  const suggestNextPrompt = runtimeOps.suggestNextPrompt || deps.suggestNextPrompt;
  const sendChatGPTPrompt = runtimeOps.sendChatGPTPrompt || deps.sendChatGPTPrompt;
  const memoryModeWithFallback = runtimeOps.memoryModeWithFallback || deps.memoryModeWithFallback;
  const requireGocClient = runtimeOps.requireGocClient || deps.requireGocClient;

  const sendChatStatus = teamOps.sendChatStatus || deps.sendChatStatus;
  const sendAgentOrToolListQuick = teamOps.sendAgentOrToolListQuick || deps.sendAgentOrToolListQuick;

  function parseApplyStateTokens(tokens = []) {
    for (const raw of tokens) {
      const value = String(raw || '').trim().toLowerCase();
      if (value === 'active' || value === '--active' || value === '--apply') return 'active';
      if (value === 'pending' || value === '--pending') return 'pending';
    }
    return 'pending';
  }

  function currentTeamForManifest(teamState = {}) {
    return teamState.pending_team || teamState.active_team || null;
  }

  function buildManifestWithSessionState(baseTeam, { runtime = null, applyState = 'pending', source = 'telegram', sessionInstallProposal = null } = {}) {
    return buildTeamBlueprint(baseTeam, { runtime, applyState, source, installProposalState: sessionInstallProposal });
  }

  function buildTeamStatusOverview(teamState = {}, { chatId = '', runtime = null } = {}) {
    const lines = [buildTeamListMessage(teamState, { runtime })];
    const session = chatSessionStore?.get?.(chatId) || {};
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const credentialBindingState = getCredentialBindingState(chatSessionStore, chatId);
    const patternConflict = session?.pattern_conflict && typeof session.pattern_conflict === 'object' ? session.pattern_conflict : null;
    const temporaryOverride = session?.temporary_execution_override && typeof session.temporary_execution_override === 'object' ? session.temporary_execution_override : null;
    const patternRecovery = session?.pattern_recovery && typeof session.pattern_recovery === 'object' ? session.pattern_recovery : null;
    const lastRecovery = session?.last_recovery_event && typeof session.last_recovery_event === 'object' ? session.last_recovery_event : null;
    const lastFork = session?.last_fork_event && typeof session.last_fork_event === 'object' ? session.last_fork_event : null;
    const lastRejoin = session?.last_rejoin_event && typeof session.last_rejoin_event === 'object' ? session.last_rejoin_event : null;

    const stateLines = [
      `active team: ${activeTeam ? String(activeTeam.team_name || 'configured').trim() : 'none'}`,
      `pending team: ${pendingTeam ? `${String(pendingTeam.team_name || 'pending_team').trim()}${pendingTeam?.planner_metadata?.auto_refine_from_pattern_conflict ? ' · auto_refine_draft' : ''}` : 'none'}`,
      `capability proposal: ${pendingInstallProposal ? `${String(pendingInstallProposal.status || 'awaiting_install_approval')} · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}` : 'none'}`,
      `credential bindings: ${Number(credentialBindingState?.summary?.bound_count || 0)}`,
    ];
    if (patternConflict?.classification) {
      stateLines.push(`pattern conflict: ${String(patternConflict.classification)}${patternConflict?.reason ? ` · ${String(patternConflict.reason)}` : ''}`);
    }
    if (temporaryOverride?.effective_pattern || temporaryOverride?.mode) {
      stateLines.push(`temporary override: ${String(temporaryOverride.effective_pattern || temporaryOverride.mode || 'active')}`);
    }
    if (patternRecovery?.recovery_mode || patternRecovery?.status) {
      stateLines.push(`pattern recovery: ${String(patternRecovery.recovery_mode || patternRecovery.status || 'pending')}`);
    }
    if (lastRecovery?.category || lastRecovery?.status) {
      stateLines.push(`latest recovery: ${String(lastRecovery.status || 'classified')} · ${String(lastRecovery.category || 'unknown_failure')}${lastRecovery?.recovery_strategy ? ` · ${String(lastRecovery.recovery_strategy)}` : ''}`);
    }
    if (lastFork?.forked_agent_id || lastFork?.source_agent_id) {
      stateLines.push(`latest fork: ${String(lastFork.source_agent_id || 'source')} -> ${String(lastFork.forked_agent_id || 'forked')}${lastFork?.scope_mode ? ` · scope=${String(lastFork.scope_mode)}` : ''}`);
    }
    if (lastRejoin?.agent_id || lastRejoin?.source_agent_id) {
      stateLines.push(`latest rejoin: ${String(lastRejoin.agent_id || 'forked')} -> ${String(lastRejoin.source_agent_id || 'source')}${lastRejoin?.summary ? ` · ${String(lastRejoin.summary)}` : ''}`);
    }
    lines.push('', 'Runtime state', ...stateLines);
    const pendingApplyGuardrails = pendingTeam ? buildTeamTransitionGuardrails(activeTeam, pendingTeam) : null;
    const confirmationState = session?.pending_team_apply_confirmation && typeof session.pending_team_apply_confirmation === 'object'
      ? session.pending_team_apply_confirmation
      : null;
    if (pendingApplyGuardrails?.warning_count > 0) {
      lines.push('', 'Apply 전 확인', ...formatTeamTransitionGuardrailLines(pendingApplyGuardrails, { maxWarnings: 5 }));
      if (confirmationState?.expires_at) {
        stateLines.push(`apply confirmation: 재확인 필요 · ${String(confirmationState.expires_at)}`);
      }
    }

    const nextSteps = [];
    if (pendingTeam) {
      nextSteps.push(pendingApplyGuardrails?.destructive_changes_present
        ? '- /team apply (한 번 누르면 경고, 다시 누르면 적용)'
        : '- /team apply');
    }
    if (pendingInstallProposal) nextSteps.push('- /team proposal', '- /credential pending');
    if (patternConflict?.classification === 'structure_override_required') nextSteps.push('- /team refine <자연어 수정>');
    if (nextSteps.length > 0) lines.push('', '추천 명령', ...nextSteps);
    return lines.join('\n');
  }
  function countConfiguredAgents(team = null) {
    return Array.isArray(team?.agents) ? team.agents.length : 0;
  }

  function summarizeTeamSlot(label = '', team = null) {
    if (!team || typeof team !== 'object') return `${label}: none`;
    const name = String(team.team_name || `${label}_team`).trim() || `${label}_team`;
    const agentCount = countConfiguredAgents(team);
    const compositionMode = String(team.composition_mode || '').trim().toLowerCase() || 'structured';
    const pattern = String(team?.structure_v2?.topology?.pattern || '').trim();
    const extras = [];
    if (pattern) extras.push(pattern);
    if (team?.planner_metadata?.auto_refine_from_pattern_conflict) extras.push('auto-refine');
    const summaryParts = [`${label}: ${name}`, `${agentCount} agent${agentCount === 1 ? '' : 's'}`, compositionMode, ...extras];
    return summaryParts.join(' · ');
  }

  function buildCompactTeamStatusMessage(teamState = {}, { chatId = '', runtime = null } = {}) {
    const session = chatSessionStore?.get?.(chatId) || {};
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const patternConflict = session?.pattern_conflict && typeof session.pattern_conflict === 'object' ? session.pattern_conflict : null;
    const pendingApplyGuardrails = pendingTeam ? buildTeamTransitionGuardrails(activeTeam, pendingTeam) : null;
    const lines = [
      'Team',
      summarizeTeamSlot('active', activeTeam),
      summarizeTeamSlot('pending', pendingTeam),
    ];

    if (runtime?.conversationInfo?.executionLane) {
      lines.push(`lane: ${String(runtime.conversationInfo.executionLane)}`);
    }
    if (pendingInstallProposal) {
      lines.push(`install proposal: ${String(pendingInstallProposal.status || 'awaiting_install_approval')} · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}`);
    }
    if (patternConflict?.classification) {
      lines.push(`pattern conflict: ${String(patternConflict.classification)}`);
    }
    if (pendingApplyGuardrails?.warning_count > 0) {
      lines.push(`apply check: warnings ${Number(pendingApplyGuardrails.warning_count || 0)}`);
    }

    const nextSteps = [];
    if (pendingTeam) {
      nextSteps.push(pendingApplyGuardrails?.destructive_changes_present ? '/team apply (confirm twice)' : '/team apply');
      nextSteps.push('/team refine <수정>');
    } else if (activeTeam) {
      nextSteps.push('/chat <요청>');
      nextSteps.push('/team suggest <목적>');
    } else {
      nextSteps.push('/team suggest <목적>');
      nextSteps.push('/team create <설명>');
    }
    if (pendingInstallProposal) nextSteps.push('/team proposal');

    lines.push('', 'Next', ...nextSteps.map((entry) => `- ${entry}`), '', 'More', '- /team details', '- /team more');
    return lines.join('\n');
  }



  async function resumeFromInstallProposal({ state = null, runtime = null, chatId = '', userId = '', currentTeam = null } = {}) {
    const resume = state?.resume_request && typeof state.resume_request === 'object' ? state.resume_request : null;
    if (!resume?.message || typeof runSupervisorChat !== 'function') return false;
    await runSupervisorChat(bot, chatId, userId, resume.message, {
      debug: false,
      chatInfo: resume.chat_info && typeof resume.chat_info === 'object' ? resume.chat_info : { chat_id: String(chatId || '') },
      inputKind: resume.input_kind || 'install_resume',
      telegramMessageId: resume.telegram_message_id || null,
      userReplyToMessageId: resume.user_reply_to_message_id || null,
      forceMode: normalizeForceMode(resume.force_mode || 'normal'),
      teamConfig: currentTeam && typeof currentTeam === 'object' ? currentTeam : null,
    });
    return true;
  }

  async function requireCurrentRuntime(chatId, userId) {
    const currentJobId = resolveLiveJobIdForChat(chatId);
    if (!currentJobId || typeof loadSupervisorRuntime !== 'function') return null;
    try {
      return await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
    } catch {
      return null;
    }
  }

  function getCurrentThreadId(runtime = null) {
    return String(runtime?.map?.threadId || runtime?.threadId || '').trim();
  }

  function formatImprovementJobStatus(jobResponse = {}) {
    const job = jobResponse?.job && typeof jobResponse.job === 'object' ? jobResponse.job : {};
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    const latestReports = payload.latest_reports && typeof payload.latest_reports === 'object' ? payload.latest_reports : {};
    const lines = [
      'Improvement job',
      `- job_id: ${String(payload.job_id || payload.improvement_job_id || job.id || '-')}`,
      `- target: ${String(payload.improvement_target || '-')}`,
      `- runtime: ${String(payload.target_runtime || '-')}`,
      `- phase: ${String(payload.phase || '-')}`,
      `- status: ${String(payload.status || '-')}`,
      `- requested_by: ${String(payload.requested_by || '-')}`,
      `- workspace_root: ${String(payload.workspace_root || '-')}`,
      `- instruction: ${String(payload.instruction || job.text || '-').slice(0, 240)}`,
    ];
    const counts = payload.report_counts && typeof payload.report_counts === 'object' ? payload.report_counts : {};
    const countPairs = Object.entries(counts).map(([kind, count]) => `${kind}=${count}`);
    if (countPairs.length) lines.push(`- report_counts: ${countPairs.join(', ')}`);
    const latestPairs = Object.entries(latestReports).slice(0, 6).map(([kind, value]) => {
      const row = value && typeof value === 'object' ? value : {};
      return `- ${kind}: ${String(row.status || '-')}${row.phase ? ` @ ${String(row.phase)}` : ''}${row.summary ? ` · ${String(row.summary).slice(0, 120)}` : ''}`;
    });
    if (latestPairs.length) lines.push('', 'Latest reports', ...latestPairs);
    return lines.join('\n');
  }

  function formatAutomationSummary(result = {}) {
    const row = result && typeof result === 'object' ? result : {};
    const lines = [
      `- automation_status: ${String(row.status || '-')}`,
    ];
    if (row.patch) lines.push(`- patch: ${String(row.patch.status || '-')}`);
    if (row.tests) lines.push(`- tests: ${String(row.tests.status || '-')}`);
    if (row.canary) lines.push(`- canary: ${String(row.canary.status || '-')}`);
    if (row.promotion) lines.push(`- promotion: ${String(row.promotion.status || '-')}`);
    return lines.join('\n');
  }

  async function requireGocImprovementContext(chatId, userId) {
    const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
    const threadId = getCurrentThreadId(runtimeForGoc);
    if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
      return null;
    }
    return {
      runtime: runtimeForGoc,
      threadId,
      client: requireGocClient(),
    };
  }

  return async function handleTelegramCommand({ msg, text, chatId, userId }) {
    if (!String(text || "").startsWith("/")) return false;

    const rawText = String(text || "");
    const firstSpaceIndex = rawText.indexOf(" ");
    const rawArgs = firstSpaceIndex >= 0 ? rawText.slice(firstSpaceIndex + 1).trim() : "";
    const [cmd, ...rest] = rawText.split(/\s+/);
    const args = rawArgs || rest.join(" ").trim();

    if (cmd === "/help" || cmd === "/commands") {
      const sub = String(args || "").trim().toLowerCase();
      if (sub === "advanced" || sub === "more") {
        await bot.sendMessage(chatId, ADVANCED_HELP_TEXT);
        return true;
      }
      await bot.sendMessage(chatId, HELP_TEXT);
      return true;
    }

    if (cmd === "/whoami") {
      await bot.sendMessage(chatId, `chat_id=${chatId}\nuser_id=${userId}`);
      return true;
    }

    if (cmd === "/running") {
      await sendLong(bot, chatId, formatRunningJobs(chatId));
      return true;
    }

    if (cmd === "/stop") {
      const chatKey = String(chatId);
      const fromAwait = getAwait(chatId)?.jobId;
      const targetJobId = args || activeJobByChat.get(chatKey) || fromAwait;
      if (!targetJobId) {
        if (lastChatJobByChat.has(chatKey)) {
          resetChatSession(chatId);
          await bot.sendMessage(chatId, "✅ 현재 /chat 세션을 초기화했어요.");
          return true;
        }
        await bot.sendMessage(chatId, `중단할 jobId를 찾지 못했어요. Usage: /stop <jobId>\n\n${formatRunningJobs(chatId)}`);
        return true;
      }

      const { aborted, dropped } = cancelJobExecution(targetJobId);
      if (activeJobByChat.get(chatKey) === String(targetJobId)) activeJobByChat.delete(chatKey);
      if (fromAwait && String(fromAwait) === String(targetJobId)) clearAwait(chatId);
      if (lastChatJobByChat.get(chatKey) === String(targetJobId)) lastChatJobByChat.delete(chatKey);
      chatSessionStore.upsert(chatId, (session) => {
        if (String(session.jobId || "").trim() && String(session.jobId || "").trim() !== String(targetJobId).trim()) {
          return session;
        }
        return {
          ...session,
          interrupt: {
            requested: true,
            mode: "cancel",
            reason: "/stop",
            ts: new Date().toISOString(),
          },
          pending_user_messages: [],
          pending_approval: null,
          state: "idle",
        };
      });

      if (!aborted && dropped === 0) {
        await bot.sendMessage(chatId, `중단할 실행이 없어요. (jobId=${targetJobId})\n이미 종료되었거나 큐에 없습니다.\n\n${formatRunningJobs(chatId)}`);
        return true;
      }
      await bot.sendMessage(chatId, `⏹️ 중단 요청 완료\njobId=${targetJobId}\n실행중 중단=${aborted}\n큐 제거=${dropped}`);
      return true;
    }

    if (cmd === "/memory" || cmd === "/settings") {
      const sub = String(rest[0] || "show").trim().toLowerCase();

      if (sub === "show") {
        await sendLong(bot, chatId, formatMemorySummary());
        return true;
      }

      if (sub === "md") {
        await sendLong(bot, chatId, memory.readMarkdown());
        return true;
      }

      if (sub === "kb") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 knowledge base profile을 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        await sendLong(bot, chatId, tracking.renderProfileMarkdown(currentJobId));
        return true;
      }

      if (sub === "compact" || sub === "compaction") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 compaction candidate를 생성할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        try {
          const candidate = writeIdleCompactionCandidate({ jobDir: jobs.jobDir(currentJobId) });
          await sendLong(bot, chatId, formatIdleCompactionCandidateForTelegram(candidate));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ compaction candidate 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "topology" || sub === "topo" || sub === "map") {
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!currentJobId) {
          await bot.sendMessage(chatId, "현재 job이 없어 memory topology를 표시할 수 없습니다. /chat 또는 /run 으로 job을 먼저 시작하세요.");
          return true;
        }
        try {
          const topology = planMemoryTopology({ jobDir: jobs.jobDir(currentJobId), persist: true, eventReason: 'telegram_memory_topology' });
          await sendLong(bot, chatId, formatMemoryTopologyForTelegram(topology));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ memory topology 생성 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "reset") {
        memory.reset();
        await sendLong(bot, chatId, `✅ 메모리를 기본값으로 되돌렸습니다.\n\n${formatMemorySummary()}`);
        return true;
      }

      if (sub === "policy") {
        const value = rest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory policy <자연어 프롬프트>");
          return true;
        }
        try {
          memory.setPolicyPrompt(value);
          await sendLong(bot, chatId, `✅ reflection prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "routing") {
        const value = rest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory routing <자연어 프롬프트>");
          return true;
        }
        try {
          memory.setRouterPrompt(value);
          await sendLong(bot, chatId, `✅ router prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "role") {
        const agent = String(rest[1] || "").trim().toLowerCase();
        const value = rest.slice(2).join(" ").trim();
        if (!agent || !value) {
          await bot.sendMessage(chatId, "Usage: /memory role <gemini|codex|chatgpt> <자연어 역할>");
          return true;
        }
        try {
          memory.setAgentRole(agent, value);
          await sendLong(bot, chatId, `✅ ${agent} role 업데이트 완료.\n\n${formatAgentMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ role 업데이트 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "agents") {
        await sendLong(bot, chatId, formatAgentMemorySummary());
        return true;
      }

      if (sub === "note") {
        const value = rest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory note <메모>");
          return true;
        }
        try {
          memory.addOperatorNote(value);
          await sendLong(bot, chatId, `✅ operator note 추가 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 메모 추가 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === "lesson") {
        const value = rest.slice(1).join(" ").trim();
        if (!value) {
          await bot.sendMessage(chatId, "Usage: /memory lesson <교훈>");
          return true;
        }
        try {
          memory.addRecentLesson(value);
          await sendLong(bot, chatId, `✅ recent lesson 추가 완료.\n\n${formatMemorySummary()}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 교훈 추가 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      await bot.sendMessage(chatId, "Usage:\n/memory show\n/memory md\n/memory kb\n/memory policy <자연어 프롬프트>\n/memory routing <자연어 프롬프트>\n/memory role <gemini|codex|chatgpt> <자연어 역할>\n/memory agents\n/memory note <메모>\n/memory lesson <교훈>\n/memory compact\n/memory topology\n/memory reset");
      return true;
    }

    if (cmd === "/gptdone") {
      clearAwait(chatId);
      await bot.sendMessage(chatId, "✅ gpt paste 모드를 종료했어요.");
      return true;
    }

    if (cmd === "/models" || cmd === "/modelnodes") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      if (sub === 'health') {
        const nodes = await listModelNodesWithHealth({ includeDisabled: true, timeoutMs: Number(process.env.MODEL_NODE_HEALTH_TIMEOUT_MS || 4000) || 4000 });
        if (!nodes.length) {
          await bot.sendMessage(chatId, "등록된 model node가 없습니다. config/model_nodes.json 또는 LOCAL_MODEL_BASE_URL + LOCAL_MODEL 환경변수로 추가할 수 있습니다.");
          return true;
        }
        const lines = ["Model node health:"];
        nodes.slice(0, 20).forEach((node, index) => {
          const h = node.health || {};
          lines.push(`${index + 1}. ${node.label || node.id} · ${node.provider}/${node.model} · ${h.ok ? "ok" : "not ready"} (${h.status || "-"})`);
          if (h.http_status) lines.push(`   - http=${h.http_status}`);
          if (h.error) lines.push(`   - error=${String(h.error).slice(0, 180)}`);
        });
        await sendLong(bot, chatId, lines.join("\n"));
        return true;
      }
      if (sub === 'usage') {
        const rows = readRecentModelNodeUsage({ limit: Number(rest[1] || 10) || 10 });
        if (!rows.length) {
          await bot.sendMessage(chatId, "최근 model node usage 기록이 없습니다.");
          return true;
        }
        const lines = ["Recent model node usage:"];
        rows.forEach((row, index) => {
          const node = row.model_node || {};
          lines.push(`${index + 1}. ${row.timestamp || "-"} · ${node.label || node.id || row.model || "-"} · ${row.ok ? "ok" : "fail"} · ${row.duration_ms || 0}ms`);
          lines.push(`   - agent=${row.agent_id || "-"} model=${row.model || "-"} prompt=${row.prompt_chars || 0} output=${row.output_chars || 0} trace=${row.trace_id || "-"}`);
          const access = row.context_access || {};
          if (access.projection_id || access.snapshot_id || access.memory_mode) {
            lines.push(`   - context projection=${access.projection_id || "-"} snapshot=${access.snapshot_id || "-"} memory=${access.memory_mode || "-"}`);
          }
        });
        await sendLong(bot, chatId, lines.join("\n"));
        return true;
      }
      const nodes = listModelNodes({ includeDisabled: true });
      if (!nodes.length) {
        await bot.sendMessage(chatId, "등록된 model node가 없습니다. config/model_nodes.json 또는 LOCAL_MODEL_BASE_URL + LOCAL_MODEL 환경변수로 추가할 수 있습니다.");
        return true;
      }
      const lines = ["Model nodes:", "Usage: /models health · /models usage [limit]"];
      nodes.slice(0, 20).forEach((node, index) => {
        const caps = Object.entries(node.capabilities || {}).filter(([, enabled]) => enabled === true).map(([key]) => key).slice(0, 6).join(", ") || "chat";
        const perms = [node.permissions?.memory_read ? "memory_read=" + node.permissions.memory_read : "", node.permissions?.memory_write ? "memory_write=" + node.permissions.memory_write : "", node.permissions?.workspace_read ? "workspace_read" : "", node.permissions?.workspace_write ? "workspace_write" : ""].filter(Boolean).join(", ") || "scoped_context";
        lines.push(`${index + 1}. ${node.label || node.id} · ${node.provider}/${node.model} · ${node.enabled === false ? "disabled" : "enabled"}`);
        lines.push(`   - node_id=${node.id} runtime=${node.runtime || "-"} location=${node.location || "-"}`);
        lines.push(`   - capabilities=${caps}`);
        lines.push(`   - permissions=${perms}`);
      });
      await sendLong(bot, chatId, lines.join("\n"));
      return true;
    }

    if (cmd === "/status") {
      const detailArg = String(rest[0] || '').trim().toLowerCase();
      const detail = ['full', 'detail', 'details', 'verbose'].includes(detailArg)
        ? 'full'
        : (['recent', 'activity', 'progress'].includes(detailArg)
          ? 'recent'
          : (['prompt', 'tokens', 'telemetry'].includes(detailArg) ? 'prompt' : 'compact'));
      await sendChatStatus(bot, chatId, { telegramUserId: userId, detail });
      return true;
    }

    if (cmd === "/agents") {
      await bot.sendMessage(chatId, '이제 /agents 는 제거되었습니다. team 관련 작업은 /team 을 사용해 주세요.');
      return true;
    }

    if (cmd === "/team") {
      const sub = String(rest[0] || "").trim().toLowerCase();
      let teamState = getSessionTeamState(chatSessionStore, chatId);
      const currentJobId = resolveLiveJobIdForChat(chatId);
      let runtimeForTeam = null;
      if (currentJobId && typeof loadSupervisorRuntime === 'function') {
        try {
          runtimeForTeam = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
        } catch {}
      }
      if (runtimeForTeam) {
        await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam }).catch(() => null);
        teamState = getSessionTeamState(chatSessionStore, chatId);
      }
      if (!sub) {
        await bot.sendMessage(chatId, buildCompactTeamStatusMessage(teamState, { chatId, runtime: runtimeForTeam }));
        return true;
      }
      if (sub === 'help') {
        await bot.sendMessage(chatId, TEAM_CORE_HELP_TEXT);
        return true;
      }
      if (sub === 'details' || sub === 'status') {
        await sendLong(bot, chatId, `${buildTeamStatusOverview(teamState, { chatId, runtime: runtimeForTeam })}

${TEAM_CORE_HELP_TEXT}`);
        return true;
      }
      if (sub === 'more') {
        await sendLong(bot, chatId, TEAM_ADVANCED_HELP_TEXT);
        return true;
      }
      if (sub === 'suggest') {
        const goal = String(rawArgs.replace(/^suggest\s+/i, '') || '').trim();
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /team suggest [--fast|--template|--mode freeform] <목적>');
          return true;
        }
        const freeformMatch = goal.match(/^--mode\s+freeform\s+([\s\S]+)$/i);
        const fastMatch = goal.match(/^--(?:fast|template|heuristic)\s+([\s\S]+)$/i);
        const effectiveGoal = String(freeformMatch?.[1] || fastMatch?.[1] || goal).trim();
        const useHeuristicTemplate = Boolean(fastMatch);
        if (!useHeuristicTemplate) {
          await bot.sendMessage(chatId, 'LLM planner를 우선 시도하고, 사용할 수 없으면 heuristic fallback으로 team 초안을 구성합니다. 빠른 템플릿 모드는 /team suggest --fast <목적> 을 사용하세요.');
        }
        let proposal;
        try {
          proposal = useHeuristicTemplate
            ? suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam })
            : {
                ...(await createFreeformTeamConfigurationAdvanced({ description: effectiveGoal, runtime: runtimeForTeam, jobId: currentJobId })),
                proposal_mode: 'suggest',
              };
        } catch (error) {
          proposal = {
            ...suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_suggest_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackProposal = suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: effectiveGoal, runtime: runtimeForTeam, primaryTeam: proposal, fallbackTeam: fallbackProposal, activeTeam: teamState.active_team });
        proposal = portfolio.selected_team || proposal;
        storePendingTeam(chatSessionStore, chatId, proposal, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }
      if (sub === 'create') {
        const description = String(rawArgs.replace(/^create\s+/i, '') || '').trim();
        if (!description) {
          await bot.sendMessage(chatId, 'Usage: /team create <자연어 팀 설명>\n\n더 많은 옵션: /team more');
          return true;
        }
        await bot.sendMessage(chatId, '해당 요청에 맞는 팀 구성을 진행합니다. LLM planner를 사용할 수 없으면 fallback 경로를 사용합니다.');
        let proposal;
        try {
          proposal = await createFreeformTeamConfigurationAdvanced({ description, runtime: runtimeForTeam, jobId: currentJobId });
        } catch (error) {
          proposal = {
            ...createFreeformTeamConfiguration({ description, runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_create_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackProposal = createFreeformTeamConfiguration({ description, runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: description, runtime: runtimeForTeam, primaryTeam: proposal, fallbackTeam: fallbackProposal, activeTeam: teamState.active_team });
        proposal = portfolio.selected_team || proposal;
        storePendingTeam(chatSessionStore, chatId, proposal, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }
      if (sub === 'refine') {
        const instruction = String(rawArgs.replace(/^refine\s+/i, '') || '').trim();
        const baseTeam = teamState.pending_team || teamState.active_team;
        if (!baseTeam) {
          await bot.sendMessage(chatId, '수정할 팀이 없습니다. 먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 을 실행해 주세요.');
          return true;
        }
        if (!instruction) {
          await bot.sendMessage(chatId, 'Usage: /team refine <자연어 수정>\n\n더 많은 옵션: /team more');
          return true;
        }
        await bot.sendMessage(chatId, '기존 팀 구성을 바탕으로 수정안을 다시 설계합니다. LLM planner를 사용할 수 없으면 fallback 경로를 사용합니다.');
        let next;
        try {
          next = await refineTeamConfigurationAdvanced({ team: baseTeam, instruction, runtime: runtimeForTeam, jobId: currentJobId });
        } catch (error) {
          next = {
            ...refineTeamConfiguration(baseTeam, instruction, { runtime: runtimeForTeam }),
            planner_metadata: {
              planner_type: 'heuristic_rule_based',
              planning_source: 'telegram_refine_exception_fallback',
              reasoning_summary: [String(error?.message || error || 'LLM planner failed').slice(0, 180)],
            },
          };
        }
        const fallbackNext = refineTeamConfiguration(baseTeam, instruction, { runtime: runtimeForTeam });
        const portfolio = buildTeamSelectionPortfolio({ taskText: `${baseTeam.task_brief || baseTeam.design_prompt || ''}
Refine: ${instruction}`, runtime: runtimeForTeam, primaryTeam: next, fallbackTeam: fallbackNext, activeTeam: teamState.active_team });
        next = portfolio.selected_team || next;
        storePendingTeam(chatSessionStore, chatId, next, { portfolio });
        await sendLong(bot, chatId, `${formatTeamProposalMessage(next, { runtime: runtimeForTeam })}

${formatTeamCandidatePortfolioMessage(portfolio)}`);
        return true;
      }

      const handledTeamManifestSubcommand = await handleTelegramTeamBlueprintSubcommand({
        sub,
        rest,
        rawArgs,
        bot,
        sendLong,
        chatId,
        userId,
        teamState,
        runtimeForTeam,
        chatSessionStore,
        memoryModeWithFallback,
        requireGocClient,
        applyPendingTeam,
        storePendingTeam,
        formatTeamProposalMessage,
        loadSupervisorRuntime,
        runSupervisorChat,
        normalizeForceMode,
        resolveLiveJobIdForChat,
        jobs,
      });
      if (handledTeamManifestSubcommand) return true;
      // legacy team blueprint subcommand handlers were removed.
      // /team proposal|install-plan|requirements|export|install|import|pull|push are handled only by handleTelegramTeamBlueprintSubcommand.
      if (sub === 'template') {
        await bot.sendMessage(chatId, TEAM_TEMPLATE_DEPRECATED_TEXT);
        return true;
      }
      if (sub === 'debug') {
        const debugArg = String(rawArgs.replace(/^debug\s*/i, '') || '').trim();
        if (!debugArg) {
          await bot.sendMessage(chatId, TEAM_DEBUG_HELP_TEXT);
          return true;
        }
        if (/^(templates?|template\s+(?:catalog|benchmarks?))$/i.test(debugArg)) {
          await sendLong(bot, chatId, buildBenchmarkTemplateCatalogText());
          return true;
        }
        if (/^template\s+current$/i.test(debugArg)) {
          const baseTeam = teamState.pending_team || teamState.active_team;
          if (!baseTeam) {
            await bot.sendMessage(chatId, '출력할 team이 없습니다. 먼저 /team suggest <목적> 또는 /team create <설명> 으로 pending team을 만든 뒤 다시 시도하세요.');
            return true;
          }
          await sendLong(bot, chatId, buildTeamConfigurationTemplate(baseTeam));
          return true;
        }
        const match = debugArg.match(/^template\s+(?:benchmark|bench)\s+([a-z0-9_.-]+)$/i);
        if (match) {
          const bench = buildBenchmarkTeamTemplate(match[1], {});
          if (!bench) {
            await bot.sendMessage(chatId, `알 수 없는 benchmark template: ${String(match[1] || '')}. /team debug templates 로 목록을 확인하세요.`);
            return true;
          }
          const validated = validateTeamConfiguration({ ...bench, proposal_mode: 'suggest' }, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, validated);
          await sendLong(bot, chatId, `✅ debug benchmark template을 pending team으로 불러왔습니다.

${formatTeamProposalMessage(validated, { runtime: runtimeForTeam })}`);
          return true;
        }
        await bot.sendMessage(chatId, TEAM_DEBUG_HELP_TEXT);
        return true;
      }
      if (sub === 'validate') {
        const payload = String(rawArgs.replace(/^validate\s+/i, '') || '').trim();
        if (!payload) {
          await bot.sendMessage(chatId, 'Usage: /team validate <JSON template>');
          return true;
        }
        try {
          const parsed = parseTeamTemplate(payload);
          const validated = validateTeamConfiguration(parsed, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, validated);
          await sendLong(bot, chatId, `✅ 팀 템플릿 검증 완료

${formatTeamProposalMessage(validated, { runtime: runtimeForTeam })}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 템플릿 검증 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'apply') {
        try {
          const confirmApply = /(?:^|\s)confirm(?:\s|$)/i.test(rest || '');
          const applySelector = String(rest || '').replace(/confirm/i, '').trim();
          if (applySelector) {
            const selected = selectPendingTeamCandidate(chatSessionStore, chatId, applySelector, { runtime: runtimeForTeam });
            teamState = getSessionTeamState(chatSessionStore, chatId);
            await sendLong(bot, chatId, `✅ team candidate ${applySelector}를 pending team으로 선택했습니다.

${formatTeamCandidatePortfolioMessage(selected.portfolio)}`);
          }
          const activeTeam = teamState?.active_team || null;
          const pendingTeam = teamState?.pending_team || null;
          const requiresApproval = teamConfigChangeRequiresApproval(activeTeam, pendingTeam);
          if (requiresApproval && !confirmApply) {
            const guardrails = buildTeamTransitionGuardrails(activeTeam, pendingTeam);
            await sendLong(bot, chatId, [
              '⚠️ team 변경 적용 전 승인 확인이 필요합니다.',
              '현재 active team과 다른 pending team이 준비되어 있습니다.',
              ...(guardrails?.warning_count > 0 ? formatTeamTransitionGuardrailLines(guardrails, { maxWarnings: 5 }) : []),
              '',
              '승인하려면 /team apply confirm',
              '검토하려면 /team details',
            ].filter(Boolean).join('\n'));
            return true;
          }
          const applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
          await sendLong(bot, chatId, `✅ 활성 팀 적용 완료

${buildTeamListMessage({ active_team: applied }, { runtime: runtimeForTeam })}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 적용 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'options') {
        const portfolio = teamState?.pending_team_portfolio;
        if (portfolio) {
          await sendLong(bot, chatId, formatTeamCandidatePortfolioMessage(portfolio, { verbose: true }));
        } else {
          await sendLong(bot, chatId, buildTeamSchemaOptionsText());
        }
        return true;
      }
      if (sub === 'roles' || sub === 'patterns' || sub === 'schema') {
        await sendLong(bot, chatId, buildTeamSchemaOptionsText());
        return true;
      }
      if (sub === 'modes') {
        await sendLong(bot, chatId, [
          'Team composition modes:',
          '- LLM planner: /team suggest <목적>',
          '  canonical role/skill/model 후보를 안전하게 조합합니다.',
          '- freeform: /team create <자연어 팀 설명>',
          '  더 자유로운 agent 이름/책임/상호작용을 제안한 뒤 structured contract로 정규화합니다.',
          '- fast template: /team suggest --fast <목적>',
        ].join('\n'));
        return true;
      }
      if (sub === 'reset') {
        await resetTeamConfiguration(chatSessionStore, chatId, { runtime: runtimeForTeam });
        await bot.sendMessage(chatId, '✅ 팀 구성을 초기화했습니다. 다시 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 시작해 주세요.');
        return true;
      }
      await bot.sendMessage(chatId, `알 수 없는 /team 명령입니다.\n\n${TEAM_CORE_HELP_TEXT}`);
      return true;
    }

    if (cmd === "/credential") {
      return handleTelegramCredentialCommand({
        bot,
        chatId,
        rawArgs,
        chatSessionStore,
        resolveLiveJobIdForChat,
        jobs,
        loadSupervisorRuntime,
        userId,
        runSupervisorChat,
        normalizeForceMode,
        chatType: msg?.chat?.type || '',
        telegramMessageId: msg?.message_id ?? null,
      });
    }

    if (cmd === "/skills") {
      const skillsArgs = ["skills", ...rest].join(" ").trim();
      await sendAgentOrToolListQuick(bot, chatId, "agent", skillsArgs, { telegramUserId: userId });
      return true;
    }

    if (cmd === "/tools") {
      await sendAgentOrToolListQuick(bot, chatId, "tool", "", { telegramUserId: userId });
      return true;
    }

    if (cmd === "/files") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const first = String(rest[0] || "").trim().toLowerCase();
      const hasScope = ["uploads", "workspace", "artifacts", "outputs", "all"].includes(first);
      const scope = hasScope ? first : "all";
      const limit = parseClampedInt(hasScope ? rest[1] : rest[0], 20, { min: 1, max: 100 });
      const entries = collectWorkspaceFileEntries(currentJobId, { scope }).slice(0, limit);
      await sendLong(
        bot,
        chatId,
        `📂 workspace files
${formatWorkspaceFileListText(currentJobId, entries, { scope, limit })}`
      );
      return true;
    }

    if (cmd === "/outputs") {
      await bot.sendMessage(chatId, '이제 /outputs 는 제거되었습니다. 결과물은 /artifacts 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/artifacts") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const limit = parseClampedInt(rest[0], 12, { min: 1, max: 24 });
      const artifactIndex = refreshArtifactIndex(currentJobId, { maxFiles: limit });
      let runtime = null;
      if (typeof loadSupervisorRuntime === 'function') {
        try {
          runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
        } catch {}
      }
      const contract = resolveArtifactDeliveryContract(currentJobId, runtime);
      const sections = [`📎 artifacts
${formatArtifactIndexText(currentJobId, artifactIndex, { limit })}`];
      const contractLines = formatArtifactDeliveryContractLines(contract);
      if (contractLines.length > 0) sections.push(`publish contract
${contractLines.join('\n')}`);
      await sendLong(bot, chatId, sections.join('\n\n'));
      return true;
    }

    if (cmd === "/sendfile") {
      await bot.sendMessage(chatId, '이제 /sendfile 은 제거되었습니다. /send <번호|path> 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/send") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const selection = String(args || '').trim();
      if (!selection) {
        await bot.sendMessage(chatId, 'Usage: /send <번호|path>\n또는 /send bundle <번호,번호|path,...>');
        return true;
      }
      try {
        const artifactIndex = refreshArtifactIndex(currentJobId, { maxFiles: 12 });
        let runtime = null;
        if (typeof loadSupervisorRuntime === 'function') {
          try {
            runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
          } catch {}
        }
        const contract = resolveArtifactDeliveryContract(currentJobId, runtime);
        const bundle = parseArtifactBundleSelection(selection);
        if (bundle) {
          if (!sendArtifactBundle) throw new Error('bundle send is not available');
          const sentBundle = await sendArtifactBundle(bot, chatId, currentJobId, bundle.items, {
            replyToMessageId: msg.message_id,
            artifactIndex,
            runtime,
          });
          await bot.sendMessage(
            chatId,
            `✅ 번들 전송 완료
job_id=${currentJobId}
files=${sentBundle.entries.length}
name=${sentBundle.fileName}
size=${formatByteSize(sentBundle.size)}`
          );
          return true;
        }
        const sent = await sendArtifactBySelection(bot, chatId, currentJobId, selection, {
          replyToMessageId: msg.message_id,
          artifactIndex,
        });
        const messageLines = [
          '✅ 파일 전송 완료',
          `job_id=${currentJobId}`,
          `path=${sent.rel}`,
          `size=${formatByteSize(sent.size)}`,
        ];
        if (Array.isArray(contract?.warnings) && contract.warnings.length > 0) {
          messageLines.push('publish_contract_warnings:');
          for (const warning of contract.warnings.slice(0, 2)) messageLines.push(`- ${warning}`);
        }
        await bot.sendMessage(chatId, messageLines.join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /send 실패: ${clip(String(e?.message ?? e), 260)}`);
      }
      return true;
    }

    if (cmd === "/improve") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const context = await requireGocImprovementContext(chatId, userId);
      if (!context) {
        await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 improvement job을 만들 수 없습니다.');
        return true;
      }
      const { runtime: runtimeForGoc, threadId, client } = context;
      if (sub === 'status') {
        const jobId = String(rest[1] || '').trim();
        if (!jobId) {
          await bot.sendMessage(chatId, 'Usage:\n/improve status <jobId>');
          return true;
        }
        try {
          const payload = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, formatImprovementJobStatus(payload));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve status 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'test' || sub === 'canary' || sub === 'review' || sub === 'gate' || sub === 'promote' || sub === 'rollback') {
        const jobId = String(rest[1] || '').trim();
        if (!jobId) {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <jobId>`);
          return true;
        }
        try {
          const loaded = await loadImprovementExecutionContext({ client, threadId, jobId });
          let stageResult = null;
          if (sub === 'test') stageResult = await runImprovementTests({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'canary') stageResult = await runImprovementCanary({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'review') stageResult = await runImprovementReview({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'gate') stageResult = await runImprovementEvalGate({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'promote') stageResult = await markImprovementPromotion({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          if (sub === 'rollback') stageResult = await runImprovementRollback({ client, threadId, jobId, targetConfig: loaded.targetConfig });
          const refreshed = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, [
            `✅ /improve ${sub} 완료`,
            `- job_id: ${jobId}`,
            `- status: ${String(stageResult?.status || '-')}`,
            `- duration_ms: ${String(stageResult?.duration_ms || '-')}`,
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve ${sub} 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'execute' || sub === 'run') {
        const jobId = String(rest[1] || '').trim();
        const mode = String(rest[2] || '').trim().toLowerCase();
        if (!jobId) {
          await bot.sendMessage(chatId, 'Usage:\n/improve execute <jobId> [full]');
          return true;
        }
        try {
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
          const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
          const loaded = await loadImprovementExecutionContext({ client, threadId, jobId });
          const automation = await runImprovementAutomation({
            client,
            threadId,
            jobId,
            targetConfig: loaded.targetConfig,
            autoPromote: mode === 'full',
            board,
          });
          const refreshed = await client.getImprovementJob(threadId, jobId);
          await sendLong(bot, chatId, [
            `✅ /improve execute 완료`,
            `- job_id: ${jobId}`,
            formatAutomationSummary(automation),
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve execute 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'auto' || sub === 'full') {
        const targetRepo = String(rest[1] || '').trim().toLowerCase();
        const instruction = rawArgs.split(/\s+/).slice(2).join(' ').trim();
        if (targetRepo !== 'ddalggak' && targetRepo !== 'goc') {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <ddalggak|goc> <instruction>`);
          return true;
        }
        if (!instruction) {
          await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <ddalggak|goc> <instruction>`);
          return true;
        }
        try {
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
          const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
          const prepared = await inspectAndPrepareImprovementJob({
            client,
            threadId,
            targetRepo,
            instruction,
            requestedBy: `telegram:${userId}` ,
            board,
            autoMode: true,
            autoPromote: sub === 'full',
          });
          const automation = await runImprovementAutomation({
            client,
            threadId,
            jobId: prepared.jobId,
            targetConfig: prepared.targetConfig,
            autoPromote: sub === 'full',
            board,
          });
          const refreshed = await client.getImprovementJob(threadId, prepared.jobId);
          await sendLong(bot, chatId, [
            `✅ /improve ${sub} 완료`,
            `- job_id: ${prepared.jobId}`,
            `- target: ${targetRepo}`,
            `- workspace_root: ${String(prepared.targetConfig.workspace_root || '-')}`,
            `- target_runtime: ${String(prepared.targetConfig.target_runtime || '-')}`,
            formatAutomationSummary(automation),
            '',
            formatImprovementJobStatus(refreshed),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /improve ${sub} 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub !== 'ddalggak' && sub !== 'goc') {
        await bot.sendMessage(chatId, 'Usage:\n/improve <ddalggak|goc> <instruction>\n/improve auto <ddalggak|goc> <instruction>\n/improve full <ddalggak|goc> <instruction>\n/improve execute <jobId> [full]\n/improve status <jobId>\n/improve test <jobId>\n/improve canary <jobId>\n/improve review <jobId>\n/improve gate <jobId>\n/improve promote <jobId>\n/improve rollback <jobId>');
        return true;
      }
      const instruction = rawArgs.slice(sub.length).trim();
      if (!instruction) {
        await bot.sendMessage(chatId, `Usage:\n/improve ${sub} <instruction>`);
        return true;
      }
      try {
        const teamState = getSessionTeamState(chatSessionStore, chatId);
        await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState }).catch(() => null);
        const board = await client.getThreadBoard(threadId).catch(() => ({ lanes: [], counts: {} }));
        const prepared = await inspectAndPrepareImprovementJob({
          client,
          threadId,
          targetRepo: sub,
          instruction,
          requestedBy: `telegram:${userId}`,
          board,
        });
        const testResult = await runImprovementTests({ client, threadId, jobId: prepared.jobId, targetConfig: prepared.targetConfig });
        const canaryResult = await runImprovementCanary({ client, threadId, jobId: prepared.jobId, targetConfig: prepared.targetConfig });
        const refreshed = await client.getImprovementJob(threadId, prepared.jobId);
        await sendLong(bot, chatId, [
          `✅ improvement job 생성: ${prepared.jobId}`,
          `- target: ${sub}`,
          `- workspace_root: ${String(prepared.targetConfig.workspace_root || '-')}`,
          `- target_runtime: ${String(prepared.targetConfig.target_runtime || '-')}`,
          `- tests: ${String(testResult?.status || '-')}`,
          `- canary: ${String(canaryResult?.status || '-')}`,
          '',
          formatImprovementJobStatus(refreshed),
        ].join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /improve 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/goc") {
      const sub = String(rest[0] || '').trim().toLowerCase();
      const action = String(rest[1] || '').trim().toLowerCase();
      if (sub === 'history' && (!action || action === 'push' || action === 'sync')) {
        const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
        const threadId = getCurrentThreadId(runtimeForGoc);
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 raw history를 push 할 수 없습니다.');
          return true;
        }
        try {
          const client = requireGocClient();
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          const synced = await syncRawHistoryToGoC({ client, threadId, chatId, chatSessionStore, runtime: runtimeForGoc, teamState });
          const derivedCount = Number(synced?.saved?.derived_candidates?.count || 0);
          await sendLong(bot, chatId, [
            '✅ raw history snapshot을 GoC Board로 동기화했습니다.',
            `- thread_id: ${threadId}`,
            `- stream_key: ${String(synced?.snapshot?.stream_key || '-')}`,
            `- summary: ${String(synced?.snapshot?.summary || '-')}`,
            `- derived_candidates: ${derivedCount}`,
            '- policy: visible in board / raw history excluded from learning',
            '- structured candidates stay in review lane until promoted',
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /goc history push 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'candidate' && action === 'approve') {
        const runtimeForGoc = await requireCurrentRuntime(chatId, userId);
        const threadId = getCurrentThreadId(runtimeForGoc);
        const candidateNodeId = String(rest[2] || '').trim();
        const publishToLibrary = String(rest[3] || '').trim().toLowerCase() === 'publish';
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 candidate를 승격할 수 없습니다.');
          return true;
        }
        if (!candidateNodeId) {
          await bot.sendMessage(chatId, 'Usage:\n/goc candidate approve <nodeId> [publish]');
          return true;
        }
        try {
          const client = requireGocClient();
          const result = await client.approveBoardCandidate(threadId, candidateNodeId, { publishToLibrary });
          await sendLong(bot, chatId, [
            publishToLibrary ? '✅ Board candidate를 승인하고 library로 publish했습니다.' : '✅ Board candidate를 승인하고 현재 thread 자산으로 승격했습니다.',
            `- thread_id: ${threadId}`,
            `- candidate_node_id: ${candidateNodeId}`,
            `- promoted_resource_kind: ${String(result?.promoted_resource_kind || '-')}`,
            `- promoted_node_id: ${String(result?.promoted_node?.id || '-')}`,
            `- target_thread_id: ${String(result?.target_thread_id || '-')}`,
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ /goc candidate approve 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      await bot.sendMessage(chatId, `Usage:\n/goc history push\n/goc candidate approve <nodeId> [publish]`);
      return true;
    }

    if (cmd === "/context") {
      try {
        const arg = String(rest[0] || "").trim();
        await sendContextInfo(bot, chatId, arg, {
          userId,
          createIfMissing: true,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /context 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/attach") {
      await bot.sendMessage(chatId, '이제 /attach 는 제거되었습니다. 파일 업로드는 /upload 를 사용해 주세요.');
      return true;
    }

    if (cmd === "/chat") {
      const raw = String(args || "").trim();
      if (!raw) {
        await bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");
        return true;
      }
      if (raw.toLowerCase() === "reset") {
        resetChatSession(chatId);
        await bot.sendMessage(chatId, "✅ /chat 세션을 초기화했습니다.");
        return true;
      }

      const parsed = parseChatMessageWithFlags(raw);
      const message = parsed.message;
      if (!message) {
        await bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");
        return true;
      }

      try {
        let teamState = getSessionTeamState(chatSessionStore, chatId);
        const currentJobId = resolveLiveJobIdForChat(chatId);
        if (!teamState.active_team && currentJobId && typeof loadSupervisorRuntime === 'function') {
          try {
            const runtimeForChat = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
            await hydrateSessionTeamStateFromConversationStore({ sessionStore: chatSessionStore, chatId, runtime: runtimeForChat }).catch(() => null);
            teamState = getSessionTeamState(chatSessionStore, chatId);
          } catch {}
        }
        await sendRouterAckMessage(bot, chatId, { replyToMessageId: msg.message_id });
        if (!parsed.debug) {
          await chatRunManager.handleIncoming({
            chatId,
            userId,
            text: message,
            kind: "normal",
            telegramMessageId: msg.message_id,
            userReplyToMessageId: Number.isFinite(Number(msg?.reply_to_message?.message_id)) ? Number(msg.reply_to_message.message_id) : null,
            teamConfig: teamState.active_team || null,
            chatInfo: {
              chat_id: String(chatId || ""),
              title: String(msg.chat?.title || msg.chat?.username || "").trim(),
              type: String(msg.chat?.type || "").trim(),
            },
          });
          return true;
        }
        await runSupervisorChat(bot, chatId, userId, message, {
          debug: parsed.debug,
          teamConfig: teamState.active_team || null,
          chatInfo: {
            chat_id: String(chatId || ""),
            title: String(msg.chat?.title || msg.chat?.username || "").trim(),
            type: String(msg.chat?.type || "").trim(),
          },
          inputKind: "command_chat",
          telegramMessageId: msg.message_id,
          userReplyToMessageId: Number.isFinite(Number(msg?.reply_to_message?.message_id)) ? Number(msg.reply_to_message.message_id) : null,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /chat 실패: ${String(e?.message ?? e)}`);
      }
      return true;
    }

    if (cmd === "/run") {
      if (!args) {
        await bot.sendMessage(chatId, "Usage: /run <goal>");
        return true;
      }
      await executeRunCommand({
        bot,
        chatId,
        userId,
        goal: args,
        createJob,
        resetJobAbortController,
        activeJobByChat,
        jobAbortControllers,
        runWorkspaceDir,
        loadSupervisorRuntime,
        decideRunRoute,
        tracking,
        actionLabel,
        executeRoutedPlan,
        suggestNextPrompt,
        isCancelledError,
      });
      return true;
    }

    if (cmd === "/continue") {
      if (!args) {
        await bot.sendMessage(chatId, "Usage: /continue <jobId>");
        return true;
      }
      await executeContinueCommand({
        bot,
        chatId,
        userId,
        jobId: args,
        resetJobAbortController,
        activeJobByChat,
        jobAbortControllers,
        runWorkspaceDir,
        tracking,
        extractCodexInstruction,
        loadSupervisorRuntime,
        getGoalFromResearch,
        decideRunRoute,
        actionLabel,
        executeRoutedPlan,
        suggestNextPrompt,
        isCancelledError,
      });
      return true;
    }

    if (cmd === "/gptprompt") {
      const parts = rest;
      const jobId = parts[0];
      const question = parts.slice(1).join(" ").trim();
      if (!jobId || !question) {
        await bot.sendMessage(chatId, "Usage: /gptprompt <jobId> <question>");
        return true;
      }

      jobs.appendConversation(jobId, "user", `/gptprompt ${question}`, { kind: "gptprompt" });
      await sendChatGPTPrompt(bot, chatId, jobId, question);
      return true;
    }

    if (cmd === "/gptapply") {
      const targetJobId = String(args || resolveLiveJobIdForChat(chatId) || "").trim();
      if (!targetJobId) {
        await bot.sendMessage(chatId, "Usage: /gptapply [jobId]");
        return true;
      }
      setAwait(chatId, targetJobId, userId);
      rememberLastChatJob(chatId, targetJobId);
      await bot.sendMessage(chatId, "🟣 이제 ChatGPT 답변을 그대로 붙여넣어 주세요. (20분 내)\nJSON 액션 플랜이 있으면 자동 실행됩니다.\n종료: /gptdone");
      return true;
    }

    if (cmd === "/commit") {
      const parts = rest;
      const jobId = parts[0];
      const message = parts.slice(1).join(" ").trim();
      if (!jobId || !message) {
        await bot.sendMessage(chatId, "Usage: /commit <jobId> <message>");
        return true;
      }
      const rec = approvals.request(jobId, {
        purpose: "git commit",
        summary: `Commit changes with message: ${message}`,
        payload: { action: "git_commit", message },
      });

      await bot.sendMessage(
        chatId,
        `🟡 커밋 승인 필요\njobId=${jobId}\nmessage=${message}\ntoken=${rec.token}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `approve:${jobId}:${rec.token}` },
              { text: "❌ Deny", callback_data: `deny:${jobId}:${rec.token}` },
            ]],
          },
        }
      );
      return true;
    }

    if (cmd.startsWith("/")) {
      await bot.sendMessage(chatId, "알 수 없는 명령입니다. /help 를 참고하세요.");
      return true;
    }

    return false;
  };
}
