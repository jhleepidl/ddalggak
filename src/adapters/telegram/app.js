import process from "node:process";
import TelegramBot from "node-telegram-bot-api";

import { installTelegramRateLimitRetry } from "./rate_limit.js";

import { ChatRunManager } from "../../chat/run_manager.js";
import { createTelegramCommandHandler } from "./commands.js";
import { createTelegramCallbackQueryHandler } from "./callbacks.js";
import { createTelegramMessageHandler } from "./messages.js";
import {
  createSingleInstanceLock,
  createShutdownHandler,
  createPollingErrorHandler,
  registerLifecycleSignals,
} from "./lifecycle.js";
import { createTelegramUploadService } from "./uploads.js";
import * as runtimeCore from "../../application/telegram_runtime_ops.js";
import { startModelCatalogRefreshScheduler } from "../../application/model_catalog_refresh.js";
import {
  sendChatStatus,
  sendAgentOrToolListQuick,
} from "../../application/telegram_runtime_ui.js";

function buildTelegramBotOptions() {
  const options = {
    polling: {
      autoStart: false,
      interval: Number.isFinite(runtimeCore.TELEGRAM_POLLING_INTERVAL_MS)
        ? runtimeCore.TELEGRAM_POLLING_INTERVAL_MS
        : 1000,
      params: {
        timeout: Number.isFinite(runtimeCore.TELEGRAM_POLLING_TIMEOUT_SEC)
          ? runtimeCore.TELEGRAM_POLLING_TIMEOUT_SEC
          : 15,
      },
    },
  };
  if (runtimeCore.TELEGRAM_FORCE_IPV4) options.request = { family: 4 };
  return options;
}

function createAppChatRunManager(bot) {
  return new ChatRunManager({
    sessionStore: runtimeCore.chatSessionStore,
    interruptDebounceMs: runtimeCore.INTERRUPT_DEBOUNCE_MS,
    cancelCurrent: async ({ chatId, mode, reason }) => {
      return runtimeCore.requestChatInterrupt(chatId, { mode, reason });
    },
    onAck: async ({ chatId, mode }) => {
      if (mode === "cancel") {
        await bot.sendMessage(chatId, "⛔️ 중단했어요. 다음 지시를 주세요.");
      }
    },
    onRunError: async ({ chatId, error }) => {
      if (runtimeCore.isCancelledError(error)) return;
      try {
        await bot.sendMessage(chatId, `❌ /chat 실패: ${String(error?.message ?? error)}`);
      } catch (sendError) {
        console.error(`[telegram] failed to send /chat error message: ${String(sendError?.message || sendError)}`);
      }
    },
    runChat: async ({ chatId, userId, message, inputKind, pendingCount, telegramMessageId, userReplyToMessageId, forceMode, chatInfo }) => {
      await runtimeCore.runSupervisorChat(
        bot,
        chatId,
        userId,
        message,
        {
          debug: false,
          chatInfo: chatInfo && typeof chatInfo === "object"
            ? chatInfo
            : { chat_id: String(chatId || "") },
          inputKind: inputKind || (pendingCount > 1 ? "interrupt_update" : "chat_message"),
          telegramMessageId,
          userReplyToMessageId,
          forceMode: runtimeCore.normalizeForceMode(forceMode),
        }
      );
    },
  });
}

