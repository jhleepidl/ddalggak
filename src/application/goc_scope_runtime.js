function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = '', { lower = false } = {}) {
  const clean = String(value || '').trim();
  return lower ? clean.toLowerCase() : clean;
}

function clipText(value = '', max = 4000) {
  const text = String(value || '').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function parseBooleanLike(value, fallback = false) {
  if (value === true) return true;
  if (value === false) return false;
  const clean = normalizeText(value, { lower: true });
  if (!clean) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(clean)) return true;
  if (['0', 'false', 'no', 'off'].includes(clean)) return false;
  return fallback;
}

function normalizeMemoryGrants(raw = null) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    shared_summary: parseBooleanLike(row.shared_summary ?? row.sharedSummary, false),
    global_memory: parseBooleanLike(row.global_memory ?? row.globalMemory, false),
    conversation_tail: parseBooleanLike(row.conversation_tail ?? row.conversationTail, false),
    upstream_results: parseBooleanLike(row.upstream_results ?? row.upstreamResults, false),
    upstream_summaries: parseBooleanLike(row.upstream_summaries ?? row.upstreamSummaries ?? row.upstream_summary ?? row.upstreamSummary, false),
    user_pinned_nodes: parseBooleanLike(row.user_pinned_nodes ?? row.userPinnedNodes, false),
    explicit_uploaded_files: parseBooleanLike(row.explicit_uploaded_files ?? row.explicitUploadedFiles, false),
  };
}

function uniqueByKey(rows = [], keyFn = (row) => row) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const key = normalizeText(keyFn(row));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function getRuntimeAgentCandidates(runtimeAgents = [], {
  cleanScopeId = '',
  cleanInstanceId = '',
  cleanSlotId = '',
  cleanAgentId = '',
} = {}) {
  const rows = asArray(runtimeAgents);
  if (cleanScopeId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.scope_id || entry?.scopeId) === cleanScopeId), (entry) => entry?.instance_id || entry?.instanceId || entry?.slot_id || entry?.slotId || entry?.scope_id || entry?.scopeId);
  }
  if (cleanInstanceId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.instance_id || entry?.instanceId) === cleanInstanceId), (entry) => entry?.instance_id || entry?.instanceId);
  }
  if (cleanSlotId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.slot_id || entry?.slotId) === cleanSlotId), (entry) => entry?.instance_id || entry?.instanceId || entry?.slot_id || entry?.slotId);
  }
  if (cleanAgentId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.role_id || entry?.role_label, { lower: true }) === cleanAgentId), (entry) => entry?.instance_id || entry?.instanceId || entry?.slot_id || entry?.slotId || entry?.role_id || entry?.role_label);
  }
  return [];
}

function getScopeSpecCandidates(scopeSpecs = [], runtimeAgent = null, {
  cleanScopeId = '',
  cleanInstanceId = '',
  cleanSlotId = '',
  cleanAgentId = '',
} = {}) {
  const rows = asArray(scopeSpecs);
  const agentInstanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId);
  const agentSlotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
  if (cleanScopeId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.scope_id || entry?.scopeId) === cleanScopeId), (entry) => entry?.scope_id || entry?.scopeId);
  }
  if (cleanInstanceId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.target_instance_id || entry?.targetInstanceId) === cleanInstanceId), (entry) => entry?.scope_id || entry?.scopeId);
  }
  if (cleanSlotId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.target_slot_id || entry?.targetSlotId) === cleanSlotId), (entry) => entry?.scope_id || entry?.scopeId);
  }
  if (agentInstanceId) {
    const byAgentInstance = uniqueByKey(rows.filter((entry) => normalizeText(entry?.target_instance_id || entry?.targetInstanceId) === agentInstanceId), (entry) => entry?.scope_id || entry?.scopeId);
    if (byAgentInstance.length > 0) return byAgentInstance;
  }
  if (agentSlotId) {
    const byAgentSlot = uniqueByKey(rows.filter((entry) => normalizeText(entry?.target_slot_id || entry?.targetSlotId) === agentSlotId), (entry) => entry?.scope_id || entry?.scopeId);
    if (byAgentSlot.length > 0) return byAgentSlot;
  }
  if (cleanAgentId) {
    return uniqueByKey(rows.filter((entry) => normalizeText(entry?.role_id || entry?.roleId, { lower: true }) === cleanAgentId), (entry) => entry?.scope_id || entry?.scopeId);
  }
  return [];
}

