import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendLoopTopology } from '../src/application/loop_topology_recommender.js';

test('engineering loop defaults to review loop while multi-view strategy uses deliberation', () => {
  const engineering = recommendLoopTopology({ taskText: '코드를 구현하고 테스트 후 review해', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
  assert.equal(engineering.topology_id, 'review_loop');
  const debate = recommendLoopTopology({ taskText: '세 가지 전략을 독립적으로 제안하고 찬반 토론 후 판정해', workflowContract: { workflow_kind: 'explore_then_synthesize' } });
  assert.equal(debate.topology_id, 'deliberation');
});

test('prior run outcomes are advisory and do not override a strong workflow requirement', () => {
  const priorRuns = Array.from({ length: 4 }, () => ({ state: { status: 'completed', spec: { topology: { topology_id: 'solo' } }, counters: { model_calls: 1 } } }));
  const rec = recommendLoopTopology({ taskText: '구현을 반복하고 독립 reviewer가 검사', workflowContract: { workflow_kind: 'bounded_continuous_loop' }, priorRuns });
  assert.equal(rec.topology_id, 'review_loop');
  assert.equal(rec.history_used, 4);
});
