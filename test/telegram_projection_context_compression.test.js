import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRoleScopedGraphCompression,
  formatRoleScopedGraphCompressionContext,
  loadRoleScopedGraphCompressionContext,
  extractHarnessSpecDelivery,
  invalidateRoleScopedContextCache,
  loadRoleScopedContextDocs,
} from '../src/application/telegram_projection_context_io.js';

test('extractRoleScopedGraphCompression maps planner requests onto operator role views', () => {
  const result = extractRoleScopedGraphCompression({
    graph_native_compression: {
      role_views: [
        { role_id: 'operator', rendered_context: 'Shared operating picture.' },
        { role_id: 'builder', rendered_context: 'Build context.' },
      ],
    },
  }, { roleId: 'planner' });

  assert.equal(result.normalizedRoleId, 'operator');
  assert.equal(result.roleView?.role_id, 'operator');
});

test('formatRoleScopedGraphCompressionContext preserves rendered context and re-expand handles', () => {
  const formatted = formatRoleScopedGraphCompressionContext({
    graph_native_compression: {
      summary: {
        unresolved_conflict_count: 2,
        omitted_cluster_count: 1,
      },
      role_views: [
        {
          role_id: 'builder',
          display_label: 'Builder',
          visible_cluster_ids: ['cluster-1', 'cluster-2'],
          blocked_cluster_ids: ['cluster-3'],
          core_claim_node_ids: ['claim-1'],
          support_frontier_node_ids: ['node-1', 'node-2'],
          conflict_frontier_ids: ['conflict-1'],
          decision_path_event_ids: ['event-1'],
          rendered_context: 'Implement the patch using the accepted claim and preserve the migration invariant.',
          reexpand_handles: {
            cluster_ids: ['cluster-1', 'cluster-2'],
            memory_node_ids: ['node-1', 'node-2'],
          },
        },
      ],
    },
  }, { roleId: 'builder', maxChars: 2000 });

  assert.equal(formatted.visibleClusterCount, 2);
  assert.equal(formatted.supportFrontierCount, 2);
  assert.equal(formatted.unresolvedConflictCount, 2);
  assert.match(formatted.text, /GOC GRAPH-NATIVE COMPRESSION/);
  assert.match(formatted.text, /rendered context/i);
  assert.match(formatted.text, /migration invariant/);
  assert.match(formatted.text, /re-expand handles/i);
});

test('extractHarnessSpecDelivery resolves role delivery policy from harness summary', () => {
  const delivery = extractHarnessSpecDelivery({
    harness_summary: {
      delivery_policy: {
        default_delivery_mode: 'compression_plus_appendix',
        appendix_char_budget_ratio: 0.2,
        default_budget_tier: 'medium',
        default_risk_level: 'standard',
        projection_appendix_enabled_by_default: true,
      },
      resolved_role_delivery: {
        planner: {
          requested_role_id: 'planner',
          effective_role_id: 'operator',
          delivery_mode: 'compression_plus_appendix',
          appendix_enabled: true,
          appendix_char_budget_ratio: 0.2,
          budget_tier: 'medium',
          risk_level: 'standard',
        },
      },
      spec_hash: 'spec-123',
      name: 'Research Harness',
    },
  }, { roleId: 'planner' })

  assert.equal(delivery.effectiveRoleId, 'operator')
  assert.equal(delivery.deliveryMode, 'compression_plus_appendix')
  assert.equal(delivery.appendixEnabled, true)
  assert.equal(delivery.specHash, 'spec-123')
  assert.equal(delivery.resolvedFromSummary, true)
})