function getMaterializedScopeCandidates(materializedScopes = [], {
  cleanScopeId = '',
  scopeSpecCandidates = [],
} = {}) {
  const rows = asArray(materializedScopes);
  const expectedScopeIds = uniqueByKey([
    cleanScopeId,
    ...scopeSpecCandidates.map((entry) => entry?.scope_id || entry?.scopeId),
  ]);
  if (expectedScopeIds.length === 0) return [];
  return uniqueByKey(
    rows.filter((entry) => expectedScopeIds.includes(normalizeText(entry?.scope_id || entry?.scopeId))),
    (entry) => entry?.scope_id || entry?.scopeId,
  );
}

function hasUsableMaterializedScope(materializedScope = null) {
  const scope = materializedScope && typeof materializedScope === 'object' ? materializedScope : {};
  const scopeId = normalizeText(scope.scope_id || scope.scopeId);
  const contextSetId = normalizeText(scope.context_set_id || scope.contextSetId);
  const activeNodeIds = asArray(scope.active_node_ids ?? scope.activeNodeIds).filter((entry) => normalizeText(entry));
  const compiledText = normalizeText(scope.compiled_text || scope.compiledText);
  return Boolean(scopeId || contextSetId || activeNodeIds.length > 0 || compiledText);
}

function hasCompiledScopeContent(materializedScope = null) {
  const scope = materializedScope && typeof materializedScope === 'object' ? materializedScope : {};
  const activeNodeIds = asArray(scope.active_node_ids ?? scope.activeNodeIds).filter((entry) => normalizeText(entry));
  const compiledText = normalizeText(scope.compiled_text || scope.compiledText);
  return Boolean(activeNodeIds.length > 0 || compiledText);
}

function isEmptyMaterializedScope(materializedScope = null) {
  const scope = materializedScope && typeof materializedScope === 'object' ? materializedScope : {};
  const lineage = scope.lineage && typeof scope.lineage === 'object' ? scope.lineage : {};
  if (lineage.empty_scope === true) return true;
  return hasUsableMaterializedScope(scope) && !hasCompiledScopeContent(scope);
}

function isAuthoritativeMaterializedScope(materializedScope = null) {
  const scope = materializedScope && typeof materializedScope === 'object' ? materializedScope : {};
  const lineage = scope.lineage && typeof scope.lineage === 'object' ? scope.lineage : {};
  const compiler = normalizeText(lineage.compiler || scope.compiler, { lower: true });
  return compiler === 'goc_scope_materializer';
}

