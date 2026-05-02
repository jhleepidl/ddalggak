import { normalizeWorkerRoleId } from '../compatibility/legacy_roles.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function cleanText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function cleanId(raw = '') {
  return cleanText(raw, { lower: true }).replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function uniq(values = [], { lower = true, max = 16 } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(values)) {
    const text = cleanText(entry, { lower });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeRole(raw = '') {
  return normalizeWorkerRoleId(raw);
}

function normalizeSlotTemplate(slot = {}, index = 0) {
  const roleId = normalizeRole(slot.role_id || slot.roleId || slot.role || '');
  if (!roleId) return null;
  return {
    role_id: roleId,
    purpose: cleanText(slot.purpose || roleId) || roleId,
    parallelizable: slot.parallelizable !== false,
    deliverable_type: cleanId(slot.deliverable_type || slot.deliverableType || ''),
    required_context_types: uniq(slot.required_context_types || slot.requiredContextTypes || [], { lower: true, max: 8 }),
    preferred_skill_ids: uniq(slot.preferred_skill_ids || slot.preferredSkillIds || [], { lower: true, max: 8 }),
    selection_reason: cleanText(slot.selection_reason || slot.selectionReason || `motif_slot:${roleId}:${index + 1}`) || `motif_slot:${roleId}:${index + 1}`,
  };
}

const BUILTIN_MOTIFS = [
  {
    motif_id: 'motif.single_fast_path',
    label: 'Single-agent fast path',
    source: 'builtin',
    pattern: 'single',
    role_slots: [
      { role_id: 'researcher', purpose: 'Handle low-stress tasks with one primary agent', parallelizable: false, required_context_types: ['task_brief'] },
    ],
    coverage_tags: ['single', 'low_cost', 'fast_path'],
    task_types: ['general', 'research'],
    coordination_cost: 0,
    default_weight: 1.0,
    parallelism_hint: 'single',
  },
  {
    motif_id: 'motif.builder_reviewer_synthesizer',
    label: 'Builder-reviewer-synthesizer workflow',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'builder', purpose: 'Implement the requested code, document, or artifact', parallelizable: false, required_context_types: ['workspace', 'artifact_contract'] },
      { role_id: 'reviewer', purpose: 'Review the produced artifact for regressions, gaps, and risks', parallelizable: false, required_context_types: ['artifact', 'risk'] },
      { role_id: 'synthesizer', purpose: 'Package reviewed results for final delivery', parallelizable: false, required_context_types: ['reviewed_artifact', 'handoff'] },
    ],
    coverage_tags: ['implementation', 'artifact_delivery', 'verification'],
    task_types: ['implementation', 'code_change', 'artifact'],
    coordination_cost: 2,
    default_weight: 1.28,
    parallelism_hint: 'hybrid',
  },
  {
    motif_id: 'motif.scout_builder_reviewer_synthesizer',
    label: 'Scout-builder-reviewer-synthesizer workflow',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'researcher', purpose: 'Map context, requirements, and constraints before implementation', parallelizable: true, required_context_types: ['task_brief', 'workspace', 'evidence'] },
      { role_id: 'builder', purpose: 'Implement the requested code, document, or artifact', parallelizable: false, required_context_types: ['scout_summary', 'workspace'] },
      { role_id: 'reviewer', purpose: 'Review implementation quality, missing pieces, and risks', parallelizable: false, required_context_types: ['artifact', 'risk'] },
      { role_id: 'synthesizer', purpose: 'Deliver final summary, files, and next steps', parallelizable: false, required_context_types: ['reviewed_artifact', 'handoff'] },
    ],
    coverage_tags: ['implementation', 'workspace', 'artifact_delivery', 'verification', 'requirements'],
    task_types: ['implementation', 'code_change', 'artifact'],
    coordination_cost: 3,
    default_weight: 1.22,
    parallelism_hint: 'hybrid',
  },
  {
    motif_id: 'motif.local_private_remote_builder',
    label: 'Local-private review with remote builder',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'reviewer', purpose: 'Read private/project context locally and produce a sanitized implementation brief', parallelizable: false, required_context_types: ['private_projection'] },
      { role_id: 'builder', purpose: 'Use the sanitized brief to implement workspace artifacts', parallelizable: false, required_context_types: ['sanitized_summary', 'workspace'] },
      { role_id: 'synthesizer', purpose: 'Summarize implementation while preserving privacy boundaries', parallelizable: false, required_context_types: ['reviewed_artifact'] },
    ],
    coverage_tags: ['local', 'private', 'implementation', 'sanitized_handoff'],
    task_types: ['implementation', 'review'],
    coordination_cost: 2,
    default_weight: 1.08,
    parallelism_hint: 'hybrid',
  },
  {
    motif_id: 'motif.research_briefing',
    label: 'Research briefing duo',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'researcher', purpose: 'Collect evidence and relevant context', parallelizable: true, required_context_types: ['evidence', 'citations'] },
      { role_id: 'synthesizer', purpose: 'Assemble a user-facing briefing or handoff', parallelizable: false, required_context_types: ['upstream_results', 'aggregation'] },
    ],
    coverage_tags: ['evidence', 'briefing', 'summary'],
    task_types: ['research', 'briefing', 'analysis'],
    coordination_cost: 1,
    default_weight: 1.1,
    parallelism_hint: 'hybrid',
  },
  {
    motif_id: 'motif.research_build_review',
    label: 'Research-build-review loop',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'researcher', purpose: 'Gather upstream evidence and constraints', parallelizable: true, required_context_types: ['evidence', 'workspace'] },
      { role_id: 'builder', purpose: 'Implement the requested patch or artifact', parallelizable: false, required_context_types: ['patch_plan', 'workspace'] },
      { role_id: 'reviewer', purpose: 'Review implementation, regressions, and risks', parallelizable: false, required_context_types: ['risk', 'tests'] },
    ],
    coverage_tags: ['evidence', 'implementation', 'verification'],
    task_types: ['code_change', 'implementation'],
    coordination_cost: 2,
    default_weight: 1.25,
    parallelism_hint: 'hybrid',
  },
  {
    motif_id: 'motif.parallel_research_synthesis',
    label: 'Parallel research synthesis fan-in',
    source: 'builtin',
    pattern: 'parallel',
    role_slots: [
      { role_id: 'researcher', purpose: 'Investigate source A / angle A', parallelizable: true, required_context_types: ['evidence'] },
      { role_id: 'researcher', purpose: 'Investigate source B / angle B', parallelizable: true, required_context_types: ['evidence'] },
      { role_id: 'synthesizer', purpose: 'Merge parallel findings into one answer', parallelizable: false, required_context_types: ['upstream_results', 'aggregation'] },
    ],
    coverage_tags: ['multi_source', 'parallel_research', 'synthesis'],
    task_types: ['research', 'analysis', 'workflow'],
    coordination_cost: 3,
    default_weight: 1.05,
    parallelism_hint: 'parallel',
  },
  {
    motif_id: 'motif.operator_parallel_research',
    label: 'Operator-managed parallel research',
    source: 'builtin',
    pattern: 'graph',
    role_slots: [
      { role_id: 'operator', purpose: 'Coordinate task decomposition and constraints', parallelizable: false, required_context_types: ['task_brief', 'policy'] },
      { role_id: 'researcher', purpose: 'Investigate source cluster A', parallelizable: true, required_context_types: ['evidence'] },
      { role_id: 'researcher', purpose: 'Investigate source cluster B', parallelizable: true, required_context_types: ['evidence'] },
      { role_id: 'synthesizer', purpose: 'Consolidate operator-approved findings', parallelizable: false, required_context_types: ['upstream_results', 'aggregation'] },
    ],
    coverage_tags: ['workflow', 'coordination', 'parallel_research'],
    task_types: ['workflow', 'analysis'],
    coordination_cost: 4,
    default_weight: 0.98,
    parallelism_hint: 'parallel',
  },
  {
    motif_id: 'motif.skeptical_briefing',
    label: 'Skeptical briefing trio',
    source: 'builtin',
    pattern: 'sequential',
    role_slots: [
      { role_id: 'researcher', purpose: 'Collect claims and supporting evidence', parallelizable: true, required_context_types: ['evidence', 'claims'] },
      { role_id: 'reviewer', purpose: 'Challenge unsupported claims and verify citations', parallelizable: false, required_context_types: ['evidence', 'risk'] },
      { role_id: 'synthesizer', purpose: 'Publish a cautious briefing with caveats', parallelizable: false, required_context_types: ['upstream_results', 'aggregation'] },
    ],
    coverage_tags: ['claims', 'evidence', 'verification', 'briefing'],
    task_types: ['briefing', 'analysis'],
    coordination_cost: 2,
    default_weight: 1.18,
    parallelism_hint: 'hybrid',
  },
];

