import test from 'node:test';
import assert from 'node:assert/strict';

import { ScopePlanner } from '../src/control_plane/scope_planner.js';
import { normalizeTeamPlan } from '../src/domain/team_plan.js';
import { createRuntimeTeamSnapshot } from '../src/application/runtime_metadata.js';
import { inferContextRuntimeMode, summarizeLegacyContextState } from '../src/domain/context_runtime.js';
import { hydrateRuntimeScopesViaGoC, buildScopedPromptAssembly, resolveScopeBinding, resolveScopeExecutionState } from '../src/application/goc_scope_runtime.js';

test('scope planner emits scoped visibility metadata for reviewer-inclusive teams', () => {
  const planner = new ScopePlanner();
  const teamPlan = normalizeTeamPlan({
    slots: [
      { slot_id: 'slot_research', role_id: 'researcher', purpose: 'collect filing evidence' },
      { slot_id: 'slot_review', role_id: 'reviewer', purpose: 'review upstream findings' },
    ],
    context_runtime_mode: 'scoped_context',
    execution_graph: {
      edges: [
        { from_slot_id: 'slot_research', to_slot_id: 'slot_review', relation: 'precedes' },
      ],
    },
  });
  const runtimeAgents = [
    { instance_id: 'rt_research', slot_id: 'slot_research', role_id: 'researcher' },
    { instance_id: 'rt_review', slot_id: 'slot_review', role_id: 'reviewer' },
  ];
  const contextPacks = [
    { context_pack_id: 'cp_research', target_runtime_agent_instance_id: 'rt_research', context_types: ['filings', 'evidence'] },
    { context_pack_id: 'cp_review', target_runtime_agent_instance_id: 'rt_review', context_types: ['evidence', 'summaries'] },
  ];

  const result = planner.build({
    runId: 'run_scope_test',
    goal: 'review samsung filings',
    teamPlan,
    runtimeAgents,
    legacyContextPacks: contextPacks,
  });

  assert.equal(result.context_runtime_mode, 'scoped_context');
  assert.equal(result.scope_specs.length, 2);
  assert.equal(result.materialized_scopes.length, 0);
  assert.ok(Array.isArray(result.scope_grants));
  assert.equal(result.visibility_graph.length, 1);
  assert.equal(result.scope_specs[0].visibility_mode, 'scoped');
  assert.equal(result.scope_specs[0].memory_grants.shared_summary, false);
  assert.equal(result.scope_specs[1].memory_grants.upstream_results, true);
});

test('runtime metadata snapshot preserves scope-first fields', () => {
  const snapshot = createRuntimeTeamSnapshot({
    teamPlan: {
      slots: [{ slot_id: 'slot_research', role_id: 'researcher' }],
      scope_specs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
      materialized_scopes: [{ scope_id: 'scope_research', context_set_id: 'ctx_research', token_estimate: 1200 }],
      visibility_graph: [{ from_scope_id: 'scope_research', to_scope_id: 'scope_review', relation: 'upstream_summary_only' }],
      context_runtime_mode: 'scoped_context',
    },
    runtimeAgents: [{ instance_id: 'rt_research', slot_id: 'slot_research', role_id: 'researcher' }],
    scopeSpecs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
    materializedScopes: [{ scope_id: 'scope_research', context_set_id: 'ctx_research', token_estimate: 1200 }],
    visibilityGraph: [{ from_scope_id: 'scope_research', to_scope_id: 'scope_review', relation: 'upstream_summary_only' }],
    contextRuntimeMode: 'scoped_context',
    source: 'test',
  });

  assert.equal(snapshot?.context_runtime_mode, 'scoped_context');
  assert.equal(snapshot?.scope_specs?.length, 1);
  assert.equal(snapshot?.materialized_scopes?.length, 1);
  assert.equal(snapshot?.visibility_graph?.length, 1);
  assert.ok(Array.isArray(snapshot?.scope_grants));
});


test('context runtime helpers downgrade legacy context packs in scoped mode', () => {
  const inferredMode = inferContextRuntimeMode({
    teamPlan: {
      slots: [
        { slot_id: 'slot_research', role_id: 'researcher' },
        { slot_id: 'slot_review', role_id: 'reviewer' },
      ],
    },
    runtimeAgents: [
      { role_id: 'researcher' },
      { role_id: 'reviewer' },
    ],
    collaborationCells: [{ cell_id: 'cell_review', pattern: 'handoff' }],
  });

  assert.equal(inferredMode, 'scoped_context');

  const legacyState = summarizeLegacyContextState({
    contextRuntimeMode: inferredMode,
    contextPacks: [{ context_pack_id: 'cp_research' }],
    scopeSpecs: [{ scope_id: 'scope_research' }],
    materializedScopes: [{ scope_id: 'scope_research' }],
  });

  assert.equal(legacyState.legacy_context_pack_count, 1);
  assert.equal(legacyState.legacy_context_packs_enabled, false);
  assert.equal(legacyState.legacy_context_strategy, 'fallback_only');
});