function buildGroupedDeps({ bot, botUsername, chatRunManager, uploadService }) {
  const telegramUi = {
    bot,
    clip: runtimeCore.clip,
    sendLong: runtimeCore.sendLong,
    sendContextInfo: runtimeCore.sendContextInfo,
    sendRouterAckMessage: runtimeCore.sendRouterAckMessage,
    FENCE: runtimeCore.FENCE,
    getBotUsername: () => botUsername,
    requireMentionInGroup: runtimeCore.TELEGRAM_REQUIRE_MENTION_IN_GROUP,
  };
  const runtimeOps = {
    memory: runtimeCore.memory,
    formatMemorySummary: runtimeCore.formatMemorySummary,
    formatAgentMemorySummary: runtimeCore.formatAgentMemorySummary,
    parseChatMessageWithFlags: runtimeCore.parseChatMessageWithFlags,
    runSupervisorChat: runtimeCore.runSupervisorChat,
    loadSupervisorRuntime: runtimeCore.loadSupervisorRuntime,
    decideRunRoute: runtimeCore.decideRunRoute,
    executeRoutedPlan: runtimeCore.executeRoutedPlan,
    suggestNextPrompt: runtimeCore.suggestNextPrompt,
    sendChatGPTPrompt: runtimeCore.sendChatGPTPrompt,
    memoryModeWithFallback: runtimeCore.memoryModeWithFallback,
    requireGocClient: runtimeCore.requireGocClient,
    resolveCurrentJobIdForChat: runtimeCore.resolveCurrentJobIdForChat,
    sendRouterAckMessage: runtimeCore.sendRouterAckMessage,
    chatRunManager,
    executeActions: runtimeCore.executeActions,
    normalizeForceMode: runtimeCore.normalizeForceMode,
    isCancelledError: runtimeCore.isCancelledError,
    actionApprovalDeps: {
      chatSessionStore: runtimeCore.chatSessionStore,
      resolveCurrentJobIdForChat: runtimeCore.resolveCurrentJobIdForChat,
      tracking: runtimeCore.tracking,
      chatActionLabel: runtimeCore.chatActionLabel,
      chatRunManager,
      loadSupervisorRuntime: runtimeCore.loadSupervisorRuntime,
      memoryModeWithFallback: runtimeCore.memoryModeWithFallback,
      requireGocClient: runtimeCore.requireGocClient,
      jobs: runtimeCore.jobs,
      GocExecutionGraphRecorder: runtimeCore.GocExecutionGraphRecorder,
      resetJobAbortController: runtimeCore.resetJobAbortController,
      activeJobByChat: runtimeCore.activeJobByChat,
      rememberLastChatJob: runtimeCore.rememberLastChatJob,
      buildQueuedAgentStatusFromActions: runtimeCore.buildQueuedAgentStatusFromActions,
      sendPlanPreviewMessage: runtimeCore.sendPlanPreviewMessage,
      getCurrentTurnReplyMessageId: runtimeCore.getCurrentTurnReplyMessageId,
      executeSupervisorActions: runtimeCore.executeSupervisorActions,
      normalizeForceMode: runtimeCore.normalizeForceMode,
      buildSupervisorExecutionCallbacks: runtimeCore.buildSupervisorExecutionCallbacks,
      CHAT_VERBOSE: runtimeCore.CHAT_VERBOSE,
      sendAgentStatusTransitionMessage: runtimeCore.sendAgentStatusTransitionMessage,
      synthesizeChatReply: runtimeCore.synthesizeChatReply,
      clip: runtimeCore.clip,
      sendLong: runtimeCore.sendLong,
      buildPendingApprovalPrompt: runtimeCore.buildPendingApprovalPrompt,
      maybeSendArtifactSummary: runtimeCore.maybeSendArtifactSummary,
      markMutatingActionsConfirmed: runtimeCore.markMutatingActionsConfirmed,
      jobAbortControllers: runtimeCore.jobAbortControllers,
    },
  };
  const jobOps = {
    formatRunningJobs: runtimeCore.formatRunningJobs,
    cancelJobExecution: runtimeCore.cancelJobExecution,
    createJob: runtimeCore.createJob,
    resetJobAbortController: runtimeCore.resetJobAbortController,
    tracking: runtimeCore.tracking,
    jobs: runtimeCore.jobs,
    approvals: runtimeCore.approvals,
    isCancelledError: runtimeCore.isCancelledError,
    actionLabel: runtimeCore.actionLabel,
    getGoalFromResearch: runtimeCore.getGoalFromResearch,
    extractCodexInstruction: runtimeCore.extractCodexInstruction,
    runCommand: runtimeCore.runCommand,
    extractJsonPlan: runtimeCore.extractJsonPlan,
  };
  const sessionOps = {
    getAwait: runtimeCore.getAwait,
    clearAwait: runtimeCore.clearAwait,
    setAwait: runtimeCore.setAwait,
    rememberLastChatJob: runtimeCore.rememberLastChatJob,
    resetChatSession: runtimeCore.resetChatSession,
    activeJobByChat: runtimeCore.activeJobByChat,
    lastChatJobByChat: runtimeCore.lastChatJobByChat,
    chatSessionStore: runtimeCore.chatSessionStore,
    chatRunManager,
    jobAbortControllers: runtimeCore.jobAbortControllers,
  };
  const fileOps = {
    resolveLiveJobIdForChat: runtimeCore.resolveLiveJobIdForChat,
    parseClampedInt: runtimeCore.parseClampedInt,
    collectWorkspaceFileEntries: runtimeCore.collectWorkspaceFileEntries,
    formatWorkspaceFileListText: runtimeCore.formatWorkspaceFileListText,
    refreshArtifactIndex: runtimeCore.refreshArtifactIndex,
    formatArtifactIndexText: runtimeCore.formatArtifactIndexText,
    sendArtifactBySelection: runtimeCore.sendArtifactBySelection,
    sendArtifactBundle: runtimeCore.sendArtifactBundle,
    parseArtifactBundleSelection: runtimeCore.parseArtifactBundleSelection,
    formatByteSize: runtimeCore.formatByteSize,
    runWorkspaceDir: runtimeCore.runWorkspaceDir,
    uploadService,
  };
  const teamOps = {
    sendChatStatus,
    sendAgentOrToolListQuick,
    isAllowedChat: runtimeCore.isAllowedChat,
    isAllowedUser: runtimeCore.isAllowedUser,
    setGocActingTelegramUser: runtimeCore.setGocActingTelegramUser,
    bindGocActor: runtimeCore.bindGocActor,
    openAgentsUiInfo: runtimeCore.openAgentsUiInfo,
    findDraftByNodeId: runtimeCore.findDraftByNodeId,
    findLatestDraftByAgentId: runtimeCore.findLatestDraftByAgentId,
    buildAgentProfileFromProposal: runtimeCore.buildAgentProfileFromProposal,
    createAgentProfile: runtimeCore.createAgentProfile,
    appendParticipantToJobConfig: runtimeCore.appendParticipantToJobConfig,
    refreshAgentRegistry: runtimeCore.refreshAgentRegistry,
  };
  return { telegramUi, runtimeOps, jobOps, sessionOps, fileOps, teamOps };
}

