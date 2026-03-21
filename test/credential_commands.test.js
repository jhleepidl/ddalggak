import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatSessionStore } from '../src/chat/session.js';
import { handleTelegramCredentialCommand } from '../src/adapters/telegram/credential_commands.js';

function makeStore() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-cred-cmd-'));
  return new ChatSessionStore({ baseDir });
}

test('credential set is allowed in group chat with warning and no raw secret in session', async () => {
  const store = makeStore();
  const sent = [];
  const deleted = [];
  const bot = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: 1 };
    },
    async deleteMessage(chatId, messageId) {
      deleted.push({ chatId, messageId });
    },
  };

  const handled = await handleTelegramCredentialCommand({
    bot,
    chatId: 'group-1',
    rawArgs: '/credential set OPENAI_API_KEY sk-group-123 --resume',
    chatSessionStore: store,
    chatType: 'group',
    telegramMessageId: 99,
  });

  assert.equal(handled, true);
  assert.equal(deleted.length, 1);
  assert.match(sent[0].text, /group chat/i);
  assert.match(sent[0].text, /Telegram 히스토리/);
  assert.match(sent[0].text, /로컬 secret store/);
  const sessionText = fs.readFileSync(store.filePath, 'utf8');
  assert.equal(sessionText.includes('sk-group-123'), false);
});