test('hydrateRuntimeScopesViaGoC replaces compatibility materialized scopes with GoC-compiled scopes', async () => {
  const client = {
    async materializeRuntimeScopes(threadId, snapshot) {
      assert.equal(threadId, 'thread_scope_test');
      assert.equal(snapshot.scope_specs.length, 1);
      return [{
        scope_id: 'scope_research',
        context_set_id: 'virtual_scope::scope_research',
        compiled_text: 'filing-backed evidence only',
        active_node_ids: ['node_1', 'node_2'],
        token_estimate: 321,
        lineage: { compiler: 'goc_scope_materializer' },
      }];
    },
  };

  const snapshot = await hydrateRuntimeScopesViaGoC({
    client,
    threadId: 'thread_scope_test',
    runtimeSnapshot: {
      context_runtime_mode: 'scoped_context',
      scope_specs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
      materialized_scopes: [{ scope_id: 'scope_research', compiled_text: 'legacy compatibility text' }],
    },
  });

  const binding = resolveScopeBinding({
    runtimeSnapshot: snapshot,
    slotId: 'slot_research',
    scopeId: 'scope_research',
  });
  const prepared = buildScopedPromptAssembly({
    goal: 'collect evidence',
    runtime: {},
    scopeBinding: binding,
  });

  assert.equal(snapshot.scope_materializer, 'goc_backend');
  assert.equal(binding.materialized_scope.context_set_id, 'virtual_scope::scope_research');
  assert.match(prepared.final_prompt, /filing-backed evidence only/);
  assert.equal(prepared.context_info.scope_lineage.compiler, 'goc_scope_materializer');
});


test('scoped execution state fails closed when scope is missing', () => {
  const state = resolveScopeExecutionState({
    runtimeSnapshot: {
      context_runtime_mode: 'scoped_context',
      scope_specs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
      materialized_scopes: [],
    },
    action: {
      agent: 'researcher',
      inputs: { slot_id: 'slot_research', scope_id: 'scope_research' },
    },
    slotId: 'slot_research',
    scopeId: 'scope_research',
  });

  assert.equal(state.blocked, true);
  assert.match(state.reason, /not materialized/i);
});

test('scoped prompt assembly does not inject ungranted shared memory', () => {
  const prepared = buildScopedPromptAssembly({
    goal: 'review findings',
    runtime: {
      contextSummary: 'shared summary should stay hidden',
      globalSummary: 'global memory should stay hidden',
      upstreamSummary: 'upstream summary should stay hidden',
      conversationTail: 'conversation tail allowed by default',
    },
    scopeBinding: {
      visibility_mode: 'scoped',
      scope_spec: { scope_id: 'scope_review', selection_reason: 'review only' },
      materialized_scope: { scope_id: 'scope_review', compiled_text: 'review scope only' },
      memory_grants: { shared_summary: false, global_memory: false, upstream_results: false, conversation_tail: true },
    },
  });

  assert.match(prepared.final_prompt, /review scope only/);
  assert.doesNotMatch(prepared.final_prompt, /shared summary should stay hidden/);
  assert.doesNotMatch(prepared.final_prompt, /global memory should stay hidden/);
  assert.doesNotMatch(prepared.final_prompt, /upstream summary should stay hidden/);
  assert.match(prepared.final_prompt, /conversation tail allowed by default/);
});


test('scoped execution fails closed when binding is ambiguous across same-role agents', () => {
  const state = resolveScopeExecutionState({
    runtimeSnapshot: {
      context_runtime_mode: 'scoped_context',
      runtime_agents: [
        { instance_id: 'rt_research_1', slot_id: 'slot_research_1', role_id: 'researcher' },
        { instance_id: 'rt_research_2', slot_id: 'slot_research_2', role_id: 'researcher' },
      ],
      scope_specs: [
        { scope_id: 'scope_research_1', target_instance_id: 'rt_research_1', role_id: 'researcher', visibility_mode: 'scoped' },
        { scope_id: 'scope_research_2', target_instance_id: 'rt_research_2', role_id: 'researcher', visibility_mode: 'scoped' },
      ],
      materialized_scopes: [
        { scope_id: 'scope_research_1', lineage: { compiler: 'goc_scope_materializer' }, compiled_text: 'scope 1' },
        { scope_id: 'scope_research_2', lineage: { compiler: 'goc_scope_materializer' }, compiled_text: 'scope 2' },
      ],
    },
    action: {
      agent: 'researcher',
      inputs: {},
    },
    agentId: 'researcher',
  });

  assert.equal(state.blocked, true);
  assert.match(state.reason, /ambiguous scope binding/i);
});

test('scoped execution requires authoritative GoC-compiled scope', () => {
  const state = resolveScopeExecutionState({
    runtimeSnapshot: {
      context_runtime_mode: 'scoped_context',
      scope_specs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
      materialized_scopes: [{ scope_id: 'scope_research', compiled_text: 'compat text only' }],
    },
    action: {
      agent: 'researcher',
      inputs: { slot_id: 'slot_research', scope_id: 'scope_research' },
    },
    slotId: 'slot_research',
    scopeId: 'scope_research',
  });

  assert.equal(state.blocked, true);
  assert.match(state.reason, /compiled by goc/i);
});

test('scoped execution blocks empty materialized scope even when compiler is authoritative', () => {
  const state = resolveScopeExecutionState({
    runtimeSnapshot: {
      context_runtime_mode: 'scoped_context',
      scope_specs: [{ scope_id: 'scope_research', target_slot_id: 'slot_research', visibility_mode: 'scoped' }],
      materialized_scopes: [{ scope_id: 'scope_research', lineage: { compiler: 'goc_scope_materializer', empty_scope: true } }],
    },
    action: {
      agent: 'researcher',
      inputs: { slot_id: 'slot_research', scope_id: 'scope_research' },
    },
    slotId: 'slot_research',
    scopeId: 'scope_research',
  });

  assert.equal(state.blocked, true);
  assert.match(state.reason, /empty visibility set/i);
});