function canonicalizeMotif(raw = {}, { fallbackSource = 'builtin' } = {}) {
  const row = asObject(raw);
  const roleSlots = asArray(row.role_slots || row.roleSlots || row.slots)
    .map((slot, index) => normalizeSlotTemplate(slot, index))
    .filter(Boolean)
    .slice(0, 8);
  if (roleSlots.length === 0) return null;
  const pattern = cleanId(row.pattern || row.execution_pattern || row.executionPattern || 'sequential') || 'sequential';
  const motifId = cleanId(row.motif_id || row.motifId || row.id || `${fallbackSource}:${roleSlots.map((slot) => slot.role_id).join('-')}:${pattern}`);
  if (!motifId) return null;
  return {
    motif_id: motifId,
    label: cleanText(row.label || row.title || motifId) || motifId,
    source: cleanId(row.source || fallbackSource) || fallbackSource,
    pattern,
    role_slots: roleSlots,
    coverage_tags: uniq(row.coverage_tags || row.coverageTags || [], { lower: true, max: 12 }),
    task_types: uniq(row.task_types || row.taskTypes || [], { lower: true, max: 8 }),
    coordination_cost: Number.isFinite(Number(row.coordination_cost || row.coordinationCost))
      ? Math.max(0, Math.floor(Number(row.coordination_cost || row.coordinationCost)))
      : Math.max(1, roleSlots.length - 1),
    default_weight: Number.isFinite(Number(row.default_weight || row.defaultWeight))
      ? Math.max(0.1, Math.min(3, Number(row.default_weight || row.defaultWeight)))
      : 1,
    parallelism_hint: cleanId(row.parallelism_hint || row.parallelismHint || (pattern === 'parallel' ? 'parallel' : 'hybrid')) || 'hybrid',
    historical_stats: asObject(row.historical_stats || row.historicalStats),
  };
}

