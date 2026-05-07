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

function uniq(values = [], { lower = true, max = 24 } = {}) {
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

function countBy(items = [], keyFn = (value) => value) {
  const map = new Map();
  for (const item of asArray(items)) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) total += Number(value) || 0;
  return total;
}

function normalizeCapabilitySlot(slot = {}, index = 0) {
  const roleId = normalizeRole(slot.role_id || slot.roleId || slot.role || '');
  if (!roleId) return null;
  return {
    role_id: roleId,
    purpose: cleanText(slot.purpose || roleId) || roleId,
    required_context_types: uniq(slot.required_context_types || slot.requiredContextTypes || [], { lower: true, max: 8 }),
    preferred_skill_ids: uniq(slot.preferred_skill_ids || slot.preferredSkillIds || [], { lower: true, max: 8 }),
    parallelizable: slot.parallelizable !== false,
    selection_reason: cleanText(slot.selection_reason || slot.selectionReason || `graph_librarian:${roleId}:${index + 1}`) || `graph_librarian:${roleId}:${index + 1}`,
  };
}

function roleDemandSignature(demand = []) {
  return asArray(demand).map((slot) => slot.role_id).join('|');
}

export function buildDemandGraph({
  goal = '',
  taskInterpretation = null,
  routePlan = null,
  runtimeTeamSnapshot = null,
} = {}) {
  const interpreted = asObject(taskInterpretation);
  const demandNodes = asArray(interpreted.candidate_capability_slots)
    .map((slot, index) => normalizeCapabilitySlot(slot, index))
    .filter(Boolean);
  const lowerGoal = cleanText(goal || interpreted.goal || '', { lower: true });
  const route = asObject(routePlan);
  const snapshot = asObject(runtimeTeamSnapshot);
  const visibilityGraph = asArray(snapshot.visibility_graph || snapshot.visibilityGraph);
  const executionGraph = asObject(snapshot.execution_graph || snapshot.executionGraph);
  const demandTags = new Set();

  for (const slot of demandNodes) {
    demandTags.add(slot.role_id);
    for (const entry of slot.required_context_types) demandTags.add(entry);
    for (const entry of slot.preferred_skill_ids) demandTags.add(entry);
  }

  const workflowContract = asObject(interpreted.team_workflow_contract || interpreted.teamWorkflowContract);
  const workflowKind = cleanId(workflowContract.workflow_kind || workflowContract.workflowKind || '');
  if (cleanText(interpreted.review_policy, { lower: true }) === 'required' || asArray(workflowContract.required_passes || workflowContract.requiredPasses).includes('review')) demandTags.add('verification');
  if (cleanText(interpreted.parallelism_preference, { lower: true }) === 'parallel') demandTags.add('parallel_research');
  if (cleanText(interpreted.task_type, { lower: true }) === 'workflow' || workflowKind === 'bounded_continuous_loop') demandTags.add('workflow');
  if (workflowKind === 'bounded_continuous_loop') {
    demandTags.add('bounded_loop');
    demandTags.add('implementation');
    demandTags.add('verification');
    demandTags.add('risk');
  }
  if (workflowKind === 'review_gated_pipeline') {
    demandTags.add('implementation');
    demandTags.add('verification');
  }
  if (cleanText(interpreted.deliverable_type, { lower: true }).includes('brief')) demandTags.add('briefing');
  if (cleanText(interpreted.deliverable_type, { lower: true }).includes('report')) demandTags.add('summary');
  if (cleanText(interpreted.task_type, { lower: true }) === 'code_change') demandTags.add('implementation');
  if (visibilityGraph.length > 0) demandTags.add('visibility');
  if (asArray(executionGraph.parallel_groups || executionGraph.parallelGroups).length > 0) demandTags.add('parallel_research');
  if (lowerGoal.includes('evidence') || lowerGoal.includes('citation') || lowerGoal.includes('근거') || lowerGoal.includes('인용')) demandTags.add('evidence');
  if (lowerGoal.includes('verify') || lowerGoal.includes('검증') || lowerGoal.includes('review') || lowerGoal.includes('리뷰')) demandTags.add('verification');
  if (lowerGoal.includes('summary') || lowerGoal.includes('brief') || lowerGoal.includes('요약') || lowerGoal.includes('정리')) demandTags.add('briefing');
  if (lowerGoal.includes('parallel') || asArray(route.actions).some((action) => cleanId(action?.type) === 'spawn_parallel')) demandTags.add('parallel_research');
  if (lowerGoal.includes('workflow') || lowerGoal.includes('orchestrate') || lowerGoal.includes('coordination')) demandTags.add('workflow');

  const needsReviewer = demandNodes.some((slot) => slot.role_id === 'reviewer') || demandTags.has('verification');
  const needsSynthesizer = demandNodes.some((slot) => slot.role_id === 'synthesizer') || demandTags.has('briefing') || demandTags.has('summary');
  const needsParallelResearch = demandTags.has('parallel_research');

  return {
    nodes: demandNodes,
    role_counts: countBy(demandNodes, (slot) => slot.role_id),
    tags: [...demandTags],
    needs_reviewer: needsReviewer,
    needs_synthesizer: needsSynthesizer,
    needs_parallel_research: needsParallelResearch,
    task_type: cleanId(interpreted.task_type || interpreted.taskType || ''),
    deliverable_type: cleanId(interpreted.deliverable_type || interpreted.deliverableType || ''),
    parallelism_preference: cleanId(interpreted.parallelism_preference || interpreted.parallelismPreference || ''),
    review_policy: cleanId(interpreted.review_policy || interpreted.reviewPolicy || ''),
  };
}