test('loadRoleScopedGraphCompressionContext uses run bundle API when available', async () => {
  const calls = [];
  const formatted = await loadRoleScopedGraphCompressionContext({
    client: {
      async getRunStudioRunBundle(threadId, query) {
        calls.push({ threadId, query });
        return {
          harness_summary: {
            delivery_policy: {
              default_delivery_mode: 'compression_plus_appendix',
              appendix_char_budget_ratio: 0.25,
              default_budget_tier: 'medium',
              default_risk_level: 'standard',
              projection_appendix_enabled_by_default: true,
            },
            resolved_role_delivery: {
              operator: {
                requested_role_id: 'operator',
                effective_role_id: 'operator',
                delivery_mode: 'compression_plus_appendix',
                appendix_enabled: true,
                appendix_char_budget_ratio: 0.25,
                budget_tier: 'medium',
                risk_level: 'standard',
              },
            },
            spec_hash: 'spec-abc',
            name: 'Operator Harness',
          },
          graph_native_compression: {
            summary: { unresolved_conflict_count: 0 },
            role_views: [
              {
                role_id: 'operator',
                visible_cluster_ids: ['cluster-a'],
                blocked_cluster_ids: [],
                core_claim_node_ids: ['claim-a'],
                support_frontier_node_ids: ['node-a'],
                conflict_frontier_ids: [],
                decision_path_event_ids: ['event-a'],
                rendered_context: 'Coordinate the next operator action from the compressed graph view.',
                reexpand_handles: { cluster_ids: ['cluster-a'], memory_node_ids: ['node-a'] },
              },
            ],
          },
        };
      },
    },
    threadId: 'thread-1',
    contextSetId: 'ctx-shared',
    runId: 'run-7',
    roleId: 'planner',
    maxCharsPerDoc: 2400,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, 'thread-1');
  assert.deepEqual(calls[0].query, { contextSetId: 'ctx-shared', runId: 'run-7' });
  assert.equal(formatted.roleId, 'operator');
  assert.match(formatted.text, /compressed graph view/);
  assert.equal(formatted.deliveryMode, 'compression_plus_appendix');
  assert.equal(formatted.appendixEnabled, true);
  assert.equal(formatted.specHash, 'spec-abc');
});


test('loadRoleScopedGraphCompressionContext reuses hot cache for identical requests', async () => {
  invalidateRoleScopedContextCache();
  let calls = 0;
  const client = {
    async getRunStudioRunBundle() {
      calls += 1;
      return {
        graph_version: 'gv-1',
        graph_native_compression: {
          role_views: [{
            role_id: 'builder',
            visible_cluster_ids: ['cluster-a'],
            blocked_cluster_ids: [],
            core_claim_node_ids: ['claim-a'],
            support_frontier_node_ids: ['node-a'],
            conflict_frontier_ids: [],
            decision_path_event_ids: ['event-a'],
            rendered_context: 'Use the cached compressed context.',
          }],
        },
      };
    },
  };

  const first = await loadRoleScopedGraphCompressionContext({ client, threadId: 'thread-2', roleId: 'builder' });
  const second = await loadRoleScopedGraphCompressionContext({ client, threadId: 'thread-2', roleId: 'builder' });

  assert.equal(calls, 1);
  assert.equal(first.graphVersion, 'gv-1');
  assert.equal(second.graphVersion, 'gv-1');
  assert.match(second.text, /cached compressed context/);
});


test('loadRoleScopedGraphCompressionContext falls back to local runtime policy delivery when bundle fetch is unavailable', async () => {
  const formatted = await loadRoleScopedGraphCompressionContext({
    client: null,
    threadId: '',
    roleId: 'planner',
    runtimePolicy: {
      schema_version: 'openharness.runtime_policy/v1',
      delivery_policy: { default_delivery_mode: 'projection_only', appendix_char_budget_ratio: 0.15, default_budget_tier: 'low', default_risk_level: 'standard', projection_appendix_enabled_by_default: true },
      resolved_role_delivery: { planner: { effective_role_id: 'operator', delivery_mode: 'projection_only', appendix_enabled: true, appendix_char_budget_ratio: 0.15, budget_tier: 'low', risk_level: 'standard' } },
    },
  });

  assert.equal(formatted.roleId, 'operator');
  assert.equal(formatted.deliveryMode, 'projection_only');
  assert.equal(formatted.appendixEnabled, true);
  assert.equal(formatted.appendixCharBudgetRatio, 0.15);
});


test('formatRoleScopedGraphCompressionContext suppresses conflict and cross-reference details when audit policy disables them', () => {
  const formatted = formatRoleScopedGraphCompressionContext({
    graph_native_compression: {
      summary: {
        unresolved_conflict_count: 3,
        omitted_cluster_count: 1,
      },
      role_views: [
        {
          role_id: 'builder',
          display_label: 'Builder',
          visible_cluster_ids: ['cluster-1'],
          blocked_cluster_ids: [],
          core_claim_node_ids: ['claim-1'],
          support_frontier_node_ids: ['node-1'],
          conflict_frontier_ids: ['conflict-1'],
          decision_path_event_ids: ['event-1'],
          rendered_context: 'Implement carefully.',
          reexpand_handles: {
            cluster_ids: ['cluster-1'],
            memory_node_ids: ['node-1'],
          },
        },
      ],
    },
  }, {
    roleId: 'builder',
    runtimePolicy: { audit_flags: { show_conflict_history: false, cross_reference_enabled: false } },
  });

  assert.equal(formatted.unresolvedConflictCount, 0);
  assert.doesNotMatch(formatted.text, /unresolved conflicts/i);
  assert.doesNotMatch(formatted.text, /re-expand handles/i);
});

test('loadRoleScopedContextDocs can disable tool-backed retrieval from harness policy', async () => {
  const text = await loadRoleScopedContextDocs('job_policy', {
    provider: 'codex',
    roleId: 'builder',
    runtimePolicy: {
      tool_policy: {
        tool_rag_enabled: false,
        tool_view_mode: 'task_scoped',
      },
    },
  });

  assert.match(text, /tool-backed retrieval disabled by harness policy/i);
  assert.match(text, /effective projection role/i);
});