function extractRoleSlotsFromSnapshot(snapshot = {}) {
  const row = asObject(snapshot);
  const runtimeAgents = asArray(row.runtime_agents || row.runtimeAgents || row.team_plan?.runtime_agents || row.teamPlan?.runtime_agents);
  const executionGraph = asObject(row.execution_graph || row.executionGraph || row.team_plan?.execution_graph || row.teamPlan?.execution_graph);
  const slotMap = new Map();
  for (const agent of runtimeAgents) {
    const slotId = cleanText(agent?.slot_id || agent?.slotId);
    const roleId = normalizeRole(agent?.role_id || agent?.roleId || agent?.role_label || agent?.roleLabel);
    if (!slotId || !roleId) continue;
    slotMap.set(slotId, roleId);
  }
  const orderedSlotIds = uniq(executionGraph.order || executionGraph.role_order || executionGraph.roleOrder || [], { lower: false, max: 16 });
  const roleSlots = [];
  if (orderedSlotIds.length > 0) {
    for (const slotId of orderedSlotIds) {
      const roleId = slotMap.get(slotId) || normalizeRole(slotId);
      if (!roleId) continue;
      roleSlots.push({ role_id: roleId, purpose: `Historical ${roleId}`, parallelizable: true });
    }
  } else {
    for (const agent of runtimeAgents) {
      const roleId = normalizeRole(agent?.role_id || agent?.roleId || agent?.role_label || agent?.roleLabel);
      if (!roleId) continue;
      roleSlots.push({ role_id: roleId, purpose: `Historical ${roleId}`, parallelizable: true });
    }
  }
  return roleSlots.slice(0, 8);
}

