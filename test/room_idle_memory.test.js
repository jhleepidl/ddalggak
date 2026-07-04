import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRoomIdleMemoryCandidates,
  runRoomIdleMemoryStructuring,
} from '../src/application/room_idle_memory.js';

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

test('idle memory structuring proposes schema-agnostic candidates from durable user-authored cues', () => {
  const turns = [
    { role: 'user', turn_id: 't1', text: '다음부터 곱창이나 대창은 추천하지 말아줘. 건강한 메뉴 위주가 좋아.' },
  ];
  const candidates = deriveRoomIdleMemoryCandidates({
    turns,
    roomProfile: {
      name: 'Meal Room',
      default_agents: ['meal_history_tracker', 'next_meal_planner'],
      memory_schema: { object_types: ['diet_preferences', 'restrictions'] },
    },
    activeCompanionId: 'personal',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observation_type, 'user_boundary_or_exclusion');
  assert.equal(candidates[0].canonical_write_enabled, false);
  assert.equal(candidates[0].review_required, true);
  assert.ok(candidates[0].target_companion_ids.includes('critic'));
  assert.match(candidates[0].rationale, /candidate/);
});

test('idle memory structuring deduplicates and stores candidate-only maintenance state', () => {
  const store = makeSessionStore({
    chat1: {
      recent_room_turns: [
        { role: 'user', turn_id: 't1', text: '앞으로 서울대입구역 주변에서 추천해줘.' },
      ],
    },
  });
  const events = [];
  const first = runRoomIdleMemoryStructuring({
    chatSessionStore: store,
    chatId: 'chat1',
    roomProfile: { name: 'Local Recommendation Room', default_agents: ['answer_synthesizer'] },
    appendEvent: (event) => events.push(event),
    force: true,
  });
  const second = runRoomIdleMemoryStructuring({
    chatSessionStore: store,
    chatId: 'chat1',
    roomProfile: { name: 'Local Recommendation Room', default_agents: ['answer_synthesizer'] },
    appendEvent: (event) => events.push(event),
    force: true,
  });

  assert.equal(first.candidates_created, 1);
  assert.equal(second.candidates_created, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'room_idle_memory_observation_proposed');
  assert.equal(events[0].payload.canonical_write_enabled, false);
  const session = store.get('chat1');
  assert.equal(session.room_idle_memory_candidates.length, 1);
  assert.equal(session.room_idle_memory_maintenance.candidate_only, true);
  assert.match(session.room_idle_memory_maintenance.generalization_policy, /schema_agnostic/);
});

test('idle memory structuring skips corrupted UTF-8 context quotes', () => {
  const candidates = deriveRoomIdleMemoryCandidates({
    turns: [{ role: 'user', turn_id: 'bad', text: '가보실 ��한 메뉴는 다음부터 제외해줘' }],
    roomProfile: { name: 'Meal Room' },
  });
  assert.equal(candidates.length, 0);
});
