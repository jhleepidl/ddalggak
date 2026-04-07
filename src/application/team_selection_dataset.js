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
    append_only_surface_count: asNumber(memoryFit.append_only_surface_count ?? 0),
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

function buildSelectedCandidateLookup({ row = {}, recommendation = {}, candidates = [] } = {}) {
  const record = asObject(row);
  const rec = asObject(recommendation);
  const selectedBlueprintId = clean(record.selected_blueprint_id || record.selectedBlueprintId) || null;
  const selectedSnapshot = asObject(record.selected_candidate_snapshot || rec.selected_candidate_snapshot);
  const selectedById = selectedBlueprintId
    ? candidates.find((candidate) => clean(candidate.template_id || candidate.blueprint_id) === selectedBlueprintId) || null
    : null;
  const snapshotId = clean(selectedSnapshot.template_id || selectedSnapshot.blueprint_id) || null;
  const inferredId = selectedBlueprintId || snapshotId || null;
  const selectedCandidate = selectedById || (snapshotId ? selectedSnapshot : null);
  const selectedFound = !!selectedCandidate && (!selectedBlueprintId || clean(selectedCandidate.template_id || selectedCandidate.blueprint_id) === selectedBlueprintId || snapshotId === selectedBlueprintId);
  return {
    selectedBlueprintId: inferredId,
    selectedCandidate,
    selectedCandidateFound: selectedFound,
    selectedCandidateSource: selectedById ? 'recommendation_candidates' : (snapshotId ? 'selected_candidate_snapshot' : null),
  };
}