export function resolveScopeBinding({
  runtimeSnapshot = null,
  action = null,
  agentId = '',
  runtimeInstanceId = '',
  slotId = '',
  scopeId = '',
} = {}) {
  const snapshot = runtimeSnapshot && typeof runtimeSnapshot === 'object' ? runtimeSnapshot : {};
  const actionInputs = action?.inputs && typeof action.inputs === 'object' ? action.inputs : {};
  const cleanScopeId = normalizeText(scopeId || actionInputs.scope_id || actionInputs.scopeId);
  const cleanInstanceId = normalizeText(runtimeInstanceId || actionInputs.runtime_instance_id || actionInputs.runtimeInstanceId);
  const cleanSlotId = normalizeText(slotId || actionInputs.slot_id || actionInputs.slotId);
  const cleanAgentId = normalizeText(agentId || action?.agent || actionInputs.role_id || actionInputs.role_label, { lower: true });

  const scopeSpecs = asArray(snapshot.scope_specs ?? snapshot.scopeSpecs);
  const materializedScopes = asArray(snapshot.materialized_scopes ?? snapshot.materializedScopes);
  const runtimeAgents = asArray(snapshot.runtime_agents ?? snapshot.runtimeAgents);

  const runtimeAgentCandidates = getRuntimeAgentCandidates(runtimeAgents, {
    cleanScopeId,
    cleanInstanceId,
    cleanSlotId,
    cleanAgentId,
  });
  const runtimeAgent = runtimeAgentCandidates.length === 1 ? runtimeAgentCandidates[0] : null;

  const scopeSpecCandidates = getScopeSpecCandidates(scopeSpecs, runtimeAgent, {
    cleanScopeId,
    cleanInstanceId,
    cleanSlotId,
    cleanAgentId,
  });
  const resolvedScopeSpec = scopeSpecCandidates.length === 1 ? scopeSpecCandidates[0] : null;

  const materializedScopeCandidates = getMaterializedScopeCandidates(materializedScopes, {
    cleanScopeId,
    scopeSpecCandidates,
  });
  const resolvedMaterializedScope = materializedScopeCandidates.length === 1 ? materializedScopeCandidates[0] : null;

  const memoryGrants = normalizeMemoryGrants(
    actionInputs.memory_grants
    ?? actionInputs.memoryGrants
    ?? resolvedScopeSpec?.memory_grants
    ?? resolvedScopeSpec?.memoryGrants
    ?? runtimeAgent?.memory_grants
    ?? runtimeAgent?.memoryGrants
    ?? null
  );

  const ambiguous = runtimeAgentCandidates.length > 1 || scopeSpecCandidates.length > 1 || materializedScopeCandidates.length > 1;
  const candidateScopeIds = uniqueByKey([
    ...scopeSpecCandidates.map((entry) => entry?.scope_id || entry?.scopeId),
    ...materializedScopeCandidates.map((entry) => entry?.scope_id || entry?.scopeId),
  ]);

  return {
    runtime_agent: runtimeAgent,
    runtime_agent_candidates: runtimeAgentCandidates,
    scope_spec: resolvedScopeSpec,
    scope_spec_candidates: scopeSpecCandidates,
    materialized_scope: resolvedMaterializedScope,
    materialized_scope_candidates: materializedScopeCandidates,
    candidate_scope_ids: candidateScopeIds,
    ambiguous,
    memory_grants: memoryGrants,
    visibility_mode: normalizeText(
      actionInputs.visibility_mode
      || actionInputs.visibilityMode
      || resolvedScopeSpec?.visibility_mode
      || resolvedScopeSpec?.visibilityMode
      || 'scoped',
      { lower: true }
    ) || 'scoped',
  };
}

export function resolveScopeExecutionState({
  runtimeSnapshot = null,
  action = null,
  agentId = '',
  runtimeInstanceId = '',
  slotId = '',
  scopeId = '',
} = {}) {
  const snapshot = runtimeSnapshot && typeof runtimeSnapshot === 'object' ? runtimeSnapshot : {};
  const contextRuntimeMode = normalizeText(snapshot.context_runtime_mode || snapshot.contextRuntimeMode || 'shared_memory', { lower: true }) || 'shared_memory';
  const scopedMode = contextRuntimeMode === 'scoped_context';
  const scopeBinding = resolveScopeBinding({
    runtimeSnapshot: snapshot,
    action,
    agentId,
    runtimeInstanceId,
    slotId,
    scopeId,
  });
  const visibilityMode = normalizeText(scopeBinding.visibility_mode || 'scoped', { lower: true }) || 'scoped';
  const requiresScope = scopedMode && visibilityMode !== 'shared_memory' && visibilityMode !== 'shared';
  const hasScopeSpec = Boolean(scopeBinding.scope_spec);
  const hasMaterializedScope = hasUsableMaterializedScope(scopeBinding.materialized_scope);
  const authoritativeScope = isAuthoritativeMaterializedScope(scopeBinding.materialized_scope);
  const emptyScope = isEmptyMaterializedScope(scopeBinding.materialized_scope);

  if (!requiresScope) {
    return {
      blocked: false,
      reason: '',
      scope_binding: scopeBinding,
      requires_scope: false,
      has_scope_spec: hasScopeSpec,
      has_materialized_scope: hasMaterializedScope,
      authoritative_scope: authoritativeScope,
      empty_scope: emptyScope,
    };
  }

  if (scopeBinding.ambiguous) {
    return {
      blocked: true,
      reason: `ambiguous scope binding${scopeBinding.candidate_scope_ids.length > 0 ? ` (${scopeBinding.candidate_scope_ids.join(', ')})` : ''}`,
      scope_binding: scopeBinding,
      requires_scope: true,
      has_scope_spec: false,
      has_materialized_scope: false,
      authoritative_scope: false,
      empty_scope: false,
    };
  }

  if (!hasScopeSpec && !hasMaterializedScope) {
    return {
      blocked: true,
      reason: 'missing scope binding for scoped execution',
      scope_binding: scopeBinding,
      requires_scope: true,
      has_scope_spec: false,
      has_materialized_scope: false,
      authoritative_scope: false,
      empty_scope: false,
    };
  }

  if (!hasMaterializedScope) {
    return {
      blocked: true,
      reason: 'scope is not materialized',
      scope_binding: scopeBinding,
      requires_scope: true,
      has_scope_spec: hasScopeSpec,
      has_materialized_scope: false,
      authoritative_scope: false,
      empty_scope: false,
    };
  }

  if (!authoritativeScope) {
    return {
      blocked: true,
      reason: 'scope is not compiled by GoC',
      scope_binding: scopeBinding,
      requires_scope: true,
      has_scope_spec: hasScopeSpec,
      has_materialized_scope: true,
      authoritative_scope: false,
      empty_scope: emptyScope,
    };
  }

  if (emptyScope) {
    return {
      blocked: true,
      reason: 'scope materialized to an empty visibility set',
      scope_binding: scopeBinding,
      requires_scope: true,
      has_scope_spec: hasScopeSpec,
      has_materialized_scope: true,
      authoritative_scope: true,
      empty_scope: true,
    };
  }

  return {
    blocked: false,
    reason: '',
    scope_binding: scopeBinding,
    requires_scope: true,
    has_scope_spec: hasScopeSpec,
    has_materialized_scope: true,
    authoritative_scope: true,
    empty_scope: false,
  };
}

