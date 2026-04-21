import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWithSupervisor } from '../src/chat/supervisor_router.js';

test('routeWithSupervisor bypasses router model for fast lane', async () => {
  const plan = await routeWithSupervisor('서울은 한국의 수도야?', {
    agents: [{ id: 'researcher', provider: 'gemini', name: 'Researcher' }],
    executionLane: 'fast',
  });

  assert.equal(plan.execution_lane, 'fast');
  assert.match(String(plan.reason || ''), /fast_lane_router_bypass/);
  assert.ok(Array.isArray(plan.actions));
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'run_agent');
});
