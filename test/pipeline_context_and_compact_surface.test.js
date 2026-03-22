import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultScopeGrantsForRole } from '../src/domain/scope_grant.js';
import { repairRoutePlanForTeamExecution } from '../src/application/team_route_repair.js';

test('builder scope grants include upstream handoff access by default', () => {
  const shared = defaultScopeGrantsForRole({ roleId: 'builder', mode: 'shared_memory' });
  const scoped = defaultScopeGrantsForRole({ roleId: 'builder', mode: 'scoped_context' });
  assert.equal(shared.upstream_results, true);
  assert.equal(shared.upstream_summaries, true);
  assert.equal(scoped.upstream_results, true);
  assert.equal(scoped.upstream_summaries, true);
});

test('builder route repair goal explicitly references upstream handoff instead of raw user prompt only', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      agents: [
        { agent_id: 'service_builder', role: 'builder', name: 'Service Builder', provider: 'codex', model: 'gpt-5-codex' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'forced_coder_for_code_deliverable',
    actions: [{ type: 'run_agent', agent_id: 'service_builder', goal: '새 웹 서비스를 만들어줘' }],
    team_locked: true,
  }, {
    message: '새 웹 서비스를 만들어줘',
    runtime,
    runtimeTeamSnapshot: { task_interpretation: { task_type: 'code_change', deliverable_type: 'software_delivery' } },
  });
  assert.match(repaired.actions[0].goal, /upstream handoff/i);
  assert.match(repaired.actions[0].goal, /raw user request/i);
});
