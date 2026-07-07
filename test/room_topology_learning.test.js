import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomTopologyLearningCard, formatRoomTopologyLearningCardForTelegram } from '../src/application/room_topology_learning.js';

test('topology learning card prefers witness-aware bounded parallel topology for multi-agent memory loops', () => {
  const card = buildRoomTopologyLearningCard({
    profile: {
      current_goal: '여러 agent가 memory와 workspace를 같이 업데이트하는 loop',
      default_depth: 'loop',
      installed_skills: ['memory_projection', 'workspace_patch'],
      memory_schema: { object_types: ['peer_commitment', 'memory_update'] },
    },
  });
  assert.ok(card.candidates.length >= 3);
  assert.equal(card.dataset_schema.special_tokens.includes('<WITNESS>'), true);
  assert.equal(card.learning_policy.immediate_finetune.includes('not recommended'), true);
  assert.ok(card.candidates.some((row) => row.id === 'bounded_parallel_wccu_group'));
  const msg = formatRoomTopologyLearningCardForTelegram(card);
  assert.match(msg, /special tokens/);
  assert.match(msg, /WCCU-style/);
});
