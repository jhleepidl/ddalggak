import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRoomLoopEvent,
  buildRoomLoopStartEvent,
  classifyRoomLoopInterruption,
  createRoomLoopId,
  deriveActiveRoomLoop,
  formatActiveRoomLoopProjectionBlock,
  normalizeRoomLoop,
  readRoomLoopEvents,
} from '../src/application/room_loop_events.js';

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

test('room loop start and interruption events are persisted in job and session substrates', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-loop-events-'));
  const sessionStore = makeSessionStore();
  try {
    const loop = normalizeRoomLoop({
      loop_id: createRoomLoopId({ chatId: 'chat-1', objective: '가격 비교 루프', source: 'test' }),
      chat_id: 'chat-1',
      objective: '가격 비교 루프',
      current_plan: ['plan', 'search', 'verify'],
    });
    const start = buildRoomLoopStartEvent({ loop, chatId: 'chat-1', userId: 'user-1', jobId: 'job-1' });
    appendRoomLoopEvent({ jobDir, chatSessionStore: sessionStore, chatId: 'chat-1', userId: 'user-1', jobId: 'job-1', event: start });

    const activeBefore = deriveActiveRoomLoop({ events: readRoomLoopEvents({ jobDir, session: sessionStore.get('chat-1') }) });
    assert.equal(activeBefore.loop_id, loop.loop_id);
    assert.equal(activeBefore.status, 'running');

    const interruption = classifyRoomLoopInterruption({
      text: '예산은 5만원 이하로 바꿔서 계속해줘',
      command: '/chat',
      activeLoop: activeBefore,
    });
    assert.equal(interruption.interrupt_type, 'redirect');
    appendRoomLoopEvent({ jobDir, chatSessionStore: sessionStore, chatId: 'chat-1', userId: 'user-1', jobId: 'job-1', event: interruption });

    const events = readRoomLoopEvents({ jobDir, session: sessionStore.get('chat-1') });
    assert.equal(events.length, 2);
    const activeAfter = deriveActiveRoomLoop({ events, session: sessionStore.get('chat-1') });
    assert.equal(activeAfter.status, 'running');
    assert.match(activeAfter.objective, /예산은 5만원/);
    assert.match(activeAfter.current_plan[0], /Replan/);

    const local = fs.readFileSync(path.join(jobDir, 'local_memory', 'room_loop_events.jsonl'), 'utf8');
    assert.match(local, /loop_started/);
    assert.match(local, /user_interrupt/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('active room loop projection renders loop control state for prompt recompilation', () => {
  const loop = normalizeRoomLoop({
    loop_id: 'room_loop_test',
    objective: '여행 계획 비교',
    status: 'running',
    current_plan: ['search candidates', 'compare tradeoffs'],
    active_constraints: ['budget under 500 USD'],
    interruptions: [{ interrupt_type: 'constraint_update', text: '예산을 더 낮춰' }],
    branches: [{ branch_id: 'branch_b', objective: '차 없는 일정도 비교' }],
  });
  const block = formatActiveRoomLoopProjectionBlock({ loop });
  assert.match(block, /ACTIVE ROOM LOOP/);
  assert.match(block, /room_loop_test/);
  assert.match(block, /budget under 500 USD/);
  assert.match(block, /RECENT LOOP INTERRUPTIONS/);
  assert.match(block, /loop_policy/);
});