export async function startTelegramApp({ token = runtimeCore.TOKEN } = {}) {
  if (!String(token || "").trim()) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const bot = installTelegramRateLimitRetry(new TelegramBot(String(token).trim(), buildTelegramBotOptions()));
  const chatRunManager = createAppChatRunManager(bot);
  let botUsername = "";

  const singleInstanceLock = createSingleInstanceLock({
    enabled: runtimeCore.TELEGRAM_SINGLE_INSTANCE_LOCK,
    lockFile: runtimeCore.LOCK_FILE,
  });
  try {
    singleInstanceLock.acquire();
  } catch (error) {
    if (error?.code === "telegram_single_instance_conflict") {
      console.error(`Another telegram_runner.js process is already running (pid=${error.pid}).`);
      console.error("Stop the existing process first, or set TELEGRAM_SINGLE_INSTANCE_LOCK=false.");
    }
    throw error;
  }

  const modelCatalogRefreshScheduler = startModelCatalogRefreshScheduler({ logger: console });

  const shutdown = createShutdownHandler({
    bot,
    releaseLock: () => {
      try { modelCatalogRefreshScheduler.stop(); } catch {}
      singleInstanceLock.release();
    },
    processImpl: process,
  });
  registerLifecycleSignals({
    shutdown,
    releaseLock: singleInstanceLock.release,
    processImpl: process,
  });
  bot.on("polling_error", createPollingErrorHandler({ shutdown }));

  const uploadService = createTelegramUploadService({
    bot,
    maxBytes: runtimeCore.TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES,
    allowedExts: runtimeCore.TELEGRAM_UPLOAD_ALLOWED_EXTS,
    resolveLiveJobIdForChat: runtimeCore.resolveLiveJobIdForChat,
    createJob: runtimeCore.createJob,
    rememberLastChatJob: runtimeCore.rememberLastChatJob,
    chatSessionStore: runtimeCore.chatSessionStore,
    resolveWorkspacePath: runtimeCore.resolveWorkspacePath,
    runWorkspaceDir: runtimeCore.runWorkspaceDir,
    jobs: runtimeCore.jobs,
    tracking: runtimeCore.tracking,
    appendWorkspaceUploadArtifactToGoc: runtimeCore.appendWorkspaceUploadArtifactToGoc,
  });

  try {
    const me = await bot.getMe();
    botUsername = String(me?.username || "").trim().toLowerCase();
  } catch {
    botUsername = "";
  }

  const groupedDeps = buildGroupedDeps({
    bot,
    botUsername,
    chatRunManager,
    uploadService,
  });
  const onCallbackQuery = createTelegramCallbackQueryHandler(groupedDeps);
  const handleTelegramCommand = createTelegramCommandHandler(groupedDeps);
  const onMessage = createTelegramMessageHandler({
    ...groupedDeps,
    runtimeOps: {
      ...groupedDeps.runtimeOps,
      handleTelegramCommand,
    },
  });

  bot.on("callback_query", async (query) => {
    try {
      await onCallbackQuery(query);
    } catch (error) {
      console.error(`[telegram] callback_query handler error: ${String(error?.stack || error?.message || error)}`);
    }
  });
  bot.on("message", async (msg) => {
    try {
      await onMessage(msg);
    } catch (error) {
      console.error(`[telegram] message handler error: ${String(error?.stack || error?.message || error)}`);
      const chatId = msg?.chat?.id;
      if (chatId) {
        try {
          await bot.sendMessage(chatId, `⚠️ 요청 처리 중 오류가 났지만 서비스는 계속 실행 중입니다: ${String(error?.message ?? error).slice(0, 300)}`);
        } catch {}
      }
    }
  });

  console.log("Telegram orchestrator v2.1 started (polling).");
  console.log(`Job workspace root: ${runtimeCore.jobs.runsDir}/<jobId>/workspace`);
  console.log(`Runs dir: ${runtimeCore.jobs.runsDir}`);
  console.log(`Telegram upload/download limit: ${runtimeCore.formatByteSize(runtimeCore.TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES)} (bot-api download)`);
  console.log(`Telegram sendDocument limit: ${runtimeCore.formatByteSize(runtimeCore.TELEGRAM_SEND_MAX_BYTES)}`);
  console.log("Artifact delivery: explicit /send only (no automatic document sending)");
  console.log(`Memory mode: ${runtimeCore.MEMORY_MODE} (effective=${runtimeCore.memoryModeWithFallback()})`);
  if (botUsername) {
    console.log(`Telegram bot username: @${botUsername}`);
  }
  if (runtimeCore.gocInitError) console.log(`GoC init error: ${runtimeCore.gocInitError}`);
  console.log(`Agents registry: ${runtimeCore.agentRegistry.path}`);
  await bot.startPolling({ restart: true });

  return {
    bot,
    chatRunManager,
    handleTelegramCommand,
    onCallbackQuery,
    onMessage,
    shutdown,
    uploadService,
  };
}