export function extractHistoricalMotifs({ runtimeTeamSnapshot = null, activeTeam = null } = {}) {
  const motifs = [];
  const snapshot = runtimeTeamSnapshot && typeof runtimeTeamSnapshot === 'object' ? runtimeTeamSnapshot : null;
  if (snapshot) {
    const roleSlots = extractRoleSlotsFromSnapshot(snapshot);
    if (roleSlots.length > 0) {
      const feedback = asObject(snapshot.execution_feedback || snapshot.executionFeedback);
      const insights = asObject(snapshot.execution_insights || snapshot.executionInsights);
      const executionGraph = asObject(snapshot.execution_graph || snapshot.executionGraph || snapshot.team_plan?.execution_graph || snapshot.teamPlan?.execution_graph);
      const stats = {
        run_count: Number.isFinite(Number(feedback.run_count || feedback.runCount)) ? Math.max(1, Math.floor(Number(feedback.run_count || feedback.runCount))) : 1,
        completion_rate_pct: Number.isFinite(Number(asArray(feedback.patterns)[0]?.completion_rate_pct || asArray(feedback.patterns)[0]?.completionRatePct)) ? Number(asArray(feedback.patterns)[0]?.completion_rate_pct || asArray(feedback.patterns)[0]?.completionRatePct) : undefined,
        participation_pct: Number.isFinite(Number(insights.execution?.participation_pct || insights.execution?.participationPct)) ? Number(insights.execution?.participation_pct || insights.execution?.participationPct) : undefined,
      };
      motifs.push(canonicalizeMotif({
        motif_id: `historical:${roleSlots.map((slot) => slot.role_id).join('-')}:${cleanId(executionGraph.pattern || 'sequential') || 'sequential'}`,
        label: `Historical ${roleSlots.map((slot) => slot.role_id).join(' → ')}`,
        source: 'historical_snapshot',
        pattern: cleanId(executionGraph.pattern || 'sequential') || 'sequential',
        role_slots: roleSlots,
        coverage_tags: roleSlots.map((slot) => slot.role_id),
        coordination_cost: Math.max(1, roleSlots.length - 1),
        default_weight: stats.completion_rate_pct && stats.completion_rate_pct >= 70 ? 1.3 : 1.05,
        parallelism_hint: asArray(executionGraph.parallel_groups || executionGraph.parallelGroups).length > 0 ? 'parallel' : 'hybrid',
        historical_stats: stats,
      }, { fallbackSource: 'historical_snapshot' }));
    }
  }

  const teamAgents = asArray(activeTeam?.agents);
  if (teamAgents.length > 0) {
    const roleSlots = teamAgents.map((agent) => ({
      role_id: normalizeRole(agent?.role || agent?.role_id || agent?.roleId),
      purpose: cleanText(agent?.purpose || agent?.name || agent?.role) || 'team agent',
      parallelizable: true,
      preferred_skill_ids: uniq(agent?.attached_skill_ids || agent?.attachedSkillIds || [], { lower: true, max: 6 }),
    })).filter((slot) => slot.role_id).slice(0, 8);
    if (roleSlots.length > 0) {
      motifs.push(canonicalizeMotif({
        motif_id: `active:${roleSlots.map((slot) => slot.role_id).join('-')}`,
        label: `Active team ${roleSlots.map((slot) => slot.role_id).join(' → ')}`,
        source: 'active_team',
        pattern: cleanId(activeTeam?.structure_v2?.topology?.pattern || activeTeam?.interaction_spec?.execution_pattern || 'sequential') || 'sequential',
        role_slots: roleSlots,
        coordination_cost: Math.max(1, roleSlots.length - 1),
        default_weight: 1.02,
      }, { fallbackSource: 'active_team' }));
    }
  }

  return motifs.filter(Boolean);
}



