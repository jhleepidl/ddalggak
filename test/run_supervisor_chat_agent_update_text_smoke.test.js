import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function withPatchedPath(binDir, fn) {
  const originalPath = process.env.PATH || '';
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath;
    });
}

test('runSupervisorChat completes first agent turn without buildAgentChatUpdateText ReferenceError', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-smoke-'));
  const geminiPath = path.join(binDir, 'gemini');
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(geminiPath, '#!/usr/bin/env bash\necho "hello from fake gemini"\n', { mode: 0o755 });
  fs.writeFileSync(codexPath, '#!/usr/bin/env bash\necho "hello from fake codex"\n', { mode: 0o755 });

  const { runSupervisorChat } = await import('../src/application/telegram_chat_execution.js');
  const sent = [];
  const bot = {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text || ''));
      return { message_id: sent.length };
    },
    editMessageText: async () => null,
  };

  await withPatchedPath(binDir, async () => {
    await assert.doesNotReject(async () => {
      await runSupervisorChat(bot, 990101, 880101, 'hello from buildAgentChatUpdateText smoke test', {
        debug: false,
        forceMode: 'normal',
        chatInfo: { chat_id: '990101', type: 'private' },
        inputKind: 'test_chat',
        telegramMessageId: 601,
      });
    });
  });

  const joined = sent.join('\n\n');
  assert.match(joined, /완료|hello from fake gemini|hello from fake codex/);
  assert.equal(/buildAgentChatUpdateText is not defined/.test(joined), false);
  assert.equal(/ReferenceError/.test(joined), false);
});