function predictTargetAgentCount(demandGraph = {}, { maxAgents = 6 } = {}) {
  const base = Math.max(1, sumMapValues(demandGraph.role_counts));
  let target = base;
  if (demandGraph.needs_parallel_research) target += 1;
  if (demandGraph.needs_reviewer && !demandGraph.role_counts.get('reviewer')) target += 1;
  if (demandGraph.needs_synthesizer && !demandGraph.role_counts.get('synthesizer')) target += 1;
  return Math.max(1, Math.min(Math.max(1, Math.floor(Number(maxAgents) || 6)), target));
}

function scoreState({ state, demandGraph, targetAgentCount }) {
  const requiredRoles = demandGraph.role_counts;
  let covered = 0;
  let unmet = 0;
  for (const [roleId, neededCount] of requiredRoles.entries()) {
    const coveredCount = Math.min(neededCount, state.role_counts.get(roleId) || 0);
    covered += coveredCount;
    unmet += Math.max(0, neededCount - (state.role_counts.get(roleId) || 0));
  }
  const tagSet = new Set(demandGraph.tags);
  let tagCoverage = 0;
  for (const motif of state.selected_motifs) {
    for (const tag of motif.coverage_tags || []) {
      if (tagSet.has(tag)) tagCoverage += 1;
    }
  }
  const roleCount = sumMapValues(state.role_counts);
  const targetPenalty = Math.abs(targetAgentCount - roleCount) * 0.5;
  const redundancyPenalty = Math.max(0, roleCount - targetAgentCount) * 0.75;
  const coordinationPenalty = state.coordination_cost * 0.35;
  const historicalBonus = state.historical_bonus;
  const parallelBonus = demandGraph.needs_parallel_research && state.parallelism === 'parallel' ? 1.2 : 0;
  const verificationBonus = demandGraph.needs_reviewer && (state.role_counts.get('reviewer') || 0) > 0 ? 1.1 : 0;
  const synthesisBonus = demandGraph.needs_synthesizer && (state.role_counts.get('synthesizer') || 0) > 0 ? 0.9 : 0;
  const score = (covered * 4)
    + (tagCoverage * 0.4)
    + historicalBonus
    + parallelBonus
    + verificationBonus
    + synthesisBonus
    - (unmet * 3.5)
    - targetPenalty
    - redundancyPenalty
    - coordinationPenalty;
  return { score, unmet, covered, tagCoverage };
}

