import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAction } from '../src/chat/actions.js';

test('normalize fork_agent preserves scope and rejoin hints', () => {
  const action = normalizeAction({
    type: 'fork_agent',
    agent_id: 'Builder',
    reason: 'isolate risky patch',
    goal: 'implement migration',
    scope: { mode: 'unfold_query', query: 'db migration' },
    scope_node_ids: ['n1', 'n2'],
    source_surface_ids: ['plan'],
    publish_surface_ids: ['artifact_index'],
    rejoin_strategy: 'manual',
  });
  assert.equal(action?.type, 'fork_agent');
  assert.equal(action?.agent_id, 'builder');
  assert.equal(action?.scope?.mode, 'unfold_query');
  assert.deepEqual(action?.scope_node_ids, ['n1', 'n2']);
  assert.deepEqual(action?.publish_surface_ids, ['artifact_index']);
  assert.equal(action?.rejoin_strategy, 'manual');
});

test('normalize rejoin_agent captures target and surfaces', () => {
  const action = normalizeAction({
    type: 'rejoin_agent',
    agent_id: 'builder-fork',
    target_agent_id: 'builder',
    summary: 'merged validated patch',
    publish_surface_ids: ['final_answer', 'artifact_index'],
  });
  assert.equal(action?.type, 'rejoin_agent');
  assert.equal(action?.agent_id, 'builder-fork');
  assert.equal(action?.target_agent_id, 'builder');
  assert.deepEqual(action?.publish_surface_ids, ['final_answer', 'artifact_index']);
});
