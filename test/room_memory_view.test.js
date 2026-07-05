import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRoomMemoryView,
  formatRoomMemoryListForTelegram,
  formatRoomMemoryProposalsForTelegram,
  updateRoomMemoryCandidateDecision,
} from '../src/application/room_memory_view.js';

function makeSessionStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(String(key)) || {},
    upsert: (key, updater) => {
      const id = String(key);
      const prev = map.get(id) || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...(updater || {}) };
      map.set(id, next);
      return next;
    },
  };
}

test('room memory view separates active memory from pending proposals', () => {
  const session = {
    room_memory_items: [
      { memory_id: 'mem_a', type: 'preference', summary: '사용자는 서울대입구역 주변 추천을 선호한다.', owner_companion_ids: ['personal'] },
    ],
    room_idle_memory_candidates: [
      { candidate_id: 'cand_b', status: 'pending', observation_type: 'user_boundary_or_exclusion', memory_summary: '곱창/대창은 추천하지 않는다.', target_companion_ids: ['critic', 'personal'] },
    ],
  };
  const view = deriveRoomMemoryView({ session });
  assert.equal(view.stats.active_count, 1);
  assert.equal(view.stats.pending_candidate_count, 1);
  assert.match(formatRoomMemoryListForTelegram(view), /서울대입구역/);
  assert.match(formatRoomMemoryProposalsForTelegram(view), /곱창\/대창/);
});

test('approving a room memory proposal creates active room-local memory with provenance', () => {
  const store = makeSessionStore({
    chat1: {
      room_idle_memory_candidates: [
        { candidate_id: 'cand1', status: 'pending', observation_type: 'stable_preference_candidate', memory_summary: '사용자는 베이스와 기타를 배우고 싶어한다.', source_turn_id: 't1', target_companion_ids: ['personal'] },
      ],
    },
  });
  const result = updateRoomMemoryCandidateDecision({ chatSessionStore: store, chatId: 'chat1', target: 'latest', decision: 'approve', userId: 'u1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'active');
  const session = store.get('chat1');
  assert.equal(session.room_memory_items.length, 1);
  assert.equal(session.room_memory_items[0].provenance.approved_by, 'u1');
  assert.equal(session.room_memory_items[0].review.canonical_write_enabled, false);
  const view = deriveRoomMemoryView({ session });
  assert.equal(view.stats.active_count, 1);
  assert.equal(view.stats.pending_candidate_count, 0);
});

test('rejecting a room memory proposal does not create active memory', () => {
  const store = makeSessionStore({
    chat1: {
      room_idle_memory_candidates: [
        { candidate_id: 'cand1', status: 'pending', observation_type: 'stable_preference_candidate', memory_summary: '임시 후보' },
      ],
    },
  });
  const result = updateRoomMemoryCandidateDecision({ chatSessionStore: store, chatId: 'chat1', target: '1', decision: 'reject', reason: 'temporary' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'rejected');
  const session = store.get('chat1');
  assert.equal((session.room_memory_items || []).length, 0);
  assert.equal(session.room_idle_memory_candidates[0].status, 'rejected');
});