export function normalizeTeamSelectionEvent(event = {}) {
  const row = asObject(event);
  const recommendation = asObject(row.recommendation);
  const outcome = asObject(row.outcome);
  const candidates = asArray(recommendation.candidates).map((item) => asObject(item));
  const {
    selectedBlueprintId,
    selectedCandidate,
    selectedCandidateFound,
    selectedCandidateSource,
  } = buildSelectedCandidateLookup({ row, recommendation, candidates });
  const selectedFeatures = selectedCandidateFound ? buildCandidateFeatureRow(selectedCandidate) : null;
  const candidateFeatures = candidates.slice(0, 8).map((candidate) => buildCandidateFeatureRow(candidate));
  const taskArchetype = clean(
    (selectedCandidateFound ? selectedCandidate.task_archetype : '')
      || recommendation.task_archetype
      || candidates[0]?.task_archetype
      || outcome.task_archetype
      || 'general'
  ) || 'general';
  const exclusionReasons = [];
  if (!selectedBlueprintId) exclusionReasons.push('missing_selected_blueprint_id');
  if (selectedBlueprintId && !selectedCandidateFound) exclusionReasons.push('selected_candidate_not_in_recommendation');
  if (candidateFeatures.length === 0) exclusionReasons.push('missing_recommendation_candidates');
  const trainingEligible = exclusionReasons.length === 0;
  const qualityScore = asNumber(outcome.quality_score ?? outcome.qualityScore ?? 0);
  const tokenCost = asNumber(outcome.token_cost ?? outcome.tokenCost ?? 0);
  const latencyMs = asNumber(outcome.latency_ms ?? outcome.latencyMs ?? 0);
  const recoveryCount = asNumber(outcome.recovery_count ?? outcome.recoveryCount ?? 0);
  const approvalFriction = asNumber(outcome.approval_friction ?? outcome.approvalFriction ?? 0);
  const artifactQuality = asNumber(outcome.artifact_quality ?? outcome.artifactQuality ?? qualityScore);
  const memoryFitFailure = outcome.memory_fit_failure === true || outcome.memoryFitFailure === true;
  const humanOverrideReason = clean(outcome.human_override_reason || outcome.humanOverrideReason) || null;
  return {
    event_id: clean(row.event_id || row.id),
    ts: clean(row.ts || row.created_at || row.createdAt),
    job_id: clean(row.job_id || row.jobId),
    run_id: clean(row.run_id || row.runId),
    task_text: clean(row.task_text || row.taskText),
    selected_blueprint_id: selectedBlueprintId || null,
    selected_candidate_found: selectedCandidateFound,
    selected_candidate_source: selectedCandidateSource,
    task_archetype: taskArchetype,
    candidate_count: candidates.length,
    training_eligible: trainingEligible,
    exclusion_reasons: exclusionReasons,
    selected_score: selectedFeatures ? selectedFeatures.score : null,
    topology_pattern: selectedFeatures ? selectedFeatures.topology_pattern : null,
    final_answer_surface_ready: selectedFeatures ? selectedFeatures.final_answer_surface_ready : null,
    memory_surface_count: selectedFeatures ? selectedFeatures.surface_count : null,
    selected_member_count: selectedFeatures ? selectedFeatures.member_count : null,
    selected_role_ids: selectedFeatures ? selectedFeatures.role_ids : [],
    selected_ready: selectedFeatures ? selectedFeatures.ready : null,
    selected_runtime_bound: selectedFeatures ? selectedFeatures.runtime_bound : null,
    selected_blocking_reason_codes: selectedFeatures ? selectedFeatures.blocking_reason_codes : [],
    selected_degrade_reason_codes: selectedFeatures ? selectedFeatures.degrade_reason_codes : [],
    candidate_features: candidateFeatures,
    input_features: {
      task_text: clean(row.task_text || row.taskText),
      task_archetype: taskArchetype,
      candidate_count: candidates.length,
    },
    selected_features: selectedFeatures,
    outcome_labels: {
      success: outcome.success === true,
      quality_score: qualityScore,
      artifact_quality: artifactQuality,
      token_cost: tokenCost,
      latency_ms: latencyMs,
      human_override: outcome.human_override === true,
      human_override_reason: humanOverrideReason,
      recovery_count: recoveryCount,
      approval_friction: approvalFriction,
      memory_fit_failure: memoryFitFailure,
    },
    success: outcome.success === true,
    quality_score: qualityScore,
    artifact_quality: artifactQuality,
    token_cost: tokenCost,
    latency_ms: latencyMs,
    human_override: outcome.human_override === true,
    human_override_reason: humanOverrideReason,
    recovery_count: recoveryCount,
    approval_friction: approvalFriction,
    memory_fit_failure: memoryFitFailure,
  };
}

export function buildTeamSelectionDataset(events = []) {
  const rows = asArray(events).map((event) => normalizeTeamSelectionEvent(event));
  const archetype_counts = {};
  const success_counts = { success: 0, failure: 0 };
  const eligibility_counts = { eligible: 0, excluded: 0 };
  const exclusion_reason_counts = {};
  for (const row of rows) {
    const key = clean(row.task_archetype || 'general') || 'general';
    archetype_counts[key] = (archetype_counts[key] || 0) + 1;
    success_counts[row.success ? 'success' : 'failure'] += 1;
    eligibility_counts[row.training_eligible ? 'eligible' : 'excluded'] += 1;
    for (const reason of asArray(row.exclusion_reasons)) {
      const code = clean(reason);
      if (!code) continue;
      exclusion_reason_counts[code] = (exclusion_reason_counts[code] || 0) + 1;
    }
  }
  return {
    kind: 'team_selection_dataset_v1',
    schema_version: 3,
    count: rows.length,
    eligible_count: eligibility_counts.eligible,
    excluded_count: eligibility_counts.excluded,
    archetype_counts,
    success_counts,
    exclusion_reason_counts,
    rows,
  };
}

export function serializeTeamSelectionDatasetJsonl(events = []) {
  return asArray(events)
    .map((event) => normalizeTeamSelectionEvent(event))
    .filter((row) => row.training_eligible !== false)
    .map((row) => JSON.stringify(row))
    .join('\n');
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
