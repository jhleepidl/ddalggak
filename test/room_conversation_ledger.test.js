import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomConversationExchange, normalizeRecentRoomTurns, seedRoomConversationLedgerIntoJob, formatRoomContinuityPromptBlock } from '../src/application/room_conversation_ledger.js';

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function makeSessionStore() {
  const state = new Map();
  return {
    get: (chatId) => state.get(String(chatId)) || {},
    upsert: (chatId, updater) => {
      const key = String(chatId);
      const prev = state.get(key) || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...(updater || {}) };
      state.set(key, next);
      return next;
    },
  };
}

test('direct Room Concierge exchanges are written to shared room conversation ledger and task packet', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-ledger-'));
  const sessionStore = makeSessionStore();
  try {
    const result = appendRoomConversationExchange({
      jobDir,
      chatSessionStore: sessionStore,
      chatId: 'chat-1',
      userId: 'user-1',
      userText: '오늘 저녁 혼자 배달 뭐 먹을까?',
      assistantText: '냉면을 먹었으면 저녁은 따뜻한 단백질 메뉴가 좋아요.',
      command: '/c',
      source: 'room_concierge_direct_fast_path',
      provider: 'antigravity',
      route: 'concierge_direct_answer',
      jobId: 'job-1',
    });

    assert.ok(result.userTurn.turn_id);
    const turns = readJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'));
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[1].role, 'assistant');
    const conversation = readJsonl(path.join(jobDir, 'conversation.jsonl'));
    assert.equal(conversation.length, 2);
    assert.equal(conversation[0].kind, 'room_concierge_direct_fast_path');
    const packet = JSON.parse(fs.readFileSync(path.join(jobDir, 'local_memory', 'current_task_packet.json'), 'utf8'));
    assert.match(packet.latest_user_quote, /오늘 저녁 혼자 배달/);
    assert.equal(sessionStore.get('chat-1').recent_room_turns.length, 2);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('session recent room turns can seed a later workbench job', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-ledger-seed-'));
  try {
    const session = {
      recent_room_turns: normalizeRecentRoomTurns([
        { role: 'user', text: '방금 direct path에서 말한 사실', turn_id: 'turn-user-1', source: 'room_concierge_direct_fast_path' },
        { role: 'assistant', text: '방금 direct path 답변', turn_id: 'turn-assistant-1', source: 'room_concierge_direct_fast_path' },
      ]),
    };
    const result = seedRoomConversationLedgerIntoJob({ jobDir, session });
    assert.equal(result.seeded, 2);
    const turns = readJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'));
    assert.equal(turns.length, 2);
    const packet = JSON.parse(fs.readFileSync(path.join(jobDir, 'local_memory', 'current_task_packet.json'), 'utf8'));
    assert.match(packet.latest_user_quote, /방금 direct path에서 말한 사실/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('room continuity prompt block preserves direct fast-path context for later agents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-room-continuity-'));
  try {
    appendRoomConversationExchange({
      jobDir: dir,
      chatId: 'chat-1',
      userId: 'u1',
      userText: '서울대입구역 주변에서 먹을만한 식당으로 추천해줘.',
      assistantText: '서울대입구역 주변 후보는 우나기쿄다이, 쭈앤쭈, 우리가참순대입니다.',
      command: '/c',
      source: 'room_concierge_direct_fast_path',
      route: 'concierge_direct_answer',
    });
    const block = formatRoomContinuityPromptBlock({ jobDir: dir, limit: 4 });
    assert.match(block, /ROOM CONTINUITY/);
    assert.match(block, /서울대입구역/);
    assert.match(block, /direct/);
    assert.match(block, /omits a referent, constraint, or preference/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
