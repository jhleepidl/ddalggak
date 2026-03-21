function replyToMessageOptions(msg = {}) {
  return Number.isFinite(Number(msg?.message_id))
    ? { reply_to_message_id: Number(msg.message_id) }
    : undefined;
}

export function isHardStopMessage(text) {
  const message = String(text || "").trim().toLowerCase();
  if (!message) return false;
  return message === "/stop"
    || message === "stop"
    || message.includes("중단")
    || message.includes("취소")
    || message.includes("멈춰")
    || message.includes("cancel");
}

export function extractPlainChatMessage(
  msg,
  text,
  {
    botUsername = "",
    requireMentionInGroup = false,
  } = {}
) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (!requireMentionInGroup) return raw;

  const chatType = String(msg?.chat?.type || "").trim().toLowerCase();
  const isGroupChat = chatType === "group" || chatType === "supergroup";
  if (!isGroupChat) return raw;

  if (raw.startsWith("!")) {
    return raw.slice(1).trim();
  }

  const normalizedUsername = String(botUsername || "").trim().toLowerCase();
  if (!normalizedUsername) return "";

  const mentionPrefix = new RegExp(`^@${normalizedUsername}(?:\\s+|\\s*[:,]\\s*)?`, "i");
  if (mentionPrefix.test(raw)) {
    return raw.replace(mentionPrefix, "").trim();
  }

  const entities = Array.isArray(msg?.entities) ? msg.entities : [];
  for (const entity of entities) {
    if (!entity || entity.type !== "mention") continue;
    const offset = Number(entity.offset);
    const length = Number(entity.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 1) continue;
    const mentioned = raw.slice(offset, offset + length).trim().toLowerCase();
    if (mentioned === `@${normalizedUsername}`) {
      return `${raw.slice(0, offset)} ${raw.slice(offset + length)}`.replace(/\s+/g, " ").trim();
    }
  }

  return "";
}

async function handlePasteModeMessage({
  bot,
  msg,
  chatId,
  userId,
  text,
  pasteState,
  tracking,
  jobs,
  extractJsonPlan,
  clearAwait,
  resetJobAbortController,
  activeJobByChat,
  loadSupervisorRuntime,
  executeActions,
  suggestNextPrompt,
  isCancelledError,
  jobAbortControllers,
} = {}) {
  const jobId = pasteState.jobId;
  const planDocName = typeof tracking?.resolveDocName === "function" ? tracking.resolveDocName(jobId, "plan") : "plan";
  tracking.append(jobId, "plan", `## ChatGPT reply (pasted)\n\n${text}\n`);
  jobs.appendConversation(jobId, "chatgpt", text, { kind: "plan_reply" });

  const plan = extractJsonPlan(text);
  if (!(plan && String(plan.jobId || "") === String(jobId))) {
    await bot.sendMessage(chatId, `🟣 ${planDocName}에 기록 완료. (JSON 플랜이 없어서 자동 실행은 하지 않았어요)`);
    return true;
  }

  await bot.sendMessage(chatId, "✅ JSON 액션 플랜 감지. 실행을 시작합니다.");
  clearAwait(chatId);
  const controller = resetJobAbortController(jobId);
  const chatKey = String(chatId);
  activeJobByChat.set(chatKey, String(jobId));
  try {
    let runtimeForPlan = null;
    try {
      runtimeForPlan = await loadSupervisorRuntime(jobId, {
        chatMeta: {
          chat_id: String(chatId || ""),
          telegram_user_id: String(pasteState.userId || userId || "").trim() || undefined,
        },
        includeContext: false,
        includeGlobal: false,
        telegramUserId: String(pasteState.userId || userId || "").trim(),
      });
    } catch {
      runtimeForPlan = null;
    }
    await executeActions(bot, chatId, jobId, plan, controller.signal, {
      telegramUserId: pasteState.userId || userId,
      runtime: runtimeForPlan,
    });
    await bot.sendMessage(chatId, "🏁 액션 플랜 실행 완료.");
    await suggestNextPrompt(
      bot,
      chatId,
      jobId,
      "현재 상태에서 다음으로 무엇을 해야 하는지 action plan(JSON)으로 제안해줘.",
      "action_plan",
      controller.signal
    );
  } catch (error) {
    if (isCancelledError(error)) {
      await bot.sendMessage(chatId, `⏹️ 액션 플랜 실행이 중단되었습니다. (jobId=${jobId})`);
    } else {
      await bot.sendMessage(chatId, `❌ 액션 실행 오류: ${String(error?.message ?? error)}`);
    }
  } finally {
    if (activeJobByChat.get(chatKey) === String(jobId)) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(String(jobId));
  }

  return true;
}

