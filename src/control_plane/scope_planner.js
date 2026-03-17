import { normalizeScopeSpecList } from '../domain/scope_spec.js';
import { normalizeVisibilityGraph } from '../domain/visibility_graph.js';
import { inferContextRuntimeMode, summarizeLegacyContextState } from '../domain/context_runtime.js';
import {
  defaultScopeGrantsForRole,
  deriveScopeGrantRecords,
} from '../domain/scope_grant.js';
import { normalizeRoleId } from '../compatibility/legacy_roles.js';

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function asObject(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function normalizeText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeStringList(raw = [], { lower = true, max = 32 } = {}) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  for (const entry of list) {
    const text = normalizeText(entry, { lower });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function findSlot(teamPlan = {}, runtimeAgent = {}) {
  const slotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
  const roleId = normalizeRoleId(runtimeAgent?.role_id || runtimeAgent?.role_label);
  for (const slot of asArray(teamPlan?.slots)) {
    if (slotId && normalizeText(slot?.slot_id || slot?.slotId) === slotId) return slot;
  }
  if (roleId) {
    for (const slot of asArray(teamPlan?.slots)) {
      if (normalizeRoleId(slot?.role_id || slot?.role_label) === roleId) return slot;
    }
  }
  return null;
}

function findActionForRuntimeAgent(runtimeAgent = {}, actions = []) {
  const instanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId);
  const slotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
  const roleId = normalizeRoleId(runtimeAgent?.role_id || runtimeAgent?.role_label);
  return asArray(actions).find((action) => {
    const row = action && typeof action === 'object' ? action : {};
    const inputs = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
    const actionInstanceId = normalizeText(inputs.runtime_instance_id || inputs.runtimeInstanceId);
    const actionSlotId = normalizeText(inputs.slot_id || inputs.slotId);
    const actionRoleId = normalizeRoleId(inputs.role_id || inputs.role_label || row.agent);
    return (instanceId && actionInstanceId === instanceId)
      || (slotId && actionSlotId === slotId)
      || (roleId && actionRoleId === roleId);
  }) || null;
}

function inferContextTypes({ roleId = '', slot = null, goal = '', taskInterpretation = {} } = {}) {
  const role = normalizeRoleId(roleId);
  const text = [
    normalizeText(goal, { lower: true }),
    normalizeText(slot?.purpose, { lower: true }),
    normalizeText(taskInterpretation?.task_summary, { lower: true }),
  ].join('\n');
  const base = [];
  if (role === 'researcher') base.push('evidence', 'citations');
  if (role === 'builder') base.push('workspace', 'code', 'tests');
  if (role === 'reviewer') base.push('contradictions', 'claim_check', 'risk');
  if (role === 'synthesizer') base.push('upstream_results', 'aggregation', 'final_output');
  if (role === 'operator') base.push('workflow', 'run_state', 'team_state');
  if (text.includes('news') || text.includes('headline') || text.includes('market')) base.push('news');
  if (text.includes('filing') || text.includes('dart') || text.includes('공시')) base.push('filings', 'financial_tables');
  if (text.includes('code') || text.includes('repo') || text.includes('patch')) base.push('code');
  if (text.includes('test') || text.includes('검증')) base.push('tests');
  return normalizeStringList([
    ...base,
    ...asArray(slot?.required_context_types || slot?.requiredContextTypes),
  ], { lower: true, max: 24 });
}

function inferBudget(roleId = '') {
  const role = normalizeRoleId(roleId);
  if (role === 'builder') return { soft_tokens: 1800, hard_tokens: 2800 };
  if (role === 'researcher') return { soft_tokens: 1800, hard_tokens: 2600 };
  if (role === 'reviewer') return { soft_tokens: 1500, hard_tokens: 2300 };
  if (role === 'synthesizer') return { soft_tokens: 1400, hard_tokens: 2100 };
  if (role === 'operator') return { soft_tokens: 1400, hard_tokens: 2200 };
  return { soft_tokens: 1200, hard_tokens: 2000 };
}

function inferSelectionStrategy(roleId = '', mode = 'shared_memory') {
  const role = normalizeRoleId(roleId);
  if (mode !== 'scoped_context') return 'shared_context_fallback';
  if (role === 'builder') return 'workspace_plus_closure';
  if (role === 'reviewer') return 'upstream_summary_plus_evidence';
  if (role === 'synthesizer') return 'upstream_results_only';
  if (role === 'operator') return 'control_plane_trace';
  return 'query_plus_closure';
}

function inferClosureEdges(roleId = '') {
  const role = normalizeRoleId(roleId);
  if (role === 'builder') return ['DEPENDS', 'HAS_PART', 'REFERENCES'];
  if (role === 'reviewer') return ['SUPPORTS', 'CITES', 'REFERENCES', 'SUMMARIZES'];
  if (role === 'synthesizer') return ['SUMMARIZES', 'REFERENCES', 'HAS_PART'];
  return ['CITES', 'TABLE_OF', 'SUMMARIZES', 'REFERENCES'];
}

function inferVisibilityMode({ roleId = '', mode = 'shared_memory' } = {}) {
  if (mode !== 'scoped_context') return 'shared';
  return 'scoped';
}

function inferVisibilityRationale({ roleId = '', mode = 'shared_memory' } = {}) {
  const role = normalizeRoleId(roleId);
  if (mode !== 'scoped_context') return 'Shared-memory fallback mode keeps a common context for faster prototyping.';
  if (role === 'researcher') return 'Researcher sees evidence-backed nodes only to reduce context drift.';
  if (role === 'builder') return 'Builder sees workspace/code scope and only explicitly granted supporting context.';
  if (role === 'reviewer') return 'Reviewer receives upstream summaries/results rather than full shared memory to preserve independence.';
  if (role === 'synthesizer') return 'Synthesizer consumes upstream outputs instead of raw shared evidence by default.';
  if (role === 'operator') return 'Operator sees run-state and coordination signals rather than full task evidence.';
  return 'Scoped execution limits visibility to the minimum required context.';
}

function inferSelectionReason({ roleId = '', slot = null, goal = '' } = {}) {
  const role = normalizeRoleId(roleId);
  const purpose = normalizeText(slot?.purpose || slot?.display_label || slot?.label || slot?.name);
  if (purpose) return purpose;
  if (goal) return `${role || 'runtime'} scope planned from task goal`;
  return `${role || 'runtime'} scope planned from team plan`;
}

function buildVisibilityGraph({ teamPlan = {}, scopeSpecs = [], runtimeAgents = [] } = {}) {
  const scopeBySlot = new Map();
  const scopeByRole = new Map();
  const roleBySlot = new Map();
  for (const slot of asArray(teamPlan?.slots)) {
    const slotId = normalizeText(slot?.slot_id || slot?.slotId);
    if (!slotId) continue;
    roleBySlot.set(slotId, normalizeRoleId(slot?.role_id || slot?.role_label));
  }
  for (const spec of asArray(scopeSpecs)) {
    const slotId = normalizeText(spec?.target_slot_id || spec?.targetSlotId);
    const roleId = normalizeRoleId(spec?.role_id || spec?.roleId);
    const scopeId = normalizeText(spec?.scope_id || spec?.scopeId);
    if (!scopeId) continue;
    if (slotId) scopeBySlot.set(slotId, scopeId);
    if (roleId && !scopeByRole.has(roleId)) scopeByRole.set(roleId, scopeId);
  }
  const edges = [];
  for (const edge of asArray(teamPlan?.execution_graph?.edges ?? teamPlan?.dependencies)) {
    const fromRef = normalizeText(edge?.from_slot_id || edge?.fromSlotId || edge?.from);
    const toRef = normalizeText(edge?.to_slot_id || edge?.toSlotId || edge?.to);
    const fromScopeId = scopeBySlot.get(fromRef) || scopeByRole.get(normalizeRoleId(fromRef));
    const toScopeId = scopeBySlot.get(toRef) || scopeByRole.get(normalizeRoleId(toRef));
    if (!fromScopeId || !toScopeId || fromScopeId === toScopeId) continue;
    const downstreamRole = roleBySlot.get(toRef) || normalizeRoleId(toRef);
    let relation = 'scoped_handoff';
    if (downstreamRole === 'reviewer') relation = 'upstream_summary_only';
    else if (downstreamRole === 'synthesizer') relation = 'upstream_results_only';
    else if (downstreamRole === 'operator') relation = 'coordination_metadata_only';
    edges.push({
      from_scope_id: fromScopeId,
      to_scope_id: toScopeId,
      relation,
    });
  }
  return normalizeVisibilityGraph(edges);
}

export class ScopePlanner {
  build({
    goal = '',
    teamPlan = null,
    runtimeAgents = [],
    effectiveActions = [],
    taskInterpretation = {},
    legacyContextPacks = [],
  } = {}) {
    const plan = asObject(teamPlan);
    const mode = inferContextRuntimeMode({
      teamPlan: plan,
      runtimeAgents,
      taskInterpretation,
      scopeSpecs: plan?.scope_specs,
      collaborationCells: plan?.collaboration_cells,
      checkpoints: plan?.checkpoints,
    });

    const scopeSpecsRaw = [];
    for (const runtimeAgent of asArray(runtimeAgents)) {
      const slot = findSlot(plan, runtimeAgent);
      const roleId = normalizeRoleId(slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
      const instanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId);
      const slotId = normalizeText(slot?.slot_id || slot?.slotId || runtimeAgent?.slot_id || runtimeAgent?.slotId);
      const action = findActionForRuntimeAgent(runtimeAgent, effectiveActions);
      const query = normalizeText(action?.prompt || action?.goal || slot?.purpose || goal) || undefined;
      const scopeId = normalizeText(
        runtimeAgent?.scope_id || runtimeAgent?.scopeId || `scope_${slotId || instanceId || roleId || 'runtime'}`
      );
      const memoryGrants = defaultScopeGrantsForRole({ roleId, mode });
      scopeSpecsRaw.push({
        scope_id: scopeId,
        target_slot_id: slotId || undefined,
        target_instance_id: instanceId || undefined,
        role_id: roleId || undefined,
        visibility_mode: inferVisibilityMode({ roleId, mode }),
        context_types: inferContextTypes({ roleId, slot, goal, taskInterpretation }),
        node_selection: {
          strategy: inferSelectionStrategy(roleId, mode),
          query,
          closure_edge_types: inferClosureEdges(roleId),
          closure_direction: 'bidirectional',
          max_nodes: roleId === 'synthesizer' ? 48 : (roleId === 'reviewer' ? 64 : 80),
        },
        memory_grants: memoryGrants,
        budget: inferBudget(roleId),
        selection_reason: inferSelectionReason({ roleId, slot, goal }),
        visibility_rationale: inferVisibilityRationale({ roleId, mode }),
      });
    }

    const scopeSpecs = normalizeScopeSpecList(scopeSpecsRaw);
    const visibilityGraph = buildVisibilityGraph({ teamPlan: plan, scopeSpecs, runtimeAgents });
    const scopeGrants = deriveScopeGrantRecords(scopeSpecs);
    const legacyContextState = summarizeLegacyContextState({
      contextRuntimeMode: mode,
      contextPacks: legacyContextPacks,
      scopeSpecs,
      materializedScopes: asArray(plan?.materialized_scopes),
    });

    return {
      context_runtime_mode: mode,
      scope_specs: scopeSpecs,
      materialized_scopes: [],
      visibility_graph: visibilityGraph,
      scope_grants: scopeGrants,
      legacy_context_pack_count: legacyContextState.legacy_context_pack_count,
      legacy_context_packs_enabled: legacyContextState.legacy_context_packs_enabled,
      legacy_context_strategy: legacyContextState.legacy_context_strategy,
    };
  }
}

export function inferContextRuntimeModeForPlan(input = {}) {
  return inferContextRuntimeMode(input);
}
