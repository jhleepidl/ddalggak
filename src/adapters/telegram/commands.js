import {
  executeRunCommand,
  executeContinueCommand,
} from "../../application/route_executor.js";
import {
  applyPendingTeam,
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

const HELP_TEXT = [
  "Commands:",
  "- /chat [text]: 대화/작업 지시",
  "- /context [global]: 현재 job 컨텍스트/GoC 링크 보기",
  "- /team [suggest <목적>|create <자연어 팀 설명>|refine <자연어 수정>|apply|requirements|proposal|export|install <JSON>|pull|push|template|validate <JSON>|options|reset|modes]: 팀 제안/생성/수정/동기화",
  "- /artifacts [limit]: 주요 산출물 후보 보기",
  "- /send <번호|path>: 산출물 파일 전송",
  "- /files [uploads|workspace|all] [limit]: workspace 파일 목록 보기",
  "- /status: 현재 chat/job 상태 보기",
  "- /credential [list|pending|set <KEY> <secret> [--resume]|clear <KEY>]: install proposal용 credential 바인딩",
  "- /stop [jobId]: 현재 실행 또는 지정 job 중단",
  "- /running: 실행 중이거나 대기 중인 job 확인",
  "- /whoami: 현재 chat_id / user_id 확인",
  "- /help advanced: 고급 명령 보기",
].join("\n");

const ADVANCED_HELP_TEXT = [
  "Commands:",
  "- /chat [text]: 대화/작업 지시",
  "- /whoami: 현재 chat_id / user_id 확인",
  "- /running: 실행/대기 job 목록 확인",
  "- /status: 현재 chat/job 상태 보기",
  "- /credential [list|pending|set <KEY> <secret> [--resume]|clear <KEY>]: install proposal용 credential 바인딩",
  "- /stop [jobId]: 현재 실행 또는 지정 job 중단",
  "- /memory [show|md|kb|policy|routing|role|agents|note|lesson|reset]: 런타임 메모리/KB 조회·수정",
  "- /settings ...: /memory alias",
  "- /team [suggest <목적>|create <자연어 팀 설명>|refine <자연어 수정>|apply|requirements|proposal|export|install <JSON>|pull|push|template|validate <JSON>|options|reset|modes]: 팀 제안/생성/수정/동기화",
  "- /agents ...: legacy alias of /team (팀 상태/수정은 /team 권장)",
  "- /skills: 현재/예정 agent roster와 대표 skill 보기",
  "- /tools: 현재 job의 tool 상태 보기",
  "- /artifacts [limit]: 주요 산출물 후보 보기",
  "- /send <번호|path>: 산출물 파일 전송",
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
  const sendArtifactBySelection = fileOps.sendArtifactBySelection || deps.sendArtifactBySelection;
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

  function buildTeamStatusOverview(teamState = {}, { chatId = '' } = {}) {
    const lines = [buildTeamListMessage(teamState)];
    const session = chatSessionStore?.get?.(chatId) || {};
    const pendingTeam = teamState?.pending_team && typeof teamState.pending_team === 'object' ? teamState.pending_team : null;
    const activeTeam = teamState?.active_team && typeof teamState.active_team === 'object' ? teamState.active_team : null;
    const pendingInstallProposal = getPendingInstallProposal(chatSessionStore, chatId);
    const credentialBindingState = getCredentialBindingState(chatSessionStore, chatId);
    const patternConflict = session?.pattern_conflict && typeof session.pattern_conflict === 'object' ? session.pattern_conflict : null;
    const temporaryOverride = session?.temporary_execution_override && typeof session.temporary_execution_override === 'object' ? session.temporary_execution_override : null;
    const patternRecovery = session?.pattern_recovery && typeof session.pattern_recovery === 'object' ? session.pattern_recovery : null;

    const stateLines = [
      `active team: ${activeTeam ? String(activeTeam.team_name || 'configured').trim() : 'none'}`,
      `pending team: ${pendingTeam ? `${String(pendingTeam.team_name || 'pending_team').trim()}${pendingTeam?.planner_metadata?.auto_refine_from_pattern_conflict ? ' · auto_refine_draft' : ''}` : 'none'}`,
      `install proposal: ${pendingInstallProposal ? `${String(pendingInstallProposal.status || 'awaiting_install_approval')} · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}` : 'none'}`,
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
    lines.push('', 'Runtime state', ...stateLines);

    const nextSteps = [];
    if (pendingTeam) nextSteps.push('- /team apply');
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
      await sendChatStatus(bot, chatId, { telegramUserId: userId });
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
        await sendLong(bot, chatId, buildTeamStatusOverview(teamState, { chatId }));
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
          ? await createFreeformTeamConfigurationAdvanced({ description: effectiveGoal, runtime: runtimeForTeam })
          : suggestTeamConfiguration({ taskText: effectiveGoal, runtime: runtimeForTeam });
        storePendingTeam(chatSessionStore, chatId, proposal);
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal)}

지원 모델:
${formatSupportedModelLines()}`);
        return true;
      }
      if (sub === 'create') {
        const description = String(rawArgs.replace(/^create\s+/i, '') || '').trim();
        if (!description) {
          await bot.sendMessage(chatId, 'Usage: /team create <자연어 팀 설명>\n\n선택지 참고: /team options 또는 /help advanced');
          return true;
        }
        await bot.sendMessage(chatId, '해당 요청에 맞는 팀을 구성하겠습니다. 잠시만 기다려주세요.');
        const proposal = await createFreeformTeamConfigurationAdvanced({ description, runtime: runtimeForTeam });
        storePendingTeam(chatSessionStore, chatId, proposal);
        await sendLong(bot, chatId, `${formatTeamProposalMessage(proposal)}

지원 모델:
${formatSupportedModelLines()}`);
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
        const next = await refineTeamConfigurationAdvanced({ team: baseTeam, instruction, runtime: runtimeForTeam });
        storePendingTeam(chatSessionStore, chatId, next);
        await sendLong(bot, chatId, formatTeamProposalMessage(next));
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
      if (sub === 'proposal' || sub === 'install-plan') {
        const proposalAction = String(rest[1] || '').trim().toLowerCase();
        const existingProposalState = getPendingInstallProposal(chatSessionStore, chatId);
        const baseTeam = currentTeamForManifest(teamState);
        if (proposalAction === 'dismiss' || proposalAction === 'clear') {
          if (!existingProposalState) {
            await bot.sendMessage(chatId, '대기 중인 install proposal이 없습니다.');
            return true;
          }
          archivePendingInstallProposal(chatSessionStore, chatId, 'dismissed');
          await bot.sendMessage(chatId, '✅ install proposal을 닫았습니다.');
          return true;
        }
        if (proposalAction === 'install' || proposalAction === 'pending') {
          if (!baseTeam) {
            await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
            return true;
          }
          if (!existingProposalState) {
            const proposal = buildTeamInstallProposal({ team: baseTeam, runtime: runtimeForTeam, applyState: 'pending' });
            const state = createPendingInstallProposalState({ proposal, applyState: 'pending', source: 'team_requirement' });
            if (state) {
              chatSessionStore.upsert(chatId, {
                pending_install_proposal: state,
                awaiting_install_approval: true,
              });
            }
          }
          if (!teamState.pending_team && baseTeam) storePendingTeam(chatSessionStore, chatId, baseTeam);
          const archived = existingProposalState || getPendingInstallProposal(chatSessionStore, chatId);
          if (archived) archivePendingInstallProposal(chatSessionStore, chatId, 'installed_pending', { apply_state: 'pending' });
          await bot.sendMessage(chatId, '✅ install proposal을 pending 상태로 보관했습니다. 필요하면 /team apply 후 다시 시도해 주세요.');
          return true;
        }
        if (proposalAction === 'apply' || proposalAction === 'active' || proposalAction === 'resume') {
          if (!existingProposalState) {
            await bot.sendMessage(chatId, '대기 중인 install proposal이 없습니다. 먼저 /team proposal 로 확인해 주세요.');
            return true;
          }
          let activeTeam = teamState.active_team || null;
          if (teamState.pending_team) {
            activeTeam = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
            teamState = getSessionTeamState(chatSessionStore, chatId);
          }
          archivePendingInstallProposal(chatSessionStore, chatId, 'applied_active', { apply_state: 'active' });
          await bot.sendMessage(chatId, '✅ install proposal을 반영했고 같은 요청을 재개합니다.');
          await resumeFromInstallProposal({ state: existingProposalState, runtime: runtimeForTeam, chatId, userId, currentTeam: activeTeam || teamState.active_team || baseTeam });
          return true;
        }
        if (!baseTeam && !existingProposalState) {
          await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
          return true;
        }
        const proposal = baseTeam
          ? buildTeamInstallProposal({ team: baseTeam, runtime: runtimeForTeam, applyState: teamState.pending_team ? 'active' : 'pending' })
          : existingProposalState?.proposal;
        const prompt = existingProposalState ? buildInstallProposalPrompt(existingProposalState, { hasPendingTeam: !!teamState.pending_team }) : null;
        const lines = [
          existingProposalState ? `pending install proposal state: ${existingProposalState.status}` : 'install proposal preview',
          '',
          formatTeamInstallProposalMessage(proposal),
          ...(prompt ? ['', prompt.text] : []),
          '',
          '명령:',
          '- /team proposal pending',
          '- /team proposal apply',
          '- /team proposal dismiss',
        ].filter(Boolean);
        await sendLong(bot, chatId, lines.join('\n'));
        return true;
      }
      if (sub === 'requirements') {
        const baseTeam = currentTeamForManifest(teamState);
        if (!baseTeam) {
          await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
          return true;
        }
        const manifest = buildTeamBlueprint(baseTeam, { runtime: runtimeForTeam, applyState: 'pending' });
        const requirementLines = formatManifestRequirementLines(manifest.requirements || normalizeManifestRequirements({}), { maxLines: 12 });
        await sendLong(bot, chatId, [
          `실행 requirements · ${baseTeam.team_name || 'team_config'}`,
          ...(requirementLines.length > 0 ? requirementLines : ['- (추가 requirement 없음)']),
        ].join('\n'));
        return true;
      }
      if (sub === 'export') {
        const baseTeam = currentTeamForManifest(teamState);
        if (!baseTeam) {
          await bot.sendMessage(chatId, '내보낼 팀이 없습니다. 먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 을 실행해 주세요.');
          return true;
        }
        const applyState = parseApplyStateTokens(rest.slice(1));
        const manifest = buildManifestWithSessionState(baseTeam, { runtime: runtimeForTeam, applyState, sessionInstallProposal: getPendingInstallProposal(chatSessionStore, chatId) || chatSessionStore.get(chatId)?.last_install_proposal || null });
        await sendLong(bot, chatId, JSON.stringify(manifest, null, 2));
        return true;
      }
      if (sub === 'install' || sub === 'import') {
        const payload = String(rawArgs.replace(/^(install|import)\s+/i, '') || '').trim();
        if (!payload) {
          await bot.sendMessage(chatId, 'Usage: /team install [--apply|--pending] <blueprint JSON>');
          return true;
        }
        const applyState = parseApplyStateTokens(payload.split(/\s+/).slice(0, 3));
        const jsonPayload = payload.replace(/^--(?:apply|active|pending)\s+/i, '').trim();
        try {
          const parsed = JSON.parse(jsonPayload);
          const installed = await installTeamBlueprintToSession({
            sessionStore: chatSessionStore,
            chatId,
            manifest: parsed,
            runtime: runtimeForTeam,
            applyState,
          });
          await sendLong(bot, chatId, [
            `✅ blueprint를 ${applyState === 'active' ? 'active' : 'pending'} team으로 설치했습니다.`,
            '',
            formatTeamProposalMessage(installed.team),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ blueprint 설치 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'pull') {
        const threadId = getCurrentThreadId(runtimeForTeam);
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 pull 할 수 없습니다.');
          return true;
        }
        const applyState = parseApplyStateTokens(rest.slice(1));
        try {
          const client = requireGocClient();
          const manifest = await client.getTeamBlueprint({ threadId });
          const installed = await installTeamBlueprintToSession({
            sessionStore: chatSessionStore,
            chatId,
            manifest,
            runtime: runtimeForTeam,
            applyState,
          });
          await sendLong(bot, chatId, [
            `✅ GoC thread team blueprint를 가져와 ${applyState === 'active' ? 'active' : 'pending'} team으로 반영했습니다.`,
            '',
            formatTeamProposalMessage(installed.team),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ GoC blueprint pull 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'push') {
        const baseTeam = currentTeamForManifest(teamState);
        const threadId = getCurrentThreadId(runtimeForTeam);
        if (!baseTeam) {
          await bot.sendMessage(chatId, '먼저 push 할 팀을 준비해 주세요.');
          return true;
        }
        if (!threadId || memoryModeWithFallback?.() !== 'goc' || typeof requireGocClient !== 'function') {
          await bot.sendMessage(chatId, '현재 GoC thread에 연결된 runtime이 없어 push 할 수 없습니다.');
          return true;
        }
        const applyState = parseApplyStateTokens(rest.slice(1));
        try {
          const manifest = buildManifestWithSessionState(baseTeam, { runtime: runtimeForTeam, applyState, source: 'telegram_push', sessionInstallProposal: getPendingInstallProposal(chatSessionStore, chatId) || chatSessionStore.get(chatId)?.last_install_proposal || null });
          const client = requireGocClient();
          const saved = await client.installTeamBlueprint({ threadId }, manifest, applyState);
          const normalized = normalizeTeamBlueprint(saved?.manifest || saved?.blueprint || saved || manifest, { runtime: runtimeForTeam, applyState });
          await sendLong(bot, chatId, [
            `✅ 현재 팀을 GoC thread에 ${applyState === 'active' ? 'active' : 'pending'} team으로 동기화했습니다.`,
            '',
            JSON.stringify(normalized.blueprint, null, 2),
          ].join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ GoC blueprint push 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'template') {
        const baseTeam = teamState.pending_team || teamState.active_team;
        if (!baseTeam) {
          await bot.sendMessage(chatId, '먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 제안받아 주세요.');
          return true;
        }
        await sendLong(bot, chatId, buildTeamConfigurationTemplate(baseTeam));
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

${formatTeamProposalMessage(validated)}`);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 팀 템플릿 검증 실패: ${String(e?.message ?? e)}`);
        }
        return true;
      }
      if (sub === 'apply') {
        try {
          const applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime: runtimeForTeam });
          await sendLong(bot, chatId, `✅ 활성 팀 적용 완료

