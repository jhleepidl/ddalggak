import { clip } from '../textutil.js';
import { ensureJobThread } from '../goc_mapping.js';
import { summarizeRoleMemoryEnforcement, buildRoleMemoryContract } from '../knowledge_base/runtime.js';
import { ensureKnowledgeBaseMemorySurfacesInGoc } from './goc_memory_sync.js';
import * as runtimeState from './telegram_runtime_state.js';
import { TimedArtifactCache, buildContextArtifactCacheKey } from './context_cache.js';

const {
  jobs,
  tracking,
  gocFallbackByJob,
  runDir,
  loadLocalContextDocs,
  memoryModeWithFallback,
  requireGocClient,
} = runtimeState;



const ROLE_SCOPED_CONTEXT_CACHE_TTL_MS = Number.isFinite(Number(process.env.ROLE_SCOPED_CONTEXT_CACHE_TTL_MS))
  ? Math.max(1000, Math.floor(Number(process.env.ROLE_SCOPED_CONTEXT_CACHE_TTL_MS)))
  : 20_000;
const ROLE_SCOPED_CONTEXT_CACHE_MAX_ENTRIES = Number.isFinite(Number(process.env.ROLE_SCOPED_CONTEXT_CACHE_MAX_ENTRIES))
  ? Math.max(32, Math.floor(Number(process.env.ROLE_SCOPED_CONTEXT_CACHE_MAX_ENTRIES)))
  : 256;
const roleScopedGraphCompressionCache = new TimedArtifactCache({
  ttlMs: ROLE_SCOPED_CONTEXT_CACHE_TTL_MS,
  maxEntries: ROLE_SCOPED_CONTEXT_CACHE_MAX_ENTRIES,
});
const roleScopedProjectionCache = new TimedArtifactCache({
  ttlMs: ROLE_SCOPED_CONTEXT_CACHE_TTL_MS,
  maxEntries: ROLE_SCOPED_CONTEXT_CACHE_MAX_ENTRIES,
});

const DEFAULT_HARNESS_DELIVERY_MODE = 'compression_plus_appendix';
const DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO = 0.35;
const DEFAULT_HARNESS_BUDGET_TIER = 'medium';
const DEFAULT_HARNESS_RISK_LEVEL = 'standard';

function invalidateRoleScopedContextCache({ threadId = '', jobId = '' } = {}) {
  const cleanThreadId = cleanText(threadId);
  const cleanJobId = cleanText(jobId);
  if (!cleanThreadId && !cleanJobId) {
    roleScopedGraphCompressionCache.invalidate();
    roleScopedProjectionCache.invalidate();
    return;
  }
  if (cleanThreadId) {
    roleScopedGraphCompressionCache.invalidate(`"threadId":"${cleanThreadId}"`);
    roleScopedProjectionCache.invalidate(`"threadId":"${cleanThreadId}"`);
  }
  if (cleanJobId) {
    roleScopedProjectionCache.invalidate(`"jobId":"${cleanJobId}"`);
  }
}

function uniqueLowerList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function cleanText(value = '') {
  return String(value || '').trim();
}