function buildMotifsFromFeedbackSummary(summary = null, { channel = 'stable', promotionSummary = null } = {}) {
  const row = asObject(summary);
  const channels = asObject(row.channels);
  const channelKey = cleanId(channel || 'stable') === 'candidate' ? 'candidate' : 'stable';
  const channelRows = asArray(asObject(channels[channelKey]).motifs);
  const baseRows = channelRows.length > 0
    ? channelRows
    : asArray(channelKey === 'candidate' ? (row.candidate_motifs || row.recommended_motifs || row.motifs) : (row.stable_motifs || row.recommended_motifs || row.motifs));
  const promotion = asObject(promotionSummary);
  const promotedStableIds = new Set(uniq(asObject(promotion.stable_registry).motif_ids || [], { lower: true, max: 64 }));
  const rolledBackIds = new Set(uniq(asObject(promotion.rolled_back_registry).motif_ids || [], { lower: true, max: 64 }));
  const promotedRows = asArray(asObject(promotion.stable_registry).motifs);
  const sourceRows = [
    ...baseRows,
    ...(channelKey === 'stable' ? promotedRows : []),
  ].filter((entry) => {
    const motifId = cleanId(entry?.motif_id || entry?.motifId || '');
    if (!motifId) return false;
    if (channelKey === 'candidate' && rolledBackIds.has(motifId)) return false;
    return true;
  });
  return sourceRows
    .map((entry) => {
      const item = asObject(entry);
      const roleSlots = uniq(item.role_ids || item.roleIds || [], { lower: true, max: 8 })
        .map((roleId, index) => ({
          role_id: roleId,
          purpose: `Feedback-backed ${roleId}`,
          parallelizable: roleId === 'researcher',
          selection_reason: `motif_feedback:${cleanId(item.motif_id || item.motifId || '')}:${index + 1}`,
        }));
      if (roleSlots.length === 0) return null;
      const recommendation = cleanId(item.recommendation || 'neutral') || 'neutral';
      const cleanMotifId = cleanId(item.motif_id || item.motifId || '');
      return canonicalizeMotif({
        motif_id: item.motif_id || item.motifId,
        label: item.label || `Feedback ${roleSlots.map((slot) => slot.role_id).join(' → ')}`,
        source: 'feedback_summary',
        source_channel: channelKey,
        pattern: item.pattern || 'sequential',
        role_slots: roleSlots,
        coverage_tags: uniq([...(item.role_ids || []), ...(item.task_types || []), ...(item.deliverable_types || []), recommendation, ...(promotedStableIds.has(cleanMotifId) ? ['promoted_stable'] : []), ...(rolledBackIds.has(cleanMotifId) ? ['rolled_back'] : [])], { lower: true, max: 12 }),
        task_types: item.task_types || [],
        coordination_cost: Math.max(1, roleSlots.length - 1),
        default_weight: Number.isFinite(Number(item.default_weight || item.defaultWeight))
          ? Number(item.default_weight || item.defaultWeight) + (promotedStableIds.has(cleanMotifId) ? 0.15 : 0)
          : (recommendation === 'recommended' ? 1.25 : (recommendation === 'promising' ? 1.1 : 1.0)) + (promotedStableIds.has(cleanMotifId) ? 0.15 : 0),
        parallelism_hint: roleSlots.filter((slot) => slot.role_id === 'researcher').length >= 2 ? 'parallel' : 'hybrid',
        historical_stats: {
          run_count: Number(item.run_count || 0),
          success_rate_pct: Number(item.success_rate_pct || item.successRatePct || 0),
          avg_participation_pct: Number(item.avg_participation_pct || item.avgParticipationPct || 0),
          recommendation,
          promoted_stable: promotedStableIds.has(cleanMotifId),
          rolled_back: rolledBackIds.has(cleanMotifId),
        },
      }, { fallbackSource: 'feedback_summary' });
    })
    .filter(Boolean);
}

export function buildTeamMotifRegistry({ runtimeTeamSnapshot = null, activeTeam = null, motifFeedbackSummary = null, promotionSummary = null, channel = 'stable' } = {}) {
  const cleanChannel = cleanId(channel || 'stable') === 'candidate' ? 'candidate' : 'stable';
  const combined = [...buildMotifsFromFeedbackSummary(motifFeedbackSummary, { channel: cleanChannel, promotionSummary }), ...BUILTIN_MOTIFS, ...extractHistoricalMotifs({ runtimeTeamSnapshot, activeTeam })]
    .map((entry) => canonicalizeMotif(entry))
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const motif of combined) {
    if (seen.has(motif.motif_id)) continue;
    seen.add(motif.motif_id);
    out.push(motif);
  }
  return out;
}

export function listBuiltinTeamMotifs() {
  return BUILTIN_MOTIFS.map((entry) => canonicalizeMotif(entry)).filter(Boolean);
}
