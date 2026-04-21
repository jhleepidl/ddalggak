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

const HELP_TEXT = [
  "Commands:",
  "- /chat [text]: 대화/작업 지시",
  "- /team [suggest <목적>|create <자연어 팀 설명>|refine <자연어 수정>|expand [확장 방향]|apply|why|requirements|proposal|template|options]: 팀 제안/적용/점검",
  "- /status [full|recent|prompt]: 현재 단계·팀·최근 진행·prompt 효율 보기",
  "- /context [global]: 현재 job 컨텍스트/GoC 링크 보기",
  "- /artifacts [limit]: 주요 산출물 후보 보기",
  "- /send <번호|path>: 산출물 파일 전송",
  "- /send bundle <번호,번호|path,...>: 여러 산출물을 zip으로 전송",
  "- /stop [jobId]: 현재 실행 또는 지정 job 중단",
  "- /upload (+파일 첨부) [메모]: 실행 없이 업로드만 저장",
  "- /help advanced: credential/files/running 등 고급 명령 보기",
].join("\n");

const ADVANCED_HELP_TEXT = [
  "Commands:",
  "- /chat [text]: 대화/작업 지시",
  "- /whoami: 현재 chat_id / user_id 확인",
  "- /running: 실행/대기 job 목록 확인",
  "- /status [full|recent|prompt]: 현재 chat/job 상태와 최근 작업·prompt 효율 보기",
  "- /credential [list|pending|set <KEY> <secret> [--resume]|bind <KEY> env <ENV_KEY> [--resume]|clear <KEY>]: credential 바인딩 (env/local secret store 권장, set은 Telegram 노출 주의 fallback)",
  "- /stop [jobId]: 현재 실행 또는 지정 job 중단",
  "- /memory [show|md|kb|policy|routing|role|agents|note|lesson|reset]: 런타임 메모리/KB 조회·수정",
  "- /settings ...: /memory alias",
  "- /team [suggest <목적>|create <자연어 팀 설명>|refine <자연어 수정>|expand [확장 방향]|apply|why|requirements|proposal|export|install <JSON>|pull|push|template|validate <JSON>|options|reset|modes]: 팀 제안/생성/수정/동기화",
  "- /agents ...: legacy alias of /team (팀 상태/수정은 /team 권장)",
  "- /skills: 현재/예정 agent roster와 대표 skill 보기",
  "- /tools: 현재 job의 tool 상태 보기",
  "- /artifacts [limit]: 주요 산출물 후보 보기",
  "- /send <번호|path>: 산출물 파일 전송",
  "- /send bundle <번호,번호|path,...>: 여러 산출물을 zip으로 전송",
  "- /upload (+파일 첨부) [메모]: 실행 없이 업로드만 저장 (/attach는 legacy alias)",
  "- /files [uploads|workspace|all] [limit]: workspace 파일 목록 보기",
  "- /outputs [limit]: legacy alias of /artifacts",
  "- /sendfile <relative_path>: legacy alias of /send",
  "- /chat [--debug] <message>|reset: supervisor chat 실행 또는 세션 초기화",
  "- /context <jobId|global>: 컨텍스트 보기 (jobId 생략 시 현재 job)",
  "- /run <goal>: goal 기반 실행 시작",
  "- /continue <jobId>: 기존 job 이어서 실행",
  "- /gptprompt <jobId> <question>: GPT 확인용 프롬프트 생성",
  "- /gptapply [jobId]: GPT 응답 적용",
  "- /gptdone: GPT paste 대기 모드 종료",
  "- /commit <jobId> <message>: 작업 결과 커밋",
  ...buildTeamSchemaOptionsSummaryLines(),
  "- 실행 중 최신 유저 요청이 team pattern과 충돌하면 이번 turn에 한해 임시 execution override가 적용될 수 있습니다.",
  "- 팀 구조 자체를 바꾸려면 /team refine 를 사용하세요.",
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

  function labelTeamStrategyReason(code = '') {
    const value = String(code || '').trim().toLowerCase();
    const map = {
      augmentation_outweighs_role_split: 'context augmentation 이 role split보다 효율적',
      prefer_memory_skill_context_augmentation: 'memory/skill/context augmentation 우선',
      persistent_role_separation_has_clear_value: '지속 역할 분리 가치가 큼',
      independent_sidecar_is_justified: '독립 reviewer/sidecar 가치가 있음',
      single_agent_path_is_adequate: 'single-agent 경로로 충분함',
      missing_capability_or_skill: 'skill/capability 보강 필요',
      participant_noise_prefers_context_first: '잡음은 team보다 context 보강이 우선',
      contradiction_requires_better_context: '충돌 신호는 context 보강이 우선',
      quality_gap_present: '품질 격차가 남아 있음',
      quality_health_low: '품질 건강도가 낮음',
      followup_burden_present: '후속 질의 부담이 큼',
      code_task_can_start_with_inline_review_context: '코드 작업은 inline review로 시작 가능',
      code_review_benefits_from_sidecar: '코드 리뷰 sidecar가 유리함',
      independent_review_required: '독립 검토가 필요함',
      independent_verification_is_worthwhile: '독립 검증 가치가 있음',
      parallel_branching_value: '병렬 분기 가치가 있음',
      high_decomposability: '작업 분해 이득이 큼',
      moderate_decomposability: '작업 분해 이득이 중간 정도',
      multiple_durable_role_candidates: '지속 역할 후보가 여러 개',
      secondary_role_candidate_exists: '보조 역할 후보가 있음',
    };
    return map[value] || value;
  }

  function buildTeamStrategyLines(teamState = {}, session = {}) {
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingStrategy = pendingTeam?.planner_metadata?.adaptive_expansion && typeof pendingTeam.planner_metadata.adaptive_expansion === 'object'
      ? pendingTeam.planner_metadata.adaptive_expansion
      : null;
    const sessionStrategy = session?.last_team_strategy && typeof session.last_team_strategy === 'object'
      ? session.last_team_strategy
      : null;
    const activeStrategy = activeTeam?.planner_metadata?.adaptive_expansion && typeof activeTeam.planner_metadata.adaptive_expansion === 'object'
      ? activeTeam.planner_metadata.adaptive_expansion
      : null;
    const strategy = pendingStrategy || sessionStrategy || activeStrategy;
    const source = pendingStrategy ? 'pending_team_draft' : (sessionStrategy ? 'latest_run' : (activeStrategy ? 'active_team' : ''));
    if (!strategy) return [];
    const augmentation = strategy?.augmentation && typeof strategy.augmentation === 'object' ? strategy.augmentation : {};
    const roleSeparation = strategy?.role_separation && typeof strategy.role_separation === 'object' ? strategy.role_separation : {};
    const recommendation = String(strategy?.recommendation || '').trim().toLowerCase() || 'keep_single';
    const lines = ['Latest team strategy'];
    lines.push(`- source: ${source || 'latest_run'}`);
    lines.push(`- recommendation: ${recommendation}`);
    lines.push(`- scores: augmentation=${Number(augmentation.score || 0)} · role_separation=${Number(roleSeparation.score || 0)}`);
    const reasons = [
      ...(Array.isArray(strategy?.rationale) ? strategy.rationale : []),
      ...(Array.isArray(augmentation.reasons) ? augmentation.reasons : []),
      ...(Array.isArray(roleSeparation.reasons) ? roleSeparation.reasons : []),
    ].map((entry) => labelTeamStrategyReason(entry)).filter(Boolean);
    if (reasons.length > 0) {
      lines.push(`- why: ${Array.from(new Set(reasons)).slice(0, 4).join(' · ')}`);
    }
    const capabilityGapSummary = String(strategy?.capability_gap_summary || strategy?.capabilityGapSummary || '').trim();
    if (capabilityGapSummary) lines.push(`- capability_gaps: ${capabilityGapSummary}`);
    if (roleSeparation.independent_review_needed === true || roleSeparation.persistent_split_needed === true) {
      const detail = [];
      if (roleSeparation.independent_review_needed === true) detail.push('independent_review_needed');
      if (roleSeparation.persistent_split_needed === true) detail.push('persistent_split_needed');
      lines.push(`- role_split_signals: ${detail.join(', ')}`);
    }
    const autoPrepared = strategy?.auto_prepared_draft === true || strategy?.autoPreparedDraft === true;
    if (autoPrepared) lines.push('- status: pending draft auto-prepared');
    lines.push(recommendation === 'expand_team'
      ? '- next: /team apply 또는 /team refine'
      : '- detail: /team why');
    return lines;
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
    const strategyLines = buildTeamStrategyLines(teamState, session);
    if (strategyLines.length > 0) lines.push('', ...strategyLines);
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

  return async function handleTelegramCommand({ msg, text, chatId, userId }) {
    if (!String(text || "").startsWith("/")) return false;

    const rawText = String(text || "");
    const firstSpaceIndex = rawText.indexOf(" ");
    const rawArgs = firstSpaceIndex >= 0 ? rawText.slice(firstSpaceIndex + 1).trim() : "";
    const [cmd, ...rest] = rawText.split(/\s+/);
    const args = rawArgs || rest.join(" ").trim();

    if (cmd === "/help" || cmd === "/commands") {
      const sub = String(args || "").trim().toLowerCase();
      if (sub === "advanced") {
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

      await bot.sendMessage(chatId, "Usage:\n/memory show\n/memory md\n/memory kb\n/memory policy <자연어 프롬프트>\n/memory routing <자연어 프롬프트>\n/memory role <gemini|codex|chatgpt> <자연어 역할>\n/memory agents\n/memory note <메모>\n/memory lesson <교훈>\n/memory reset");
      return true;
    }

    if (cmd === "/gptdone") {
      clearAwait(chatId);
      await bot.sendMessage(chatId, "✅ gpt paste 모드를 종료했어요.");
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

    if (cmd === "/agents" || cmd === "/team") {
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
        await sendLong(bot, chatId, buildTeamStatusOverview(teamState, { chatId, runtime: runtimeForTeam }));
        return true;
      }
      if (sub === 'why' || sub === 'strategy') {
        const strategyLines = buildTeamStrategyLines(teamState, chatSessionStore?.get?.(chatId) || {});
        if (strategyLines.length === 0) {
          await bot.sendMessage(chatId, '아직 team 전략 판단 결과가 없습니다. 먼저 /chat 으로 한 턴 실행해 보세요.');
          return true;
        }
        await sendLong(bot, chatId, strategyLines.join('\n'));
        return true;
      }
      if (sub === 'suggest') {
        const goal = String(rawArgs.replace(/^suggest\s+/i, '') || '').trim();
        if (!goal) {
          await bot.sendMessage(chatId, 'Usage: /team suggest <목적>');
          return true;
        }
        const freeformMatch = goal.match(/^--mode\s+freeform\s+([\s\S]+)$/i);
        const effectiveGoal = String(freeformMatch?.[1] || goal).trim();
        const proposal = freeformMatch
          ? await createFreeformTeamConfigurationAdvanced({ description: effectiveGoal, runtime: runtimeForTeam, jobId: currentJobId })
          : suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam });
        storePendingTeam(chatSessionStore, chatId, proposal);
        await sendLong(bot, chatId, formatTeamProposalMessage(proposal, { runtime: runtimeForTeam }));
        return true;
      }
      if (sub === 'create') {
        const description = String(rawArgs.replace(/^create\s+/i, '') || '').trim();
        if (!description) {
          await bot.sendMessage(chatId, 'Usage: /team create <자연어 팀 설명>\n\n선택지 참고: /team options 또는 /help advanced');
          return true;
        }
        await bot.sendMessage(chatId, '해당 요청에 맞는 팀을 구성하겠습니다. 잠시만 기다려주세요.');
        try {
          const proposal = await createFreeformTeamConfigurationAdvanced({ description, runtime: runtimeForTeam, jobId: currentJobId });
          storePendingTeam(chatSessionStore, chatId, proposal);
          await sendLong(bot, chatId, formatTeamProposalMessage(proposal, { runtime: runtimeForTeam }));
        } catch (error) {
          const fallbackProposal = createFreeformTeamConfiguration({ description, runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, fallbackProposal);
          await sendLong(bot, chatId, [
            `⚠️ /team create planner 경로가 실패해 heuristic fallback으로 팀 초안을 만들었습니다.`,
            `reason: ${String(error?.message ?? error)}`,
            '',
            formatTeamProposalMessage(fallbackProposal, { runtime: runtimeForTeam }),
          ].join('\n'));
        }
        return true;
      }
      if (sub === 'expand') {
        const instruction = String(rawArgs.replace(/^expand\s*/i, '') || '').trim();
        const baseTeam = teamState.pending_team || teamState.active_team;
        if (!baseTeam) {
          await bot.sendMessage(chatId, '확장할 팀이 없습니다. 먼저 그냥 대화를 시작하거나 /team suggest <목적> 으로 기본 팀을 만든 뒤 다시 시도해 주세요.');
          return true;
        }
        const effectiveInstruction = instruction || 'Expand this single-agent or minimal team into the smallest useful collaborative team. Keep the current primary owner, add reviewer/researcher/synthesizer only when clearly justified, and preserve direct answer flow.';
        await bot.sendMessage(chatId, '현재 구성을 바탕으로 필요한 만큼만 팀을 확장한 draft를 만들겠습니다.');
        try {
          const next = await refineTeamConfigurationAdvanced({ team: baseTeam, instruction: effectiveInstruction, runtime: runtimeForTeam, jobId: currentJobId });
          storePendingTeam(chatSessionStore, chatId, next);
          await sendLong(bot, chatId, formatTeamProposalMessage(next, { runtime: runtimeForTeam }));
        } catch (error) {
          const next = refineTeamConfiguration(baseTeam, effectiveInstruction, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, next);
          await sendLong(bot, chatId, [
            `⚠️ /team expand planner 경로가 실패해 heuristic fallback으로 확장 draft를 만들었습니다.`,
            `reason: ${String(error?.message ?? error)}`,
            '',
            formatTeamProposalMessage(next, { runtime: runtimeForTeam }),
          ].join('\n'));
        }
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
          await bot.sendMessage(chatId, 'Usage: /team refine <자연어 수정>\n\n선택지 참고: /team options 또는 /help advanced');
          return true;
        }
        await bot.sendMessage(chatId, '기존 팀 구성을 바탕으로 수정안을 다시 설계하겠습니다. 잠시만 기다려주세요.');
        try {
          const next = await refineTeamConfigurationAdvanced({ team: baseTeam, instruction, runtime: runtimeForTeam, jobId: currentJobId });
          storePendingTeam(chatSessionStore, chatId, next);
          await sendLong(bot, chatId, formatTeamProposalMessage(next, { runtime: runtimeForTeam }));
        } catch (error) {
          const next = refineTeamConfiguration(baseTeam, instruction, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, next);
          await sendLong(bot, chatId, [
            `⚠️ /team refine planner 경로가 실패해 heuristic fallback으로 수정 draft를 만들었습니다.`,
            `reason: ${String(error?.message ?? error)}`,
            '',
            formatTeamProposalMessage(next, { runtime: runtimeForTeam }),
          ].join('\n'));
        }
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
        const templateArg = String(rawArgs.replace(/^template\s*/i, '') || '').trim();
        if (!templateArg || templateArg === 'current') {
          const baseTeam = teamState.pending_team || teamState.active_team;
          if (!baseTeam) {
            await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요. 또는 /team template catalog 로 benchmark 템플릿을 볼 수 있습니다.');
            return true;
          }
          await sendLong(bot, chatId, buildTeamConfigurationTemplate(baseTeam));
          return true;
        }
        if (/^(catalog|benchmarks?)$/i.test(templateArg)) {
          await sendLong(bot, chatId, buildBenchmarkTemplateCatalogText());
          return true;
        }
        const match = templateArg.match(/^(?:benchmark|bench)\s+([a-z0-9_.-]+)$/i);
        if (match) {
          const bench = buildBenchmarkTeamTemplate(match[1], {});
          if (!bench) {
            await bot.sendMessage(chatId, `알 수 없는 benchmark template: ${String(match[1] || '')}. /team template catalog 로 목록을 확인하세요.`);
            return true;
          }
          const validated = validateTeamConfiguration({ ...bench, proposal_mode: 'suggest' }, { runtime: runtimeForTeam });
          storePendingTeam(chatSessionStore, chatId, validated);
          await sendLong(bot, chatId, `✅ benchmark template을 pending team으로 불러왔습니다.

${formatTeamProposalMessage(validated, { runtime: runtimeForTeam })}`);
          return true;
        }
        await bot.sendMessage(chatId, 'Usage: /team template | /team template catalog | /team template benchmark <id>');
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
          const applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
          await sendLong(bot, chatId, `✅ 활성 팀 적용 완료

${buildTeamListMessage({ active_team: applied }, { runtime: runtimeForTeam })}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 적용 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }

      if (sub === 'options' || sub === 'roles' || sub === 'patterns' || sub === 'schema') {
        await sendLong(bot, chatId, buildTeamSchemaOptionsText());
        return true;
      }
      if (sub === 'modes') {
        await sendLong(bot, chatId, [
          'Team composition modes:',
          '- structured: /team suggest <목적>',
          '  canonical role/skill/model 후보를 안전하게 조합합니다.',
          '- freeform: /team create <자연어 팀 설명>',
          '  더 자유로운 agent 이름/책임/상호작용을 제안한 뒤 structured contract로 정규화합니다.',
          '- freeform shortcut: /team suggest --mode freeform <설명>',
        ].join('\n'));
        return true;
      }
      if (sub === 'reset') {
        await resetTeamConfiguration(chatSessionStore, chatId, { runtime: runtimeForTeam });
        await bot.sendMessage(chatId, '✅ 팀 구성을 초기화했습니다. 다시 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 시작해 주세요.');
        return true;
      }
      await bot.sendMessage(chatId, '지원되는 /team 명령: suggest, create, refine, expand, apply, requirements, proposal, export, install, pull, push, template, validate, options, reset, modes');
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
      await sendAgentOrToolListQuick(bot, chatId, "agent", "skills", { telegramUserId: userId });
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

    if (cmd === "/artifacts" || cmd === "/outputs") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const legacyMode = cmd === "/outputs";
      const first = String(rest[0] || '').trim().toLowerCase();
      if (legacyMode && first === 'send') {
        await bot.sendMessage(chatId, '이제 자동 첨부 전송은 사용하지 않아요. /artifacts 로 후보를 본 뒤 /send <번호|path> 를 사용해 주세요.');
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
      const prefix = legacyMode ? '📎 artifacts (legacy /outputs alias)' : '📎 artifacts';
      const sections = [`${prefix}
${formatArtifactIndexText(currentJobId, artifactIndex, { limit })}`];
      const contractLines = formatArtifactDeliveryContractLines(contract);
      if (contractLines.length > 0) sections.push(`publish contract
${contractLines.join('\n')}`);
      await sendLong(bot, chatId, sections.join('\n\n'));
      return true;
    }

    if (cmd === "/send" || cmd === "/sendfile") {
      const currentJobId = resolveLiveJobIdForChat(chatId);
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어요. 먼저 /chat 또는 /run으로 job을 시작해 주세요.");
        return true;
      }
      const selection = String(args || '').trim();
      if (!selection) {
        await bot.sendMessage(chatId, cmd === '/sendfile' ? 'Usage: /sendfile <relative_path>' : 'Usage: /send <번호|path>\n또는 /send bundle <번호,번호|path,...>');
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
        const bundle = cmd === '/send' ? parseArtifactBundleSelection(selection) : null;
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
        const prefix = cmd === '/sendfile' ? '/sendfile' : '/send';
        await bot.sendMessage(chatId, `❌ ${prefix} 실패: ${clip(String(e?.message ?? e), 260)}`);
      }
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
            teamConfig: teamState.active_team,
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
          teamConfig: teamState.active_team,
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