function cleanIdList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const clean = cleanText(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function safeLoadTrackingProfile(jobId = '') {
  try {
    return tracking.loadProfile(jobId);
  } catch {
    return null;
  }
}

function normalizeProjectionRoleId(roleId = '') {
  const cleanRoleId = String(roleId || '').trim().toLowerCase();
  if (!cleanRoleId) return '';
  if (['planner', 'router', 'system', 'orchestrator', 'supervisor'].includes(cleanRoleId)) return 'operator';
  return cleanRoleId;
}

function buildRoleScopedDocNames({ contract = null, fallbackDocIds = [] } = {}) {
  const seen = new Set();
  const out = [];
  const orderedDocs = [
    ...(Array.isArray(contract?.primary_docs) ? contract.primary_docs : []),
    ...(Array.isArray(contract?.read_docs) ? contract.read_docs : []),
  ];
  for (const doc of orderedDocs) {
    const candidates = [doc?.file_name, doc?.doc_id, doc?.surface_id, doc?.surfaceId]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      break;
    }
  }
  for (const fallback of Array.isArray(fallbackDocIds) ? fallbackDocIds : []) {
    const clean = String(fallback || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function formatRoleScopedProjectionContext(projectionResult = {}, { maxChars = 9000 } = {}) {
  const projection = projectionResult && typeof projectionResult === 'object'
    ? (projectionResult.projection && typeof projectionResult.projection === 'object' ? projectionResult.projection : projectionResult)
    : {};
  const visibleNodes = Array.isArray(projection.visible_nodes) ? projection.visible_nodes : [];
  const blockedNodes = Array.isArray(projection.blocked_nodes) ? projection.blocked_nodes : [];
  const visibleSurfaceIds = uniqueLowerList(projection.visible_surface_ids);
  const blockedSurfaceIds = uniqueLowerList(projection.blocked_surface_ids);
  const lines = ['### GOC ROLE-SCOPED MEMORY PROJECTION', ''];
  if (visibleSurfaceIds.length > 0) lines.push(`- visible surfaces: ${visibleSurfaceIds.join(', ')}`);
  if (blockedSurfaceIds.length > 0) lines.push(`- blocked surfaces: ${blockedSurfaceIds.join(', ')}`);
  if (visibleNodes.length > 0) {
    lines.push('', '#### visible nodes');
    for (const node of visibleNodes.slice(0, 12)) {
      lines.push(`- [${String(node?.surface_id || '').trim() || 'surface'}] ${clip(String(node?.content_preview || node?.content || '').trim(), 220)}`);
    }
  }
  if (blockedNodes.length > 0) {
    lines.push('', '#### blocked nodes');
    for (const node of blockedNodes.slice(0, 8)) {
      lines.push(`- [${String(node?.surface_id || '').trim() || 'surface'}] blocked=${String(node?.blocked_reason || node?.visibility_reason || 'policy').trim() || 'policy'}`);
    }
  }
  const text = cleanText(lines.join('\n'));
  return {
    text: text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 16))}\n…(truncated)…` : text,
    visibleNodeCount: visibleNodes.length,
    blockedNodeCount: blockedNodes.length,
    visibleSurfaceIds,
    blockedSurfaceIds,
  };
}

function extractRoleScopedGraphCompression(graphCompression = {}, { roleId = '' } = {}) {
  const compression = graphCompression && typeof graphCompression === 'object'
    ? (graphCompression.graph_native_compression && typeof graphCompression.graph_native_compression === 'object'
      ? graphCompression.graph_native_compression
      : graphCompression)
    : {};
  const roleViews = Array.isArray(compression.role_views) ? compression.role_views : [];
  const normalizedRoleId = normalizeProjectionRoleId(roleId);
  const exact = roleViews.find((row) => normalizeProjectionRoleId(row?.role_id) === normalizedRoleId);
  const requestedRoleId = cleanText(roleId).toLowerCase();
  const fallback = requestedRoleId && requestedRoleId !== normalizedRoleId
    ? roleViews.find((row) => normalizeProjectionRoleId(row?.role_id) === requestedRoleId)
    : null;
  return {
    compression,
    roleView: exact || fallback || roleViews[0] || null,
    normalizedRoleId,
  };
}

function formatRoleScopedGraphCompressionContext(graphCompression = {}, { roleId = '', maxChars = 7000 } = {}) {
  const { compression, roleView, normalizedRoleId } = extractRoleScopedGraphCompression(graphCompression, { roleId });
  if (!roleView || !cleanText(roleView?.rendered_context)) {
    return {
      text: '',
      roleId: normalizedRoleId || cleanText(roleView?.role_id).toLowerCase() || '',
      visibleClusterCount: 0,
      blockedClusterCount: 0,
      coreClaimCount: 0,
      supportFrontierCount: 0,
      unresolvedConflictCount: 0,
    };
  }
  const summary = compression && typeof compression.summary === 'object' ? compression.summary : {};
  const visibleClusterIds = cleanIdList(roleView.visible_cluster_ids);
  const blockedClusterIds = cleanIdList(roleView.blocked_cluster_ids);
  const coreClaimNodeIds = cleanIdList(roleView.core_claim_node_ids);
  const supportFrontierNodeIds = cleanIdList(roleView.support_frontier_node_ids);
  const conflictFrontierIds = cleanIdList(roleView.conflict_frontier_ids);
  const decisionPathEventIds = cleanIdList(roleView.decision_path_event_ids);
  const unresolvedConflictCount = countCollection(summary.unresolved_conflict_count ?? summary.conflict_frontier_count);
  const omittedClusterCount = countCollection(summary.omitted_cluster_count);
  const lines = [
    '### GOC GRAPH-NATIVE COMPRESSION',
    '',
    `- role view: ${cleanText(roleView.display_label || roleView.role_id) || '(unspecified)'}`,
    `- visible clusters: ${visibleClusterIds.length}`,
    `- blocked clusters: ${blockedClusterIds.length}`,
    `- core claims: ${coreClaimNodeIds.length}`,
    `- support frontier nodes: ${supportFrontierNodeIds.length}`,
    `- conflict frontier: ${conflictFrontierIds.length}`,
    `- decision path events: ${decisionPathEventIds.length}`,
  ];
  if (unresolvedConflictCount > 0) lines.push(`- unresolved conflicts (global): ${unresolvedConflictCount}`);
  if (omittedClusterCount > 0) lines.push(`- omitted clusters outside this role view: ${omittedClusterCount}`);
  lines.push('', '#### rendered context', clip(cleanText(roleView.rendered_context), Math.max(1200, maxChars - 420)));
  const handleNodeIds = cleanIdList(roleView?.reexpand_handles?.memory_node_ids);
  const handleClusterIds = cleanIdList(roleView?.reexpand_handles?.cluster_ids);
  if (handleNodeIds.length > 0 || handleClusterIds.length > 0) {
    lines.push('', '#### re-expand handles');
    if (handleClusterIds.length > 0) lines.push(`- cluster ids: ${clip(handleClusterIds.join(', '), 200)}`);
    if (handleNodeIds.length > 0) lines.push(`- memory node ids: ${clip(handleNodeIds.join(', '), 200)}`);
  }
  const text = cleanText(lines.join('\n'));
  return {
    text: text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 16))}\n…(truncated)…` : text,
    roleId: normalizedRoleId || cleanText(roleView.role_id).toLowerCase() || '',
    visibleClusterCount: visibleClusterIds.length,
    blockedClusterCount: blockedClusterIds.length,
    coreClaimCount: coreClaimNodeIds.length,
    supportFrontierCount: supportFrontierNodeIds.length,
    unresolvedConflictCount,
  };
}

