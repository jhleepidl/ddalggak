import test from 'node:test';
import assert from 'node:assert/strict';

import { mergePreferredRuntimeTeamSnapshot } from '../src/chat/route_execution_contract.js';


test('mergePreferredRuntimeTeamSnapshot preserves route contract metadata from route plan', () => {
  const merged = mergePreferredRuntimeTeamSnapshot({
    baseSnapshot: {
      team_plan: { title: 'base' },
      runtime_agents: [],
    },
    routePlan: {
      route_contract: {
        available: true,
        final_owner: 'Delivery Synthesizer',
        final_owner_id: 'synth',
        final_answer_publish_ok: true,
        final_answer_publish_state: 'ready',
        artifact_publish_ok: true,
        artifact_publishers: ['Client Companion Builder'],
        artifact_publisher_ids: ['builder'],
      },
      route_contract_adjusted: true,
      route_contract_preferred_agent: 'synth',
      route_contract_adjustment_type: 'run_agent',
    },
  });
  assert.equal(merged.route_contract?.final_owner_id, 'synth');
  assert.equal(merged.route_contract?.artifact_publisher_ids?.[0], 'builder');
  assert.equal(merged.route_contract_adjusted, true);
  assert.equal(merged.route_contract_preferred_agent, 'synth');
});
