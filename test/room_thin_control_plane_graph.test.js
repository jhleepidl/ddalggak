import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionGraph, recommendTopology } from '../src/room_runtime/room_execution_graph.js';

test('default graph is one provider-native execution capsule without duplicated planner or synthesizer', () => {
  assert.equal(recommendTopology('anything'), 'solo');
  const graph = buildExecutionGraph({ objective: 'complex implementation' });
  assert.equal(graph.provider_native_default, true);
  assert.deepEqual(graph.stages.map((stage) => stage.stage_id), ['execute']);
  assert.deepEqual(graph.stages.map((stage) => stage.role), ['builder']);
});

test('cross-provider collaboration is opt-in through explicit profiles', () => {
  const review = buildExecutionGraph({ collaborationProfile: 'builder_reviewer', maxReviewRounds: 1 });
  assert.deepEqual(review.stages.map((stage) => stage.stage_id), ['execute', 'review_1', 'revise_1', 'verify']);
  const research = buildExecutionGraph({ collaborationProfile: 'research_then_execute', maxReviewRounds: 1 });
  assert.equal(research.stages[0].stage_id, 'research');
  const deliberate = buildExecutionGraph({ collaborationProfile: 'parallel_ideation', maxReviewRounds: 1 });
  assert.deepEqual(deliberate.stages.slice(0, 3).map((stage) => stage.stage_id), ['propose_a', 'propose_b', 'adjudicate']);
});
