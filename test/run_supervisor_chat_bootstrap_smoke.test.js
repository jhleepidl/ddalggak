import test from 'node:test';
import assert from 'node:assert/strict';

test('runSupervisorChat boots single-agent chat without helper ReferenceErrors', async () => {
  const { runSupervisorChat } = await import('../src/application/telegram_chat_execution.js');
  const sent = [];
  const bot = {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text: String(text || '') });
      return { message_id: sent.length };
    },
    editMessageText: async () => null,
  };

  await assert.doesNotReject(async () => {
    await runSupervisorChat(bot, 990001, 880001, 'hello from smoke test', {
      debug: false,
      forceMode: 'normal',
      chatInfo: { chat_id: '990001', type: 'private' },
      inputKind: 'test_chat',
      telegramMessageId: 501,
    });
  });

  assert.ok(sent.length > 0);
  assert.equal(sent.some((row) => /normalizeForceMode is not defined/.test(row.text)), false);
  assert.equal(sent.some((row) => /ReferenceError/.test(row.text)), false);
});