function expandState(state, motif) {
  const next = {
    selected_motifs: [...state.selected_motifs, motif],
    role_counts: new Map(state.role_counts),
    coordination_cost: state.coordination_cost + (Number(motif.coordination_cost) || 0),
    historical_bonus: state.historical_bonus + ((Number(motif.default_weight) || 1) - 1),
    parallelism: state.parallelism === 'parallel' || motif.parallelism_hint === 'parallel' ? 'parallel' : 'hybrid',
  };
  for (const slot of asArray(motif.role_slots)) {
    next.role_counts.set(slot.role_id, (next.role_counts.get(slot.role_id) || 0) + 1);
  }
  return next;
}

function stateSignature(state) {
  return state.selected_motifs.map((motif) => motif.motif_id).sort().join('|');
}

function buildBeamSearch({ demandGraph, motifRegistry = [], beamWidth = 4, maxDepth = 3, targetAgentCount = 4 }) {
  let beam = [{ selected_motifs: [], role_counts: new Map(), coordination_cost: 0, historical_bonus: 0, parallelism: 'hybrid' }];
  let best = { state: beam[0], metrics: scoreState({ state: beam[0], demandGraph, targetAgentCount }) };
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidates = [];
    const seen = new Set();
    for (const state of beam) {
      const used = new Set(state.selected_motifs.map((motif) => motif.motif_id));
      for (const motif of motifRegistry) {
        if (!motif || used.has(motif.motif_id)) continue;
        const next = expandState(state, motif);
        const signature = stateSignature(next);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const metrics = scoreState({ state: next, demandGraph, targetAgentCount });
        candidates.push({ state: next, metrics });
        if (metrics.score > best.metrics.score) best = { state: next, metrics };
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.metrics.score - a.metrics.score || a.metrics.unmet - b.metrics.unmet);
    beam = candidates.slice(0, Math.max(1, beamWidth)).map((entry) => entry.state);
  }
  return best;
}

function buildAugmentedSlots({ demandGraph, selectedMotifs = [], maxAgents = 6 }) {
  const existing = asArray(demandGraph.nodes);
  const currentCounts = countBy(existing, (slot) => slot.role_id);
  const tagSet = new Set(asArray(demandGraph.tags));
  const workflowRequiresFullLoop = tagSet.has('bounded_loop') || tagSet.has('approval_gate') || asArray(selectedMotifs).some((motif) => /bounded.*watch.*loop|bounded_watch_loop/i.test(String(motif.motif_id || motif.label || '')));
  const additions = [];
  for (const motif of selectedMotifs) {
    for (const slot of asArray(motif.role_slots)) {
      const current = currentCounts.get(slot.role_id) || 0;
      const demanded = demandGraph.role_counts.get(slot.role_id) || 0;
      const hasExactNeed = current < demanded;
      const canAddParallelResearch = slot.role_id === 'researcher'
        && demandGraph.needs_parallel_research
        && current < 2;
      const canAddSynthesizer = slot.role_id === 'synthesizer' && (demandGraph.needs_synthesizer || workflowRequiresFullLoop) && current === 0;
      const canAddReviewer = slot.role_id === 'reviewer' && (demandGraph.needs_reviewer || workflowRequiresFullLoop || asArray(motif.coverage_tags).includes('verification')) && current === 0;
      const canAddWorkflowRole = workflowRequiresFullLoop && ['operator', 'researcher', 'builder', 'reviewer', 'synthesizer'].includes(slot.role_id) && current === 0;
      const shouldAdd = hasExactNeed || canAddParallelResearch || canAddSynthesizer || canAddReviewer || canAddWorkflowRole;
      if (!shouldAdd) continue;
      const augmented = normalizeCapabilitySlot({
        ...slot,
        selection_reason: `graph_librarian:${motif.motif_id}`,
      }, existing.length + additions.length);
      if (!augmented) continue;
      additions.push(augmented);
      currentCounts.set(slot.role_id, current + 1);
      if (existing.length + additions.length >= maxAgents) break;
    }
    if (existing.length + additions.length >= maxAgents) break;
  }
  let combined = [...existing, ...additions].slice(0, maxAgents);
  if (workflowRequiresFullLoop && !combined.some((slot) => slot.role_id === 'reviewer')) {
    const reviewerMotifSlot = asArray(selectedMotifs).flatMap((motif) => asArray(motif.role_slots).map((slot) => ({ ...slot, motif_id: motif.motif_id }))).find((slot) => slot.role_id === 'reviewer');
    if (reviewerMotifSlot) {
      const reviewerSlot = normalizeCapabilitySlot({
        ...reviewerMotifSlot,
        selection_reason: `graph_librarian:${reviewerMotifSlot.motif_id}:required_review_pass`,
      }, combined.length);
      const replaceIndex = combined.findIndex((slot) => slot.role_id === 'synthesizer');
      if (reviewerSlot && replaceIndex >= 0) combined[replaceIndex] = reviewerSlot;
      else if (reviewerSlot && combined.length < maxAgents) combined.push(reviewerSlot);
    }
  }
  return combined.slice(0, maxAgents);
}

