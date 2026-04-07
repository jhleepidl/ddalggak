function cleanText(value) {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

export function buildRunBundleSmokeReport({ threadId = '', requestedRunId = '', summary = null, bundle = null } = {}) {
  const cleanThreadId = cleanText(threadId);
  const cleanRequestedRunId = cleanText(requestedRunId);
  const summaryObj = asObject(summary);
  const bundleObj = asObject(bundle);
  const summaryRunId = cleanText(summaryObj?.current_run_skills?.run_id);
  const bundleRunId = cleanText(bundleObj.run_id);
  const traceScope = asObject(bundleObj.trace_scope);
  const evidence = asObject(bundleObj.evidence);
  const contextPacks = asObject(bundleObj.context_packs);
  const skillUsage = asObject(bundleObj.skill_usage);
  const memoryGraph = asObject(bundleObj.memory_graph);
  const crossReferences = asObject(bundleObj.cross_references);

  const effectiveRunId = cleanRequestedRunId || bundleRunId || summaryRunId;
  const checks = [
    {
      key: 'thread_id_present',
      ok: Boolean(cleanThreadId),
      detail: cleanThreadId || 'missing threadId',
    },
    {
      key: 'bundle_scope',
      ok: !effectiveRunId || cleanText(bundleObj.scope) === 'run',
      detail: cleanText(bundleObj.scope) || 'thread',
    },
    {
      key: 'bundle_run_id_matches',
      ok: !effectiveRunId || bundleRunId === effectiveRunId,
      detail: bundleRunId || '(empty)',
    },
    {
      key: 'trace_scope_run_id_matches',
      ok: !effectiveRunId || cleanText(traceScope.run_id) === effectiveRunId,
      detail: cleanText(traceScope.run_id) || '(empty)',
    },
    {
      key: 'evidence_run_id_matches',
      ok: !effectiveRunId || cleanText(evidence.run_id) === effectiveRunId,
      detail: cleanText(evidence.run_id) || '(empty)',
    },
    {
      key: 'memory_graph_run_id_matches',
      ok: !effectiveRunId || cleanText(memoryGraph.run_id) === effectiveRunId,
      detail: cleanText(memoryGraph.run_id) || '(empty)',
    },
    {
      key: 'trace_scope_has_anchor',
      ok: !effectiveRunId || Boolean(cleanText(traceScope.anchor_node_id) || cleanText(traceScope.run_node_id)),
      detail: cleanText(traceScope.anchor_node_id || traceScope.run_node_id) || '(empty)',
    },
    {
      key: 'bundle_contains_detail_sections',
      ok: ['evidence', 'context_packs', 'skill_usage', 'memory_graph', 'trace_scope'].every((key) => bundleObj[key] && typeof bundleObj[key] === 'object'),
      detail: Object.keys(bundleObj).sort().join(', '),
    },
    {
      key: 'bundle_contains_cross_references',
      ok: !effectiveRunId || (bundleObj.cross_references && typeof bundleObj.cross_references === 'object'),
      detail: Object.keys(crossReferences).sort().join(', ') || '(missing)',
    },
  ];

  return {
    ok: checks.every((row) => row.ok),
    thread_id: cleanThreadId,
    requested_run_id: cleanRequestedRunId || null,
    summary_run_id: summaryRunId || null,
    bundle_run_id: bundleRunId || null,
    effective_run_id: effectiveRunId || null,
    checks,
    counts: {
      evidence_items: Array.isArray(evidence.items) ? evidence.items.length : 0,
      context_packs: Array.isArray(contextPacks.items) ? contextPacks.items.length : 0,
      skill_usage_items: Array.isArray(skillUsage.items) ? skillUsage.items.length : 0,
      memory_projections: Number(memoryGraph.projection_count || 0),
      memory_conflicts: Number(memoryGraph.conflict_count || 0),
      trace_nodes: Number(traceScope.node_count || 0),
      trace_edges: Number(traceScope.edge_count || 0),
      cross_reference_claim_links: Array.isArray(crossReferences.claim_links) ? crossReferences.claim_links.length : 0,
      cross_reference_conflict_links: Array.isArray(crossReferences.conflict_links) ? crossReferences.conflict_links.length : 0,
      cross_reference_conflicts_with_rationale: Number(crossReferences?.counts?.conflicts_with_resolution_rationale || 0),
      cross_reference_conflicts_with_suggested_resolution: Number(crossReferences?.counts?.conflicts_with_suggested_resolution || 0),
      cross_reference_conflicts_with_history: Number(crossReferences?.counts?.conflicts_with_history || 0),
      cross_reference_conflict_history_events: Number(crossReferences?.counts?.conflict_history_events || 0),
    },
  };
}

export async function runGocRunBundleSmoke({ client, threadId = '', contextSetId = '', runId = '' } = {}) {
  if (!client || typeof client.getRunStudioSummary !== 'function' || typeof client.getRunStudioRunBundle !== 'function') {
    throw new Error('runGocRunBundleSmoke requires a client with getRunStudioSummary/getRunStudioRunBundle');
  }
  const cleanThreadId = cleanText(threadId);
  if (!cleanThreadId) throw new Error('runGocRunBundleSmoke requires threadId');
  const cleanContextSetId = cleanText(contextSetId);
  const cleanRunId = cleanText(runId);
  const [summary, bundle] = await Promise.all([
    client.getRunStudioSummary(cleanThreadId, { contextSetId: cleanContextSetId }),
    client.getRunStudioRunBundle(cleanThreadId, { contextSetId: cleanContextSetId, runId: cleanRunId }),
  ]);
  return buildRunBundleSmokeReport({
    threadId: cleanThreadId,
    requestedRunId: cleanRunId,
    summary,
    bundle,
  });
}