export function buildScopedPromptAssembly({
  goal = '',
  detailContext = '',
  runtime = null,
  scopeBinding = null,
  maxScopeChars = 10000,
  maxSharedChars = 3500,
  maxMemoryChars = 5000,
} = {}) {
  const binding = scopeBinding && typeof scopeBinding === 'object' ? scopeBinding : {};
  const memoryGrants = normalizeMemoryGrants(binding.memory_grants);
  const materializedScope = binding.materialized_scope && typeof binding.materialized_scope === 'object'
    ? binding.materialized_scope
    : {};
  const scopeSpec = binding.scope_spec && typeof binding.scope_spec === 'object'
    ? binding.scope_spec
    : {};

  const compiledScopeText = clipText(
    materializedScope.compiled_text || materializedScope.compiledText || '',
    maxScopeChars,
  );
  const sharedSummary = memoryGrants.shared_summary
    ? clipText(runtime?.contextSummary || runtime?.sharedSummary || '', maxSharedChars)
    : '';
  const globalMemory = memoryGrants.global_memory
    ? clipText(runtime?.globalSummary || runtime?.globalMemory || '', maxMemoryChars)
    : '';
  const conversationTail = memoryGrants.conversation_tail
    ? clipText(runtime?.conversationTail || runtime?.conversation_tail || '', 2500)
    : '';
  const upstreamResults = memoryGrants.upstream_results || memoryGrants.upstream_summaries
    ? clipText(runtime?.upstreamSummary || runtime?.upstream_summary || runtime?.latestUpstreamSummary || '', 3500)
    : '';
  const cleanDetail = normalizeText(detailContext);
  const cleanGoal = normalizeText(goal);

  const scopedContextSection = compiledScopeText
    ? `[SCOPED CONTEXT]\n${compiledScopeText}`
    : ((scopeSpec && Object.keys(scopeSpec).length > 0) || hasUsableMaterializedScope(materializedScope)
      ? '[SCOPED CONTEXT]\n(no compiled scope text available)'
      : '');

  const finalPrompt = [
    cleanGoal,
    scopedContextSection,
    sharedSummary ? `[GRANTED SHARED SUMMARY]\n${sharedSummary}` : '',
    upstreamResults ? `[GRANTED UPSTREAM RESULTS]\n${upstreamResults}` : '',
    conversationTail ? `[GRANTED CONVERSATION TAIL]\n${conversationTail}` : '',
    cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : '',
    globalMemory ? `[GRANTED GLOBAL MEMORY]\n${globalMemory}` : '',
  ].filter(Boolean).join('\n\n');

  const activeNodeIds = asArray(materializedScope.active_node_ids ?? materializedScope.activeNodeIds);
  const typeBreakdown = materializedScope.type_breakdown && typeof materializedScope.type_breakdown === 'object'
    ? materializedScope.type_breakdown
    : {};

  return {
    final_prompt: finalPrompt || cleanGoal,
    context_info: {
      mode: 'scoped_context',
      visibility_mode: normalizeText(binding.visibility_mode || scopeSpec.visibility_mode || 'scoped', { lower: true }) || 'scoped',
      scope_id: normalizeText(scopeSpec.scope_id || scopeSpec.scopeId || materializedScope.scope_id || materializedScope.scopeId) || undefined,
      context_set_id: normalizeText(materializedScope.context_set_id || materializedScope.contextSetId) || undefined,
      scope_version: materializedScope.scope_version ?? materializedScope.scopeVersion ?? undefined,
      token_estimate: Number.isFinite(Number(materializedScope.token_estimate)) ? Math.max(0, Math.floor(Number(materializedScope.token_estimate))) : undefined,
      actual_tokens: Number.isFinite(Number(materializedScope.actual_tokens)) ? Math.max(0, Math.floor(Number(materializedScope.actual_tokens))) : undefined,
      active_node_ids: activeNodeIds.length > 0 ? activeNodeIds : undefined,
      active_type_breakdown: Object.keys(typeBreakdown).length > 0 ? typeBreakdown : undefined,
      memory_grants: memoryGrants,
      selection_reason: normalizeText(scopeSpec.selection_reason || scopeSpec.selectionReason) || undefined,
      scope_lineage: materializedScope.lineage && typeof materializedScope.lineage === 'object'
        ? materializedScope.lineage
        : undefined,
      authoritative_scope: isAuthoritativeMaterializedScope(materializedScope),
      empty_scope: isEmptyMaterializedScope(materializedScope),
      compiled_chars: String(compiledScopeText || '').length,
      compiled_tokens_estimate: Number.isFinite(Number(materializedScope.token_estimate))
        ? Math.max(0, Math.floor(Number(materializedScope.token_estimate)))
        : undefined,
    },
  };
}