function buildSingleModePlan({ demandGraph, preferredRoles = [], motifFeedbackSummary = null } = {}) {
  const roleIds = uniqueRoleIdsFromDemand(demandGraph);
  const preferred = uniq(preferredRoles, { lower: true, max: 8 });
  const primaryRole = preferred.find((role) => roleIds.includes(role)) || roleIds[0] || 'researcher';
  const baseSlot = asArray(demandGraph.nodes).find((slot) => slot.role_id === primaryRole)
    || { role_id: primaryRole, purpose: primaryRole, selection_reason: `execution_mode:${primaryRole}` };
  return {
    ok: true,
    demand_graph: demandGraph,
    beam_width: 1,
    target_agent_count: 1,
    selected_motifs: [],
    selected_motif_ids: [],
    preferred_roles: [primaryRole],
    suggested_candidate_capability_slots: [baseSlot],
    selection_explanations: [
      {
        subject_id: 'team_plan',
        reason: `execution_mode:single_compiled primary_role=${primaryRole}`,
      },
    ],
    planner_metadata: {
      planner_type: 'graph_librarian',
      planning_source: 'execution_mode_single',
      reasoning_summary: [`single_compiled:${primaryRole}`],
      team_synthesis_mode: 'single_compiled',
      selected_motif_ids: [],
      target_agent_count: 1,
      demand_tag_count: demandGraph.tags.length,
      beam_width: 1,
      needs_parallel_research: false,
      motif_feedback_run_count: Number.isFinite(Number(motifFeedbackSummary?.run_count)) ? Number(motifFeedbackSummary.run_count) : 0,
      motif_channel: 'stable',
      registry_motif_count: 0,
    },
  };
}

function uniqueRoleIdsFromDemand(demandGraph = {}) {
  return Array.from(new Set(asArray(demandGraph.nodes).map((slot) => normalizeRole(slot.role_id)).filter(Boolean)));
}

