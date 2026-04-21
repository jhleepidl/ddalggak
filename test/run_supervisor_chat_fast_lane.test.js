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

test('runSupervisorChat fast lane uses a single provider turn for lightweight questions', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-fast-lane-'));
  const geminiLog = path.join(binDir, 'gemini-count.txt');
  const codexLog = path.join(binDir, 'codex-count.txt');
  const geminiPath = path.join(binDir, 'gemini');
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(geminiPath, `#!/usr/bin/env bash\nprintf x >> "${geminiLog}"\necho "FAST LANE GEMINI OUTPUT"\n`, { mode: 0o755 });
  fs.writeFileSync(codexPath, `#!/usr/bin/env bash\nprintf x >> "${codexLog}"\necho "FAST LANE CODEX OUTPUT"\n`, { mode: 0o755 });

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
    await runSupervisorChat(bot, 991001, 881001, '서울은 어디 나라 수도야?', {
      debug: false,
      forceMode: 'normal',
      chatInfo: { chat_id: '991001', type: 'private' },
      inputKind: 'test_chat',
      telegramMessageId: 701,
    });
  });

  const geminiCalls = fs.existsSync(geminiLog) ? fs.readFileSync(geminiLog, 'utf8').length : 0;
  const codexCalls = fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').length : 0;
  assert.equal(geminiCalls + codexCalls, 1);
  const joined = sent.join('\n\n');
  assert.match(joined, /FAST LANE GEMINI OUTPUT|FAST LANE CODEX OUTPUT/);
});
