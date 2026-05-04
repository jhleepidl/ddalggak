import test from 'node:test';
import assert from 'node:assert/strict';

import { attachMemoryRoutingToRawPlan, normalizeRouterMemoryRouting } from '../src/application/router_memory_plan.js';
import { normalizeActionPlan } from '../src/chat/actions.js';

test('normalizes router memory routing payload', () => {
  const plan = normalizeRouterMemoryRouting({
    mode: 'expanded',
    query: 'previous design decisions',
    source_types: ['conversation', 'task', 'files', 'user_fact', 'decisions'],
    reasons: ['semantic_followup'],
    confidence: 1.2,
    classifier: 'supervisor_router_llm',
  });
  assert.deepEqual(plan.source_types, ['turns', 'task_state', 'artifacts', 'user_facts', 'decisions']);
  assert.equal(plan.confidence, 1);
  assert.equal(plan.classifier, 'supervisor_router_llm');
});

test('attaches top-level memory routing to run_agent scope before action normalization', () => {
  const raw = {
    memory_routing: {
      mode: 'query',
      query: 'memory topology implementation state',
      source_types: ['turns', 'shared_work'],
      reasons: ['semantic_continuity'],
      classifier: 'supervisor_router_llm',
    },
    actions: [{ type: 'run_agent', agent_id: 'builder', goal: 'continue implementation' }],
  };
  const attached = attachMemoryRoutingToRawPlan(raw, raw.memory_routing);
  const normalized = normalizeActionPlan(attached);
  assert.equal(normalized.actions.length, 1);
  assert.equal(normalized.actions[0].scope.mode, 'unfold_query');
  assert.equal(normalized.actions[0].scope.memory_demand.classifier, 'supervisor_router_llm');
  assert.deepEqual(normalized.actions[0].scope.memory_demand.source_types, ['turns', 'shared_work']);
});