export function createTelegramMessageHandler(deps = {}) {
  const telegramUi = deps.telegramUi || {};
  const runtimeOps = deps.runtimeOps || {};
  const jobOps = deps.jobOps || {};
  const sessionOps = deps.sessionOps || {};
  const fileOps = deps.fileOps || {};
  const teamOps = deps.teamOps || {};

  const bot = telegramUi.bot || deps.bot;
  const clip = telegramUi.clip || deps.clip || ((value) => String(value || ""));
  const getBotUsername = telegramUi.getBotUsername || deps.getBotUsername || (() => deps.botUsername || "");
  const requireMentionInGroup = "requireMentionInGroup" in telegramUi
    ? Boolean(telegramUi.requireMentionInGroup)
    : Boolean(deps.requireMentionInGroup);

  const handleTelegramCommand = runtimeOps.handleTelegramCommand || deps.handleTelegramCommand;
  const sendRouterAckMessage = runtimeOps.sendRouterAckMessage || deps.sendRouterAckMessage;
  const chatRunManager = runtimeOps.chatRunManager || deps.chatRunManager;
  const loadSupervisorRuntime = runtimeOps.loadSupervisorRuntime || deps.loadSupervisorRuntime;
  const executeActions = runtimeOps.executeActions || deps.executeActions;
  const suggestNextPrompt = runtimeOps.suggestNextPrompt || deps.suggestNextPrompt;
  const isCancelledError = runtimeOps.isCancelledError || deps.isCancelledError || (() => false);

  const tracking = jobOps.tracking || deps.tracking;
  const jobs = jobOps.jobs || deps.jobs;
  const resetJobAbortController = jobOps.resetJobAbortController || deps.resetJobAbortController;
  const extractJsonPlan = jobOps.extractJsonPlan || deps.extractJsonPlan;

  const getAwait = sessionOps.getAwait || deps.getAwait;
  const clearAwait = sessionOps.clearAwait || deps.clearAwait;
  const activeJobByChat = sessionOps.activeJobByChat || deps.activeJobByChat || new Map();
  const jobAbortControllers = sessionOps.jobAbortControllers || deps.jobAbortControllers || new Map();

  const uploadService = fileOps.uploadService || deps.uploadService;

  const isAllowedChat = teamOps.isAllowedChat || deps.isAllowedChat || (() => true);
  const isAllowedUser = teamOps.isAllowedUser || deps.isAllowedUser || (() => true);
  const setGocActingTelegramUser = teamOps.setGocActingTelegramUser || deps.setGocActingTelegramUser || (() => {});

  return async function onTelegramMessage(msg) {
    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;
    if (!chatId || !userId) return;
    if (!isAllowedChat(chatId) || !isAllowedUser(userId)) return;
    setGocActingTelegramUser(userId);

    const text = String(msg?.text || msg?.caption || "").trim();
    const hasAttachment = !!uploadService?.hasAttachment?.(msg);
    const loweredText = text.toLowerCase();
    const isUploadOnlyCommand = loweredText === '/upload'
      || loweredText.startsWith('/upload ')
      || loweredText === '/attach'
      || loweredText.startsWith('/attach ');
    const uploadNote = isUploadOnlyCommand
      ? text.replace(/^\/(?:upload|attach)\s*/i, '').trim()
      : '';

    if (hasAttachment) {
      try {
        await uploadService.saveMessageAttachment(msg, { chatId, userId, uploadNote });
      } catch (error) {
        await bot.sendMessage(
          chatId,
          `❌ 파일 업로드 저장 실패: ${clip(String(error?.message ?? error), 220)}`,
          replyToMessageOptions(msg)
        );
        return;
      }
      if (isUploadOnlyCommand) return;
    }

    if (!text) return;

    const pasteState = getAwait(chatId);
    if (pasteState && !text.startsWith("/")) {
      await handlePasteModeMessage({
        bot,
        msg,
        chatId,
        userId,
        text,
        pasteState,
        tracking,
        jobs,
        extractJsonPlan,
        clearAwait,
        resetJobAbortController,
        activeJobByChat,
        loadSupervisorRuntime,
        executeActions,
        suggestNextPrompt,
        isCancelledError,
        jobAbortControllers,
      });
      return;
    }

    if (!text.startsWith("/")) {
      const plain = extractPlainChatMessage(msg, text, {
        botUsername: getBotUsername(),
        requireMentionInGroup,
      });
      if (!plain) return;

      if (isHardStopMessage(plain)) {
        await chatRunManager.hardCancel({
          chatId,
          reason: plain,
          userId,
          telegramMessageId: msg.message_id,
        });
        return;
      }

      await sendRouterAckMessage(bot, chatId, {
        replyToMessageId: msg.message_id,
      });
      await chatRunManager.handleIncoming({
        chatId,
        userId,
        text: plain,
        kind: "normal",
        telegramMessageId: msg.message_id,
        userReplyToMessageId: Number.isFinite(Number(msg?.reply_to_message?.message_id)) ? Number(msg.reply_to_message.message_id) : null,
        chatInfo: {
          chat_id: String(chatId || ""),
          title: String(msg?.chat?.title || msg?.chat?.username || "").trim(),
          type: String(msg?.chat?.type || "").trim(),
        },
      });
      return;
    }

    await handleTelegramCommand({ msg, text, chatId, userId });
  };
}
