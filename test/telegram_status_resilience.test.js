import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatStatusCard } from '../src/application/telegram_runtime_ui.js';
import { activeJobByChat } from '../src/application/telegram_runtime_state.js';

test('buildChatStatusCard handles missing session rows safely', () => {
  const chatId = 'status-missing-session';
  activeJobByChat.delete(chatId);
  const card = buildChatStatusCard(chatId, null);
  assert.match(card.text, /phase: 대기 중/);
  assert.match(card.text, /situation: 새 요청을 기다리고 있습니다\./);
  assert.equal(card.status.state, 'idle');
});