async function loadRoleScopedGraphCompressionContext({ client = null, threadId = '', contextSetId = '', runId = '', roleId = '', maxCharsPerDoc = 3500 } = {}) {
  const cleanThreadId = cleanText(threadId);
  const normalizedRoleId = normalizeProjectionRoleId(roleId) || cleanText(roleId).toLowerCase() || '';
  if (!client || typeof client.getRunStudioRunBundle !== 'function' || !cleanThreadId) {
    return { text: '', roleId: normalizedRoleId, deliveryMode: DEFAULT_HARNESS_DELIVERY_MODE, appendixEnabled: true, appendixCharBudgetRatio: DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO };
  }
  const cacheKey = buildContextArtifactCacheKey('graph_compression_role_view', {
    threadId: cleanThreadId,
    contextSetId: cleanText(contextSetId),
    runId: cleanText(runId),
    roleId: normalizedRoleId,
    maxChars: Math.max(1600, Math.floor(maxCharsPerDoc * 1.8)),
  });
  const cached = roleScopedGraphCompressionCache.get(cacheKey);
  if (cached) return cached;
  try {
    const bundle = await client.getRunStudioRunBundle(cleanThreadId, {
      contextSetId: cleanText(contextSetId),
      runId: cleanText(runId),
    });
    const formatted = formatRoleScopedGraphCompressionContext(bundle, {
      roleId,
      maxChars: Math.max(1600, Math.floor(maxCharsPerDoc * 1.8)),
    });
    const delivery = extractHarnessSpecDelivery(bundle, { roleId });
    const graphVersion = cleanText(bundle?.graph_version || bundle?.context_cache?.graph_version);
    const value = { ...formatted, graphVersion, ...delivery };
    roleScopedGraphCompressionCache.set(cacheKey, value);
    return value;
  } catch (error) {
    return {
      text: '',
      roleId: normalizedRoleId,
      deliveryMode: DEFAULT_HARNESS_DELIVERY_MODE,
      appendixEnabled: true,
      appendixCharBudgetRatio: DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO,
      error: cleanText(error?.message || error),
    };
  }
}

function normalizeHarnessDeliveryMode(value = '', fallback = DEFAULT_HARNESS_DELIVERY_MODE) {
  const clean = cleanText(value).toLowerCase().replace(/[-\s]+/g, '_');
  return ['compression_only', 'compression_plus_appendix', 'projection_only', 'projection_preferred'].includes(clean)
    ? clean
    : fallback;
}

