import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAction } from '../src/chat/actions.js';
import { normalizeRuntimeAgentInstance } from '../src/domain/runtime_agent.js';

test('normalizeAction accepts scope as the public alias for lens on run_agent', () => {
  const action = normalizeAction({
    type: 'run_agent',
    agent_id: 'researcher',
    goal: 'check filings',
    scope: { mode: 'unfold_query', query: 'Samsung filings', budget_tokens: 1400 },
  });
  assert.equal(action?.scope?.mode, 'unfold_query');
  assert.equal(action?.lens?.query, 'Samsung filings');
});

test('normalizeAction accepts scope on spawn_agents children', () => {
  const action = normalizeAction({
    type: 'spawn_agents',
    summary: 'parallel research',
    scope: { mode: 'shared_only', budget_tokens: 900 },
    agents: [
      { agent_id: 'researcher', goal: 'news', scope: { mode: 'unfold_query', query: 'market news' } },
      { agent_id: 'reviewer', goal: 'review', scope: { mode: 'shared_only' } },
    ],
  });
  assert.equal(action?.scope?.mode, 'shared_only');
  assert.equal(action?.agents?.[0]?.lens?.query, 'market news');
  assert.equal(action?.agents?.[1]?.scope?.mode, 'shared_only');
});

test('runtime agent normalization mirrors scope_hint into lens_spec for compatibility', () => {
  const agent = normalizeRuntimeAgentInstance({
    instance_id: 'rt_1',
    role_id: 'researcher',
    scope_hint: { mode: 'unfold_query', query: 'evidence only' },
  });
  assert.equal(agent?.scope_hint?.query, 'evidence only');
  assert.equal(agent?.lens_spec?.mode, 'unfold_query');
});
