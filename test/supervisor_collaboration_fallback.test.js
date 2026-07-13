import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCollaborationFallbackPlan } from '../src/chat/supervisor_router.js';

test('builder-reviewer fallback preserves builder, independent review, and final synthesis', () => {
  const plan = buildCollaborationFallbackPlan('운영 체크리스트를 만들어줘', {
    agents: [
      { id: 'builder', role: 'builder' },
      { id: 'reviewer', role: 'reviewer' },
      { id: 'synthesizer', role: 'synthesizer' },
    ],
    activeTeam: { interaction_spec: { execution_pattern: 'builder_reviewer_loop' } },
  });
  assert.match(plan.reason, /builder_reviewer_loop/);
  assert.deepEqual(plan.actions.map((row) => row.type), ['run_agent', 'run_agent', 'synthesize_final']);
  assert.deepEqual(plan.actions.map((row) => row.agent_id), ['builder', 'reviewer', 'synthesizer']);
});

test('parallel collaboration fallback creates isolated lanes and a final adjudicator', () => {
  const plan = buildCollaborationFallbackPlan('서로 다른 대안을 비교해줘', {
    agents: [
      { id: 'researcher_lane_1', role: 'researcher' },
      { id: 'researcher_lane_2', role: 'researcher' },
      { id: 'reviewer', role: 'reviewer' },
      { id: 'synthesizer', role: 'synthesizer' },
    ],
    activeTeam: { interaction_spec: { execution_pattern: 'parallel_research_then_review_then_synthesize' } },
    parallelSpawnAllowed: true,
  });
  assert.equal(plan.actions[0].type, 'spawn_agents');
  assert.equal(plan.actions[0].agents.length, 2);
  assert.equal(plan.actions[1].type, 'run_agent');
  assert.equal(plan.actions[1].agent_id, 'reviewer');
  assert.equal(plan.actions[2].type, 'synthesize_final');
  assert.equal(plan.actions[2].agent_id, 'synthesizer');
  assert.match(plan.actions[0].agents[0].goal, /independently/i);
});
