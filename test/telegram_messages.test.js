import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPlainChatMessage,
  createTelegramMessageHandler,
} from "../src/adapters/telegram/messages.js";

function createMessageHarness({
  requireMentionInGroup = false,
  botUsername = "ddalggak_bot",
  awaitState = null,
  uploadHasAttachment = false,
  extractJsonPlan = () => null,
} = {}) {
  const calls = {
    sendMessage: [],
    ack: [],
    hardCancel: [],
    handleIncoming: [],
    handleCommand: [],
    upload: [],
    tracking: [],
    conversation: [],
    clearAwait: [],
    resetAbort: [],
    executeActions: [],
    suggest: [],
    actor: [],
    runtimeLoads: [],
  };

  const activeJobByChat = new Map();
  const jobAbortControllers = new Map();

  const bot = {
    async sendMessage(chatId, text, options) {
      calls.sendMessage.push({ chatId, text, options });
      return { message_id: 8123 };
    },
  };

  const handler = createTelegramMessageHandler({
    telegramUi: {
      bot,
      clip: (value) => String(value || ""),
      getBotUsername: () => botUsername,
      requireMentionInGroup,
    },
    runtimeOps: {
      handleTelegramCommand: async (payload) => {
        calls.handleCommand.push(payload);
        return true;
      },
      sendRouterAckMessage: async (_bot, chatId, payload) => {
        calls.ack.push({ chatId, payload });
      },
      chatRunManager: {
        async hardCancel(payload) {
          calls.hardCancel.push(payload);
        },
        async handleIncoming(payload) {
          calls.handleIncoming.push(payload);
        },
      },
      async loadSupervisorRuntime(jobId, options) {
        calls.runtimeLoads.push({ jobId, options });
        return { runtime: jobId };
      },
      async executeActions(...args) {
        calls.executeActions.push(args);
      },
      async suggestNextPrompt(...args) {
        calls.suggest.push(args);
      },
      isCancelledError: () => false,
    },
    jobOps: {
      tracking: {
        append(...args) {
          calls.tracking.push(args);
        },
      },
      jobs: {
        appendConversation(...args) {
          calls.conversation.push(args);
        },
      },
      resetJobAbortController(jobId) {
        calls.resetAbort.push(jobId);
        return { signal: { aborted: false } };
      },
      extractJsonPlan,
    },
    sessionOps: {
      getAwait: () => awaitState,
      clearAwait: (chatId) => {
        calls.clearAwait.push(chatId);
      },
      activeJobByChat,
      jobAbortControllers,
    },
    fileOps: {
      uploadService: {
        hasAttachment: () => uploadHasAttachment,
        async saveMessageAttachment(msg, meta) {
          calls.upload.push({ msg, meta });
        },
      },
    },
    teamOps: {
      isAllowedChat: () => true,
      isAllowedUser: () => true,
      setGocActingTelegramUser: (userId) => {
        calls.actor.push(userId);
      },
    },
  });

  return {
    calls,
    activeJobByChat,
    jobAbortControllers,
    handler,
  };
}

test("extractPlainChatMessage requires mention in group chats when configured", () => {
  const msg = {
    chat: { type: "supergroup" },
    entities: [{ type: "mention", offset: 0, length: 13 }],
  };

  assert.equal(
    extractPlainChatMessage(msg, "@ddalggak_bot run tests", {
      botUsername: "ddalggak_bot",
      requireMentionInGroup: true,
    }),
    "run tests"
  );
  assert.equal(
    extractPlainChatMessage(msg, "run tests", {
      botUsername: "ddalggak_bot",
      requireMentionInGroup: true,
    }),
    ""
  );
  assert.equal(
    extractPlainChatMessage({ chat: { type: "private" } }, "run tests", {
      botUsername: "ddalggak_bot",
      requireMentionInGroup: true,
    }),
    "run tests"
  );
});

test("message handler hands off Telegram uploads before text routing", async () => {
  const harness = createMessageHarness({
    uploadHasAttachment: true,
  });

  await harness.handler({
    message_id: 101,
    chat: { id: 11, type: "private" },
    from: { id: 22 },
    document: { file_id: "file" },
  });

  assert.equal(harness.calls.upload.length, 1);
  assert.deepEqual(harness.calls.upload[0].meta, { chatId: 11, userId: 22, uploadNote: "" });
  assert.equal(harness.calls.handleIncoming.length, 0);
});


test("message handler treats /upload caption as upload-only and skips text routing", async () => {
  const harness = createMessageHarness({
    uploadHasAttachment: true,
  });

  await harness.handler({
    message_id: 111,
    chat: { id: 11, type: "private" },
    from: { id: 22 },
    document: { file_id: "file" },
    caption: "/upload spec 자료",
  });

  assert.equal(harness.calls.upload.length, 1);
  assert.equal(harness.calls.upload[0].meta.uploadNote, "spec 자료");
  assert.equal(harness.calls.handleIncoming.length, 0);
  assert.equal(harness.calls.handleCommand.length, 0);
});

test("message handler routes hard-stop text through chatRunManager", async () => {
  const harness = createMessageHarness();

  await harness.handler({
    message_id: 202,
    chat: { id: 11, type: "private" },
    from: { id: 22 },
    text: "중단해",
  });

  assert.equal(harness.calls.hardCancel.length, 1);
  assert.equal(harness.calls.ack.length, 0);
  assert.equal(harness.calls.handleIncoming.length, 0);
});

test("message handler executes pasted JSON plans from await state", async () => {
  const harness = createMessageHarness({
    awaitState: { jobId: "job_plan_1", userId: "telegram-22" },
    extractJsonPlan: () => ({
      jobId: "job_plan_1",
      actions: [{ type: "noop" }],
    }),
  });

  await harness.handler({
    message_id: 303,
    chat: { id: 11, type: "private" },
    from: { id: 22 },
    text: "{\"jobId\":\"job_plan_1\",\"actions\":[{\"type\":\"noop\"}]}",
  });

  assert.equal(harness.calls.tracking.length, 1);
  assert.equal(harness.calls.conversation.length, 1);
  assert.deepEqual(harness.calls.clearAwait, [11]);
  assert.deepEqual(harness.calls.resetAbort, ["job_plan_1"]);
  assert.equal(harness.calls.executeActions.length, 1);
  assert.equal(harness.calls.suggest.length, 1);
  assert.equal(harness.activeJobByChat.size, 0);
  assert.match(harness.calls.sendMessage[0].text, /JSON 액션 플랜 감지/);
  assert.match(harness.calls.sendMessage[1].text, /액션 플랜 실행 완료/);
});
