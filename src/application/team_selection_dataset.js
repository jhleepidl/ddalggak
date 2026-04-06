function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function uniqStrings(values = [], limit = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildCandidateFeatureRow(candidate = {}) {
  const row = asObject(candidate);
  const memoryFit = asObject(row.memory_fit);
  const topology = asObject(row.topology);
  const executable = asObject(row.executable_definition);
  const readiness = asObject(executable.executable_readiness);
  const capability = asObject(executable.capability_contract);
  return {
    template_id: clean(row.template_id || row.blueprint_id) || null,
    task_archetype: clean(row.task_archetype || 'general') || 'general',
    score: asNumber(row.score ?? row.semantic_score ?? 0),
    topology_pattern: clean(topology.pattern) || null,
    participant_count: asNumber(topology.participant_count ?? executable.participant_count ?? executable.member_count ?? 0),
    edge_count: asNumber(topology.edge_count ?? 0),
    surface_count: asNumber(memoryFit.surface_count ?? 0),
    shared_surface_count: asNumber(memoryFit.shared_surface_count ?? 0),
    final_answer_surface_ready: memoryFit.final_answer_surface_ready === true,
    member_count: asNumber(executable.member_count ?? 0),
    role_ids: uniqStrings(executable.role_ids || [], 16),
    ready: readiness.ready === true,
    runtime_bound: capability.runtime_bound === true,
    admission_status: clean(capability.admission_status) || null,
    blocking_reason_codes: uniqStrings(capability.blocking_reason_codes || [], 12),
    degrade_reason_codes: uniqStrings(capability.degrade_reason_codes || [], 12),
    rationale: uniqStrings(row.rationale || [], 12),
  };
}

export function normalizeTeamSelectionEvent(event = {}) {
  const row = asObject(event);
  const recommendation = asObject(row.recommendation);
  const outcome = asObject(row.outcome);
  const candidates = asArray(recommendation.candidates).map((item) => asObject(item));
  const selectedBlueprintId = clean(row.selected_blueprint_id || row.selectedBlueprintId);
  const selected = candidates.find((candidate) => clean(candidate.template_id || candidate.blueprint_id) === selectedBlueprintId) || {};
  const selectedFeatures = buildCandidateFeatureRow(selected);
  const candidateFeatures = candidates.slice(0, 8).map((candidate) => buildCandidateFeatureRow(candidate));
  const taskArchetype = clean(selected.task_archetype || recommendation.task_archetype || outcome.task_archetype || 'general') || 'general';
  return {
    event_id: clean(row.event_id || row.id),
    ts: clean(row.ts || row.created_at || row.createdAt),
    job_id: clean(row.job_id || row.jobId),
    run_id: clean(row.run_id || row.runId),
    task_text: clean(row.task_text || row.taskText),
    selected_blueprint_id: selectedBlueprintId || null,
    task_archetype: taskArchetype,
    candidate_count: candidates.length,
    selected_score: selectedFeatures.score,
    topology_pattern: selectedFeatures.topology_pattern,
    final_answer_surface_ready: selectedFeatures.final_answer_surface_ready,
    memory_surface_count: selectedFeatures.surface_count,
    selected_member_count: selectedFeatures.member_count,
    selected_role_ids: selectedFeatures.role_ids,
    selected_ready: selectedFeatures.ready,
    selected_runtime_bound: selectedFeatures.runtime_bound,
    selected_blocking_reason_codes: selectedFeatures.blocking_reason_codes,
    selected_degrade_reason_codes: selectedFeatures.degrade_reason_codes,
    candidate_features: candidateFeatures,
    input_features: {
      task_text: clean(row.task_text || row.taskText),
      task_archetype: taskArchetype,
      candidate_count: candidates.length,
    },
    selected_features: selectedFeatures,
    outcome_labels: {
      success: outcome.success === true,
      quality_score: asNumber(outcome.quality_score ?? outcome.qualityScore ?? 0),
      token_cost: asNumber(outcome.token_cost ?? outcome.tokenCost ?? 0),
      latency_ms: asNumber(outcome.latency_ms ?? outcome.latencyMs ?? 0),
      human_override: outcome.human_override === true,
      recovery_count: asNumber(outcome.recovery_count ?? outcome.recoveryCount ?? 0),
    },
    success: outcome.success === true,
    quality_score: asNumber(outcome.quality_score ?? outcome.qualityScore ?? 0),
    token_cost: asNumber(outcome.token_cost ?? outcome.tokenCost ?? 0),
    latency_ms: asNumber(outcome.latency_ms ?? outcome.latencyMs ?? 0),
    human_override: outcome.human_override === true,
    recovery_count: asNumber(outcome.recovery_count ?? outcome.recoveryCount ?? 0),
  };
}

export function buildTeamSelectionDataset(events = []) {
  const rows = asArray(events).map((event) => normalizeTeamSelectionEvent(event));
  const archetype_counts = {};
  const success_counts = { success: 0, failure: 0 };
  for (const row of rows) {
    const key = clean(row.task_archetype || 'general') || 'general';
    archetype_counts[key] = (archetype_counts[key] || 0) + 1;
    success_counts[row.success ? 'success' : 'failure'] += 1;
  }
  return {
    kind: 'team_selection_dataset_v1',
    schema_version: 2,
    count: rows.length,
    archetype_counts,
    success_counts,
    rows,
  };
}

export function serializeTeamSelectionDatasetJsonl(events = []) {
  return asArray(events).map((event) => JSON.stringify(normalizeTeamSelectionEvent(event))).join('\n');
}

export function exportTeamSelectionDataset({ tracking = null, jobId = '', limit = 200 } = {}) {
  const cleanJobId = clean(jobId);
  if (!tracking || !cleanJobId) {
    return buildTeamSelectionDataset([]);
  }
  const events = typeof tracking.readTeamSelectionEvents === 'function'
    ? tracking.readTeamSelectionEvents(cleanJobId, limit)
    : (typeof tracking.readRecentTeamSelectionEvents === 'function' ? tracking.readRecentTeamSelectionEvents(cleanJobId, limit) : []);
  return buildTeamSelectionDataset(events);
}