function buildHybridModePlan({ demandGraph, selectedMotifs = [], preferredRoles = [], beamWidth = 2, motifFeedbackSummary = null, motifChannel = 'stable' } = {}) {
  const roleIds = uniqueRoleIdsFromDemand(demandGraph);
  const preferred = uniq(preferredRoles, { lower: true, max: 8 });
  const primaryRole = preferred.find((role) => roleIds.includes(role)) || roleIds[0] || 'researcher';
  const baseSlots = [];
  const primarySlot = asArray(demandGraph.nodes).find((slot) => slot.role_id === primaryRole)
    || { role_id: primaryRole, purpose: primaryRole, selection_reason: `execution_mode:${primaryRole}` };
  baseSlots.push(primarySlot);
  const sidecarRole = demandGraph.needs_reviewer
    ? (roleIds.includes('reviewer') ? 'reviewer' : 'synthesizer')
    : (demandGraph.needs_parallel_research && primaryRole !== 'researcher' ? 'researcher' : (roleIds.includes('synthesizer') && primaryRole !== 'synthesizer' ? 'synthesizer' : ''));
  if (sidecarRole && sidecarRole !== primaryRole) {
    const sidecarSlot = asArray(demandGraph.nodes).find((slot) => slot.role_id === sidecarRole)
      || { role_id: sidecarRole, purpose: sidecarRole, selection_reason: `execution_mode_sidecar:${sidecarRole}` };
    baseSlots.push(sidecarSlot);
  }
  const preferredRoleSet = uniq([...preferred, ...baseSlots.map((slot) => slot.role_id)], { lower: true, max: 16 });
  return {
    ok: true,
    demand_graph: demandGraph,
    beam_width: Math.max(1, beamWidth),
    target_agent_count: Math.min(2, Math.max(1, baseSlots.length)),
    selected_motifs: selectedMotifs.slice(0, 1),
    selected_motif_ids: selectedMotifs.slice(0, 1).map((motif) => motif.motif_id),
    preferred_roles: preferredRoleSet,
    suggested_candidate_capability_slots: baseSlots.slice(0, 2),
    selection_explanations: [
      {
        subject_id: 'team_plan',
        reason: `execution_mode:hybrid_sidecar primary_role=${primaryRole}${sidecarRole ? ` sidecar_role=${sidecarRole}` : ''}`,
      },
    ],
    planner_metadata: {
      planner_type: 'graph_librarian',
      planning_source: 'execution_mode_hybrid',
      reasoning_summary: [`hybrid_sidecar:${[primaryRole, sidecarRole].filter(Boolean).join('→')}`],
      team_synthesis_mode: 'hybrid_sidecar',
      selected_motif_ids: selectedMotifs.slice(0, 1).map((motif) => motif.motif_id),
      target_agent_count: Math.min(2, Math.max(1, baseSlots.length)),
      demand_tag_count: demandGraph.tags.length,
      beam_width: Math.max(1, beamWidth),
      needs_parallel_research: demandGraph.needs_parallel_research,
      motif_feedback_run_count: Number.isFinite(Number(motifFeedbackSummary?.run_count)) ? Number(motifFeedbackSummary.run_count) : 0,
      motif_channel: cleanId(motifChannel || 'stable') === 'candidate' ? 'candidate' : 'stable',
      registry_motif_count: selectedMotifs.length,
    },
  };
}

function summarizeSelectedMotifs(selectedMotifs = []) {
  return asArray(selectedMotifs).map((motif) => `${motif.label} [${motif.role_slots.map((slot) => slot.role_id).join('→')}]`).slice(0, 4);
}