function extractHarnessSpecDelivery(bundle = {}, { roleId = '' } = {}) {
  const summary = bundle && typeof bundle === 'object' ? (bundle.harness_summary && typeof bundle.harness_summary === 'object' ? bundle.harness_summary : {}) : {};
  const requestedRoleId = cleanText(roleId).toLowerCase();
  const legacyEffectiveRoleId = normalizeProjectionRoleId(requestedRoleId);
  const resolvedRoleDelivery = summary && typeof summary.resolved_role_delivery === 'object' ? summary.resolved_role_delivery : {};
  const directResolved = resolvedRoleDelivery[requestedRoleId] || resolvedRoleDelivery[legacyEffectiveRoleId] || null;
  const deliveryPolicy = summary && typeof summary.delivery_policy === 'object' ? summary.delivery_policy : {};
  const effectiveRoleId = cleanText(directResolved?.effective_role_id).toLowerCase() || legacyEffectiveRoleId;
  const deliveryMode = normalizeHarnessDeliveryMode(
    directResolved?.delivery_mode || deliveryPolicy.default_delivery_mode,
    DEFAULT_HARNESS_DELIVERY_MODE,
  );
  const appendixEnabledByDefault = directResolved?.appendix_enabled != null
    ? directResolved.appendix_enabled !== false
    : (deliveryPolicy.projection_appendix_enabled_by_default !== false);
  const appendixEnabled = deliveryMode === 'compression_only' ? false : (deliveryMode === 'projection_only' ? true : appendixEnabledByDefault);
  const ratio = Number(
    directResolved?.appendix_char_budget_ratio
      ?? deliveryPolicy.appendix_char_budget_ratio
      ?? DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO
  );
  const appendixCharBudgetRatio = Number.isFinite(ratio)
    ? Math.max(0, Math.min(ratio, 1))
    : DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO;
  return {
    requestedRoleId,
    effectiveRoleId,
    deliveryMode,
    appendixEnabled,
    appendixCharBudgetRatio,
    budgetTier: cleanText(directResolved?.budget_tier || deliveryPolicy.default_budget_tier).toLowerCase() || DEFAULT_HARNESS_BUDGET_TIER,
    riskLevel: cleanText(directResolved?.risk_level || deliveryPolicy.default_risk_level).toLowerCase() || DEFAULT_HARNESS_RISK_LEVEL,
    specVersion: cleanText(summary.schema_version),
    specHash: cleanText(summary.spec_hash),
    harnessName: cleanText(summary.name),
    resolvedFromSummary: !!directResolved,
  };
}

function resolveRoleScopedReadAccess({ profile = null, provider = '', roleId = '', fallbackDocIds = ['plan', 'research'], maxReadDocs = 4 } = {}) {
  const requestedRoleId = String(roleId || '').trim().toLowerCase();
  const effectiveRoleId = normalizeProjectionRoleId(requestedRoleId);
  const effectiveProvider = String(provider || '').trim().toLowerCase();
  const contract = buildRoleMemoryContract({ profile, provider: effectiveProvider, roleId: effectiveRoleId, maxReadDocs });
  const enforcement = summarizeRoleMemoryEnforcement({ profile, provider: effectiveProvider, roleId: effectiveRoleId });
  const docNames = buildRoleScopedDocNames({ contract, fallbackDocIds });
  return {
    requestedRoleId,
    effectiveRoleId,
    effectiveProvider,
    contract,
    enforcement,
    docNames,
  };
}

