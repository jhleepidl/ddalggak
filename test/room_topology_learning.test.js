import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomTopologyLearningCard, evaluateTopologyReplay, formatRoomTopologyLearningCardForTelegram, formatTopologyReplayEvaluationForTelegram } from '../src/application/room_topology_learning.js';

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


test('topology replay evaluator ranks trial candidates without durable mutation', () => {
  const report = evaluateTopologyReplay({
    events: [
      { event_type: 'code_patch_requested', command: '/room topology replay', extra: { agent_calls: [{ agent_id: 'builder', model_role: 'code_executor', total_tokens: 1200, latency_ms: 800, contribution_score: 0.6 }] } },
      { event_type: 'review_required', extra: { agent_calls: [{ agent_id: 'reviewer', model_role: 'verifier_critic', total_tokens: 600, latency_ms: 500, contribution_score: 0.7 }] } },
      { event_type: 'room_memory_candidate_approved', extra: { status: 'approved' } },
    ],
    profile: { current_goal: 'code patch with memory and verifier evidence' },
  });
  assert.equal(report.kind, 'room_topology_replay_evaluator_v1');
  assert.equal(report.proposal_path.direct_room_state_mutation, false);
  assert.match(report.proposal_path.durable_change_requires, /proposal/);
  assert.ok(report.ranked_candidates.length >= 3);
  assert.ok(report.ranked_candidates.some((row) => row.topology_id === 'reviewer_gated_pipeline'));
  assert.match(report.guardrails.join(' '), /room-level scorer/);
  const msg = formatTopologyReplayEvaluationForTelegram(report);
  assert.match(msg, /replay evaluator/);
  assert.match(msg, /direct mutation: no/);
});
