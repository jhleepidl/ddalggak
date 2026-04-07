import test from 'node:test';
import assert from 'node:assert/strict';

import { GocClient } from '../src/goc_client.js';
import { buildRunBundleSmokeReport, runGocRunBundleSmoke } from '../src/application/goc_run_bundle_smoke.js';

test('goc client getRunStudioRunBundle prefers canonical run-studio bundle route', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc' });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return { ok: true };
  };

  await client.getRunStudioRunBundle('thread_1', { contextSetId: 'ctx_1', runId: 'run_1' });
  assert.equal(captured?.method, 'GET');
  assert.equal(captured?.attempts?.[0]?.path, '/api/threads/thread_1/run_studio/run_bundle');
  assert.equal(captured?.attempts?.[0]?.query?.context_set_id, 'ctx_1');
  assert.equal(captured?.attempts?.[0]?.query?.run_id, 'run_1');
});

test('runGocRunBundleSmoke assembles summary and bundle into a stable smoke report', async () => {
  const calls = [];
  const client = {
    async getRunStudioSummary(threadId, options = {}) {
      calls.push({ kind: 'summary', threadId, options });
      return { current_run_skills: { run_id: 'run_1' } };
    },
    async getRunStudioRunBundle(threadId, options = {}) {
      calls.push({ kind: 'bundle', threadId, options });
      return {
        run_id: 'run_1',
        scope: 'run',
        evidence: { run_id: 'run_1', items: [{ claim_node_id: 'claim_1' }] },
        context_packs: { run_id: 'run_1', items: [{ context_pack_id: 'ctxp_1' }] },
        skill_usage: { run_id: 'run_1', items: [{ skill_id: 'skill.alpha' }] },
        memory_graph: { run_id: 'run_1', projection_count: 1, conflict_count: 0 },
        trace_scope: { run_id: 'run_1', anchor_node_id: 'run_1', node_count: 4, edge_count: 3 },
        cross_references: { run_id: 'run_1', claim_links: [{ claim_node_id: 'claim_1' }], conflict_links: [], counts: { conflicts_with_resolution_rationale: 0, conflicts_with_suggested_resolution: 1, conflicts_with_history: 1, conflict_history_events: 2 } },
      };
    },
  };

  const report = await runGocRunBundleSmoke({ client, threadId: 'thread_1', contextSetId: 'ctx_1', runId: 'run_1' });
  assert.equal(report.ok, true);
  assert.equal(report.effective_run_id, 'run_1');
  assert.equal(report.counts.evidence_items, 1);
  assert.equal(report.counts.memory_projections, 1);
  assert.equal(report.counts.cross_reference_claim_links, 1);
  assert.equal(report.counts.cross_reference_conflicts_with_suggested_resolution, 1);
  assert.equal(report.counts.cross_reference_conflicts_with_history, 1);
  assert.equal(report.counts.cross_reference_conflict_history_events, 2);
  assert.deepEqual(calls, [
    { kind: 'summary', threadId: 'thread_1', options: { contextSetId: 'ctx_1' } },
    { kind: 'bundle', threadId: 'thread_1', options: { contextSetId: 'ctx_1', runId: 'run_1' } },
  ]);
});

test('buildRunBundleSmokeReport flags inconsistent run ids across the bundle', () => {
  const report = buildRunBundleSmokeReport({
    threadId: 'thread_1',
    requestedRunId: 'run_expected',
    summary: { current_run_skills: { run_id: 'run_expected' } },
    bundle: {
      run_id: 'run_other',
      scope: 'run',
      evidence: { run_id: 'run_other', items: [] },
      context_packs: { items: [] },
      skill_usage: { items: [] },
      memory_graph: { run_id: 'run_other', projection_count: 0, conflict_count: 0 },
      trace_scope: { run_id: 'run_other', anchor_node_id: 'anchor_1', node_count: 1, edge_count: 0 },
      cross_references: { run_id: 'run_other', claim_links: [], conflict_links: [] },
    },
  });

  assert.equal(report.ok, false);
  const failed = report.checks.filter((row) => row.ok === false).map((row) => row.key);
  assert(failed.includes('bundle_run_id_matches'));
  assert(failed.includes('trace_scope_run_id_matches'));
});