export function planTeamCompositionWithGraphLibrarian({
  goal = '',
  taskInterpretation = null,
  routePlan = null,
  runtimeTeamSnapshot = null,
  motifRegistry = [],
  preferredRoles = [],
  maxAgents = 6,
  beamWidth = 4,
  motifFeedbackSummary = null,
  motifChannel = 'stable',
  executionMode = 'multi_motif',
} = {}) {
  const demandGraph = buildDemandGraph({ goal, taskInterpretation, routePlan, runtimeTeamSnapshot });
  const targetAgentCount = predictTargetAgentCount(demandGraph, { maxAgents });
  const roleDemand = roleDemandSignature(demandGraph.nodes);
  const rankedMotifs = asArray(motifRegistry)
    .filter((motif) => {
      if (!/bounded.*watch.*loop|bounded_watch_loop/i.test(String(motif?.motif_id || motif?.label || ''))) return true;
      return asArray(demandGraph.tags).includes('bounded_loop') || asArray(demandGraph.tags).includes('approval_gate');
    })
    .map((motif) => {
      const motifRoles = motif.role_slots.map((slot) => slot.role_id);
      const overlap = motifRoles.filter((roleId) => demandGraph.role_counts.has(roleId)).length;
      const tagOverlap = asArray(motif.coverage_tags).filter((tag) => demandGraph.tags.includes(tag)).length;
      const matchesTaskType = !motif.task_types?.length || motif.task_types.includes(demandGraph.task_type) || motif.task_types.includes(demandGraph.deliverable_type);
      const roughScore = overlap * 3 + tagOverlap + (matchesTaskType ? 1 : 0) + (Number(motif.default_weight) || 1);
      return { motif, roughScore };
    })
    .filter((entry) => entry.roughScore > 0.5)
    .sort((a, b) => b.roughScore - a.roughScore)
    .slice(0, 10)
    .map((entry) => entry.motif);

  const mode = cleanId(executionMode || 'multi_motif') || 'multi_motif';
  if (mode === 'single_compiled') {
    return buildSingleModePlan({ demandGraph, preferredRoles, motifFeedbackSummary });
  }
  if (mode === 'hybrid_sidecar') {
    const hybridSearch = buildBeamSearch({
      demandGraph,
      motifRegistry: rankedMotifs,
      beamWidth: Math.min(2, Math.max(1, beamWidth)),
      maxDepth: 1,
      targetAgentCount: Math.min(2, Math.max(1, targetAgentCount)),
    });
    return buildHybridModePlan({
      demandGraph,
      selectedMotifs: hybridSearch.state.selected_motifs,
      preferredRoles,
      beamWidth: Math.min(2, Math.max(1, beamWidth)),
      motifFeedbackSummary,
      motifChannel,
    });
  }

  const search = buildBeamSearch({
    demandGraph,
    motifRegistry: rankedMotifs,
    beamWidth,
    maxDepth: Math.min(3, Math.max(1, targetAgentCount)),
    targetAgentCount,
  });

  const selectedMotifs = search.state.selected_motifs;
  const augmentedSlots = buildAugmentedSlots({
    demandGraph,
    selectedMotifs,
    maxAgents: Math.max(1, Math.floor(Number(maxAgents) || 6)),
  });
  const preferredRoleSet = uniq([
    ...asArray(preferredRoles).map((entry) => normalizeRole(entry)).filter(Boolean),
    ...augmentedSlots.map((slot) => slot.role_id),
  ], { lower: true, max: 16 });

  const explanations = [];
  if (selectedMotifs.length > 0) {
    explanations.push({
      subject_id: 'team_plan',
      reason: `graph_librarian:selected_motifs=${selectedMotifs.map((motif) => motif.motif_id).join(',')}`,
    });
  }
  explanations.push({
    subject_id: 'team_plan',
    reason: `graph_librarian:role_demand=${roleDemand || 'none'} target_agents=${targetAgentCount} beam_width=${Math.max(1, beamWidth)}`,
  });
  if (demandGraph.needs_parallel_research && augmentedSlots.filter((slot) => slot.role_id === 'researcher').length >= 2) {
    explanations.push({
      subject_id: 'execution_graph',
      reason: 'graph_librarian:parallel_research_motif_selected',
    });
  }

  return {
    ok: true,
    demand_graph: demandGraph,
    beam_width: Math.max(1, beamWidth),
    target_agent_count: targetAgentCount,
    selected_motifs: selectedMotifs,
    selected_motif_ids: selectedMotifs.map((motif) => motif.motif_id),
    preferred_roles: preferredRoleSet,
    suggested_candidate_capability_slots: augmentedSlots,
    selection_explanations: explanations,
    planner_metadata: {
      planner_type: 'graph_librarian',
      planning_source: 'graph_librarian_beam',
      reasoning_summary: summarizeSelectedMotifs(selectedMotifs),
      team_synthesis_mode: 'graph_librarian',
      selected_motif_ids: selectedMotifs.map((motif) => motif.motif_id),
      target_agent_count: targetAgentCount,
      demand_tag_count: demandGraph.tags.length,
      beam_width: Math.max(1, beamWidth),
      needs_parallel_research: demandGraph.needs_parallel_research,
      motif_feedback_run_count: Number.isFinite(Number(motifFeedbackSummary?.run_count)) ? Number(motifFeedbackSummary.run_count) : 0,
      motif_channel: cleanId(motifChannel || 'stable') === 'candidate' ? 'candidate' : 'stable',
      registry_motif_count: rankedMotifs.length,
    },
  };
}

export function applyGraphLibrarianPlan(taskInterpretation = {}, plan = null) {
  const interpreted = asObject(taskInterpretation);
  const row = asObject(plan);
  const augmentedSlots = asArray(row.suggested_candidate_capability_slots)
    .map((slot, index) => normalizeCapabilitySlot(slot, index))
    .filter(Boolean);
  if (augmentedSlots.length === 0) return interpreted;
  const next = {
    ...interpreted,
    candidate_capability_slots: augmentedSlots,
  };
  if (row.demand_graph?.needs_parallel_research === true) {
    next.parallelism_preference = 'parallel';
  }
  return next;
}
