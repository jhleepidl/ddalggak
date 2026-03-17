import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScopeHintSpec,
  defaultScopeHintForAgent,
  resolveEffectiveScopeHint,
  validateScopeHint,
} from '../src/domain/scope_hint.js';


test('normalizeScopeHintSpec provides canonical scope-first normalization', () => {
  const spec = normalizeScopeHintSpec({
    query: 'find context',
    budget_tokens: 50000,
    closure_direction: 'FORWARD',
    addNodeIds: ['a', 'b', 'a'],
  });
  assert.equal(spec.mode, 'unfold_query');
  assert.equal(spec.budget_tokens, 12000);
  assert.equal(spec.closure_direction, 'forward');
  assert.deepEqual(spec.add_node_ids, ['a', 'b']);
});


test('defaultScopeHintForAgent keeps planner as shared_only', () => {
  const spec = defaultScopeHintForAgent({ agentId: 'planner', goal: 'ship feature' });
  assert.equal(spec.mode, 'shared_only');
  assert.equal(spec.budget_tokens, 900);
});


test('resolveEffectiveScopeHint uses custom scope when provided', () => {
  const spec = resolveEffectiveScopeHint({ mode: 'add_nodes', add_node_ids: ['n1'] }, {
    agentId: 'coder',
    goal: 'update file',
    recentArtifactNodeIds: ['x'],
  });
  assert.equal(spec.mode, 'add_nodes');
  assert.deepEqual(spec.add_node_ids, ['n1']);
});


test('validateScopeHint returns canonical scope_hint payload', () => {
  const result = validateScopeHint({ mode: 'remove_nodes', remove_node_ids: ['n1'] });
  assert.equal(result.ok, true);
  assert.equal(result.scope_hint.mode, 'remove_nodes');
});