async function loadRoleScopedGocProjectionContext(jobId, { provider = '', roleId = '', maxCharsPerDoc = 3500, docNames = [], enforcement = {} } = {}) {
  if (memoryModeWithFallback() !== 'goc') return { text: '', visibleNodeCount: 0, blockedNodeCount: 0, compressionText: '' };
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
    });
    await ensureKnowledgeBaseMemorySurfacesInGoc({ jobId, client, threadId: map.threadId });
    const includeSurfaceIds = Array.isArray(enforcement?.read_surface_ids) && enforcement.read_surface_ids.length > 0
      ? enforcement.read_surface_ids
      : docNames;
    const cacheKey = buildContextArtifactCacheKey('role_scoped_projection', {
      jobId: cleanText(jobId),
      threadId: cleanText(map.threadId),
      contextSetId: cleanText(map.ctxSharedId),
      provider: cleanText(provider).toLowerCase(),
      roleId: normalizeProjectionRoleId(roleId),
      includeSurfaceIds: cleanIdList(includeSurfaceIds),
      maxCharsPerDoc: Math.max(2200, Math.floor(maxCharsPerDoc * 2.4)),
    });
    const cached = roleScopedProjectionCache.get(cacheKey);
    if (cached) return cached;
    const projectionResult = await client.createMemoryProjection(map.threadId, {
      role_id: cleanText(roleId).toLowerCase() || undefined,
      agent_id: `system:${cleanText(roleId || 'operator').toLowerCase() || 'operator'}`,
      include_surface_ids: includeSurfaceIds,
    });
    const projection = formatRoleScopedProjectionContext(projectionResult, { maxChars: Math.max(2200, Math.floor(maxCharsPerDoc * 2.4)) });
    const compression = await loadRoleScopedGraphCompressionContext({
      client,
      threadId: map.threadId,
      contextSetId: map.ctxSharedId,
      roleId,
      maxCharsPerDoc,
    });
    gocFallbackByJob.delete(String(jobId));
    const value = {
      ...projection,
      graphVersion: cleanText(compression.graphVersion),
      compressionText: cleanText(compression.text),
      compressionRoleId: cleanText(compression.roleId).toLowerCase() || '',
      compressionVisibleClusterCount: Number(compression.visibleClusterCount || 0),
      compressionBlockedClusterCount: Number(compression.blockedClusterCount || 0),
      compressionSupportFrontierCount: Number(compression.supportFrontierCount || 0),
      compressionUnresolvedConflictCount: Number(compression.unresolvedConflictCount || 0),
      compressionDeliveryMode: cleanText(compression.deliveryMode).toLowerCase() || DEFAULT_HARNESS_DELIVERY_MODE,
      compressionAppendixEnabled: compression.appendixEnabled !== false,
      compressionAppendixCharBudgetRatio: Number(compression.appendixCharBudgetRatio || DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO) || DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO,
      harnessSpecVersion: cleanText(compression.specVersion),
      harnessSpecHash: cleanText(compression.specHash),
      harnessName: cleanText(compression.harnessName),
      compressionError: cleanText(compression.error),
    };
    roleScopedProjectionCache.set(cacheKey, value);
    return value;
  } catch (error) {
    const reason = String(error?.message || error);
    gocFallbackByJob.set(String(jobId), reason);
    jobs.log(jobId, `GoC role-scoped projection failed; fallback to local: ${reason}`);
    return { text: '', visibleNodeCount: 0, blockedNodeCount: 0, compressionText: '', error: reason };
  }
}