export async function hydrateRuntimeScopesViaGoC({
  client = null,
  threadId = '',
  runtimeSnapshot = null,
  scopeId = '',
} = {}) {
  const snapshot = runtimeSnapshot && typeof runtimeSnapshot === 'object' ? runtimeSnapshot : {};
  const scopeSpecs = asArray(snapshot.scope_specs ?? snapshot.scopeSpecs);
  const cleanThreadId = normalizeText(threadId);
  if (!client || typeof client.materializeRuntimeScopes !== 'function' || !cleanThreadId || scopeSpecs.length === 0) {
    return snapshot;
  }

  const requestedScopeId = normalizeText(scopeId);
  const materializedScopes = await client.materializeRuntimeScopes(cleanThreadId, snapshot, {
    scopeId: requestedScopeId || undefined,
  }).catch(() => []);
  if (!Array.isArray(materializedScopes) || materializedScopes.length === 0) {
    return snapshot;
  }

  const mergedById = new Map();
  for (const row of asArray(snapshot.materialized_scopes ?? snapshot.materializedScopes)) {
    const key = normalizeText(row?.scope_id || row?.scopeId);
    if (!key) continue;
    mergedById.set(key, row);
  }
  for (const row of materializedScopes) {
    const key = normalizeText(row?.scope_id || row?.scopeId);
    if (!key) continue;
    mergedById.set(key, row);
  }

  return {
    ...snapshot,
    materialized_scopes: Array.from(mergedById.values()),
    context_runtime_mode: normalizeText(snapshot.context_runtime_mode || snapshot.contextRuntimeMode || 'scoped_context', { lower: true }) || 'scoped_context',
    scope_materializer: 'goc_backend',
    scope_materialized_at: new Date().toISOString(),
  };
}