${buildTeamListMessage({ active_team: applied })}`);
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
      await bot.sendMessage(chatId, '지원되는 /team 명령: suggest, create, refine, apply, requirements, proposal, export, install, pull, push, template, validate, options, reset, modes');
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
      const prefix = legacyMode ? '📎 artifacts (legacy /outputs alias)' : '📎 artifacts';
      await sendLong(bot, chatId, `${prefix}
${formatArtifactIndexText(currentJobId, artifactIndex, { limit })}`);
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
        await bot.sendMessage(chatId, cmd === '/sendfile' ? 'Usage: /sendfile <relative_path>' : 'Usage: /send <번호|path>');
        return true;
      }
      try {
        const artifactIndex = refreshArtifactIndex(currentJobId, { maxFiles: 12 });
        const sent = await sendArtifactBySelection(bot, chatId, currentJobId, selection, {
          replyToMessageId: msg.message_id,
          artifactIndex,
        });
        await bot.sendMessage(
          chatId,
          `✅ 파일 전송 완료
job_id=${currentJobId}
path=${sent.rel}
size=${formatByteSize(sent.size)}`
        );
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
        if (!teamState.active_team) {
          await bot.sendMessage(chatId, `현재 활성 팀이 없습니다.
먼저 /team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 구성한 뒤 /team apply 후 /chat 을 실행해 주세요.`);
          return true;
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