async function loadRoleScopedContextDocs(jobId, { provider = '', roleId = '', fallbackDocIds = ['plan', 'research'], maxCharsPerDoc = 3500, audienceLabel = 'orchestrator run' } = {}) {
  const profile = safeLoadTrackingProfile(jobId);
  const access = resolveRoleScopedReadAccess({
    profile,
    provider,
    roleId,
    fallbackDocIds,
    maxReadDocs: 4,
  });
  const localFallback = await loadContextDocs(jobId, access.docNames, maxCharsPerDoc, {
    roleContract: access.contract,
    enforceLocalOnly: true,
    enforcementNote: [
      '### MEMORY CONTRACT ENFORCEMENT',
      '',
      '- role-scoped read contract enforced',
      `- GoC projection unavailable; using local degraded fallback for this ${cleanText(audienceLabel || 'orchestrator run') || 'orchestrator run'}`,
      access.requestedRoleId && access.requestedRoleId !== access.effectiveRoleId
        ? `- requested role: ${access.requestedRoleId} (effective projection role: ${access.effectiveRoleId})`
        : `- effective projection role: ${access.effectiveRoleId || '(unspecified)'}`,
      `- readable surfaces: ${(access.enforcement.read_surface_ids || []).join(', ') || '(none)'}`,
      `- writable surfaces: ${(access.enforcement.write_surface_ids || []).join(', ') || '(none)'}`,
      `- publish surfaces: ${(access.enforcement.publish_surface_ids || []).join(', ') || '(none)'}`,
    ].join('\n'),
  });
  const projection = await loadRoleScopedGocProjectionContext(jobId, {
    provider: access.effectiveProvider,
    roleId: access.effectiveRoleId,
    maxCharsPerDoc,
    docNames: access.docNames,
    enforcement: access.enforcement,
  });
  if (projection.visibleNodeCount > 0 || cleanText(projection.compressionText)) {
    const sections = [
      '### MEMORY CONTRACT ENFORCEMENT',
      '',
      '- role-scoped read contract enforced',
      cleanText(projection.compressionText)
        ? `- graph-native compression layered over role-scoped projection for this ${cleanText(audienceLabel || 'orchestrator run') || 'orchestrator run'}`
        : `- GoC role-scoped projection applied for this ${cleanText(audienceLabel || 'orchestrator run') || 'orchestrator run'}`,
      access.requestedRoleId && access.requestedRoleId !== access.effectiveRoleId
        ? `- requested role: ${access.requestedRoleId} (effective projection role: ${access.effectiveRoleId})`
        : `- effective projection role: ${access.effectiveRoleId || '(unspecified)'}`,
      `- readable surfaces: ${(access.enforcement.read_surface_ids || []).join(', ') || '(none)'}`,
      `- writable surfaces: ${(access.enforcement.write_surface_ids || []).join(', ') || '(none)'}`,
      `- publish surfaces: ${(access.enforcement.publish_surface_ids || []).join(', ') || '(none)'}`,
    ];
    if (cleanText(projection.harnessName)) sections.push(`- harness: ${projection.harnessName}`);
    if (cleanText(projection.harnessSpecHash)) sections.push(`- harness spec: ${projection.harnessSpecHash}`);
    if (cleanText(projection.compressionText) && projection.compressionDeliveryMode !== 'projection_only') {
      sections.push(`- compression delivery mode: ${projection.compressionDeliveryMode}`);
      sections.push(`- compression support frontier: ${Number(projection.compressionSupportFrontierCount || 0)}`);
      sections.push(`- compression unresolved conflicts: ${Number(projection.compressionUnresolvedConflictCount || 0)}`);
      sections.push('', projection.compressionText);
    }
    if (cleanText(projection.text) && (projection.compressionDeliveryMode === 'projection_only' || projection.compressionAppendixEnabled !== false || !cleanText(projection.compressionText))) {
      const appendixChars = Math.max(800, Math.floor(maxCharsPerDoc * Math.max(0.2, Math.min(Number(projection.compressionAppendixCharBudgetRatio || DEFAULT_HARNESS_APPENDIX_CHAR_BUDGET_RATIO), 1))));
      const appendixHeading = projection.compressionDeliveryMode === 'projection_only'
        ? '### ROLE-SCOPED PROJECTION'
        : '### ROLE-SCOPED PROJECTION APPENDIX';
      sections.push('', appendixHeading, clip(projection.text, appendixChars));
    }
    return sections.filter(Boolean).join('\n');
  }
  return localFallback;
}

async function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500, options = {}) {
  const roleContract = options && typeof options === 'object' ? (options.roleContract || null) : null;
  const enforceLocalOnly = options && typeof options === 'object' ? options.enforceLocalOnly === true : false;
  const enforcementNote = String(options?.enforcementNote || '').trim();
  const local = loadLocalContextDocs(jobId, docNames, maxCharsPerDoc, { roleContract });
  if (enforceLocalOnly) {
    return [
      enforcementNote || `### MEMORY CONTRACT ENFORCEMENT\n\n- role-scoped read contract enforced\n- shared compiled GoC context skipped for this agent run`,
      '',
      local,
    ].filter(Boolean).join('\n\n');
  }
  if (memoryModeWithFallback() !== 'goc') return local;

  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
    });
    const compiled = await client.getCompiledContext(map.ctxSharedId);
    const latest = cleanText(compiled);
    if (!latest) {
      gocFallbackByJob.set(String(jobId), 'empty compiled_text');
      return local;
    }
    gocFallbackByJob.delete(String(jobId));
    return [
      '### GOC ACTIVE CONTEXT',
      clip(latest, 12000),
      '',
      '### LOCAL TRACKING SNAPSHOT',
      local,
    ].join('\n\n');
  } catch (error) {
    const reason = String(error?.message ?? error);
    gocFallbackByJob.set(String(jobId), reason);
    jobs.log(jobId, `GoC compiled context failed; fallback to local: ${reason}`);
    return local;
  }
}

export {
  loadContextDocs,
  loadRoleScopedContextDocs,
  resolveRoleScopedReadAccess,
  formatRoleScopedProjectionContext,
  extractRoleScopedGraphCompression,
  formatRoleScopedGraphCompressionContext,
  loadRoleScopedGraphCompressionContext,
  extractHarnessSpecDelivery,
  invalidateRoleScopedContextCache,
};
