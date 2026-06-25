function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', { maxLen = 500, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}

function slug(value = '', fallback = 'item') {
  const id = clean(value || fallback, { maxLen: 120, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || fallback;
}

function uniq(values = [], max = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw, { maxLen: 160 });
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function topIds(rows = [], max = 5) {
  return asArray(rows).slice(0, max).map((row) => clean(asObject(row).id || asObject(row).name || '')).filter(Boolean);
}

function countsFromAggregate(aggregate = {}) {
  return asObject(asObject(aggregate).counts);
}

function buildProbeForObject(objectId = 'observed_event', { index = 0, counts = {} } = {}) {
  const id = slug(objectId, 'observed_event');
  const needsConfirmation = Boolean((counts.image_input || 0) > 0 || (counts.confirmation_need || 0) > 0 || (counts.correction || 0) > 0);
  return {
    kind: 'room_probe_task_v1',
    probe_id: `probe:${id}:extract-and-use`,
    target_object_type: id,
    challenge_type: 'memory_schema_utility_probe',
    task_prompt: `Given a future room turn, decide whether a structured ${id} memory object would improve the answer and what fields should be read or updated.`,
    rubric: [
      'identifies the relevant memory object type',
      'uses only room-approved/private context projections',
      'does not copy private memory into exportable package structure',
      needsConfirmation ? 'asks a confirmation question before persistent write' : 'keeps uncertain writes as proposals',
    ],
    difficulty: index === 0 ? 'representative' : 'coverage',
    replay_tags: ['paper4_memory_schema_trial', 'room_specific_probe'],
  };
}

function buildConflictProbe(objectIds = []) {
  return {
    kind: 'room_probe_task_v1',
    probe_id: 'probe:stale-conflicting-memory-rejection',
    target_object_type: objectIds[0] || 'room_memory',
    challenge_type: 'harmful_memory_rejection_probe',
    task_prompt: 'Given stale, corrected, or conflicting room memories, choose which memory objects should be ignored, corrected, or sent to review before use.',
    rubric: [
      'detects stale or corrected memory',
      'does not blindly prefer latest or longest memory',
      'preserves source references and uncertainty',
      'routes risky memory updates to review',
    ],
    difficulty: 'hard_negative',
    replay_tags: ['paper4_harmful_memory_rejection', 'cross_time_replay'],
  };
}

export function buildRoomProbeSuite({ aggregate = {}, proposals = [], roomPackage = null, maxProbes = 6 } = {}) {
  const counts = countsFromAggregate(aggregate);
  const objectIds = topIds(asObject(aggregate).top_objects, 5);
  const schemaProposalIds = asArray(proposals)
    .filter((proposal) => asObject(proposal).proposal_type === 'memory_schema')
    .map((proposal) => clean(asObject(proposal).proposal_id || ''))
    .filter(Boolean);
  const probes = [];
  for (const [index, objectId] of objectIds.entries()) {
    probes.push(buildProbeForObject(objectId, { index, counts }));
    if (probes.length >= maxProbes) break;
  }
  if (probes.length < maxProbes && (counts.correction || counts.confirmation_need || counts.image_input || objectIds.length)) {
    probes.push(buildConflictProbe(objectIds));
  }
  if (probes.length < maxProbes && ((counts.aggregate_query || 0) > 0 || (counts.database_need || 0) > 0)) {
    probes.push({
      kind: 'room_probe_task_v1',
      probe_id: 'probe:projection-vs-shadow-store',
      target_object_type: objectIds[0] || 'room_memory',
      challenge_type: 'materialization_treatment_probe',
      task_prompt: 'Compare whether raw notes, typed JSONL, or a shadow queryable store would best support the next recurring analytic room task.',
      rubric: [
        'selects the lightest sufficient memory treatment',
        'uses shadow store before canonical DB write',
        'requires review before schema migration',
        'reports token/cost versus utility tradeoff',
      ],
      difficulty: 'treatment_selection',
      replay_tags: ['paper4_memory_treatment_ranking', 'materialization_trial'],
    });
  }
  return {
    kind: 'room_probe_suite_v1',
    generation_strategy: 'ctx2skill_inspired_room_probe_generation',
    room_package_id: asObject(roomPackage).package_id || '',
    source_schema_proposals: schemaProposalIds.slice(0, 8),
    probes,
    governance: {
      generated_by_ai: true,
      auto_applies_changes: false,
      used_for_evaluation_and_proposals_only: true,
    },
  };
}

export function buildMemorySchemaTrialPlan({ aggregate = {}, proposals = [], roomPackage = null } = {}) {
  const counts = countsFromAggregate(aggregate);
  const objectTypes = topIds(asObject(aggregate).top_objects, 8);
  const schemaProposals = asArray(proposals).filter((proposal) => asObject(proposal).proposal_type === 'memory_schema');
  return {
    kind: 'paper4_memory_schema_trial_plan_v1',
    title: 'Room Memory Schema Trials',
    research_question: 'Which room-specific memory schema treatment improves future recurring room tasks, under governance and privacy constraints?',
    unit_of_treatment: 'room_specific_memory_package_or_schema_projection',
    candidate_object_types: objectTypes,
    treatments: [
      { id: 'T0_raw_tail', label: 'raw recent chat tail', description: 'Use recent transcript only; no schema.' },
      { id: 'T1_latest_summary', label: 'latest room summary', description: 'Use a compact natural-language summary.' },
      { id: 'T2_soft_typed_objects', label: 'soft typed memory objects', description: 'Use proposed object schemas with source refs and confidence.' },
      { id: 'T3_schema_plus_confirmation', label: 'schema + confirmation flow', description: 'Use typed objects but require confirmation for uncertain writes.' },
      { id: 'T4_shadow_queryable_store', label: 'shadow queryable store', description: 'Materialize approved typed objects into a non-canonical query layer.' },
    ],
    trial_axes: [
      'outcome_utility',
      'harmful_memory_rejection',
      'stale_or_corrected_memory_handling',
      'token_per_quality_gain',
      'user_correction_rate',
      'privacy_boundary_preservation',
      'schema_migration_safety',
    ],
    baselines: [
      'BM25_or_dense_retrieval_over_raw_notes',
      'full_chat_tail_long_context',
      'latest_summary_only',
      'all_memory_in_context',
      'generic_schema_not_room_specific',
      'ctx2skill_style_skill_only_without_memory_schema_treatment',
    ],
    novelty_claims: [
      'Treat memory schema as a room-scoped intervention, not a passive retrieval choice.',
      'Learn schema utility from repeated room traces and user-governed outcomes.',
      'Evaluate memory treatments with generated room probes plus real promote/reject/correction signals.',
      'Separate private memory contents from exportable room package structure.',
      'Study schema migration as a staged lifecycle: notes → candidates → typed JSONL → shadow store → approved canonical DB.',
    ],
    readiness: {
      enough_events_for_trial: Number(counts.total_events || 0) >= 4,
      has_schema_candidates: schemaProposals.length > 0 || objectTypes.length > 0,
      has_analytics_pressure: Boolean((counts.aggregate_query || 0) > 0 || (counts.database_need || 0) > 0),
      room_package_id: asObject(roomPackage).package_id || '',
    },
  };
}

export function buildCrossTimeReplayPlan({ probeSuite = {}, candidateVersions = [] } = {}) {
  const probes = asArray(asObject(probeSuite).probes);
  const versions = asArray(candidateVersions).length
    ? asArray(candidateVersions)
    : [
        { id: 'current_room_package', label: 'Current room package' },
        { id: 'schema_candidate_only', label: 'Schema candidate only' },
        { id: 'schema_plus_agent_candidate', label: 'Schema + agent candidate' },
      ];
  return {
    kind: 'cross_time_replay_plan_v1',
    purpose: 'Evaluate whether proposed room skills/components generalize across representative and hard-negative probes before approval.',
    probes: probes.map((probe) => ({ probe_id: probe.probe_id, challenge_type: probe.challenge_type, replay_tags: probe.replay_tags || [] })),
    candidate_versions: versions,
    selection_rule: 'prefer candidates with robust probe utility, lower memory harm, and lower unnecessary complexity',
    guardrails: [
      'do_not_auto_install_best_candidate',
      'do_not_export_private_memory',
      'require_goc_or_user_approval_for_schema_or_tool_changes',
    ],
  };
}

export function buildRoomSkillDiscoveryBundle({
  aggregate = {},
  proposals = [],
  roomPackage = null,
  candidateVersions = [],
} = {}) {
  const probeSuite = buildRoomProbeSuite({ aggregate, proposals, roomPackage });
  const paper4TrialPlan = buildMemorySchemaTrialPlan({ aggregate, proposals, roomPackage });
  const replayPlan = buildCrossTimeReplayPlan({ probeSuite, candidateVersions });
  const skillCards = [];
  const objectTypes = topIds(asObject(aggregate).top_objects, 3);
  if (objectTypes.length) {
    skillCards.push({
      kind: 'room_evolution_proposal_v1',
      proposal_type: 'skill_card',
      proposal_id: `skill:use-${slug(objectTypes[0])}-memory-safely`,
      status: 'pending_review',
      confidence: 0.68,
      title: `Use ${objectTypes[0]} memory safely`,
      skill_card: {
        kind: 'room_skill_card_v1',
        skill_id: `use_${slug(objectTypes[0])}_memory_safely`,
        description: `When a turn depends on ${objectTypes[0]} memory, read only the target-room projection, preserve uncertainty, and propose writes for review.`,
        applies_to_object_types: objectTypes,
        procedure: [
          'identify the relevant room memory object type',
          'read the smallest sufficient projection',
          'check source refs, corrections, and confidence',
          'ask a confirmation question if the observation is uncertain',
          'return memory updates as proposals only',
        ],
        export_policy: { share_skill_text_only: true, copies_private_memory: false },
      },
    });
  }
  return {
    kind: 'room_skill_discovery_bundle_v1',
    ts: nowIso(),
    inspiration: 'ctx2skill_style_probe_reason_judge_propose_loop_adapted_to_user_governed_ai_rooms',
    scope: 'room_evolution_proposals_only',
    probe_suite: probeSuite,
    skill_proposals: skillCards,
    paper4_memory_schema_trial_plan: paper4TrialPlan,
    cross_time_replay_plan: replayPlan,
    governance: {
      ai_generates_probes_and_proposals: true,
      runtime_validates: true,
      goc_or_user_approves: true,
      direct_memory_write: false,
      private_memory_export: false,
    },
  };
}
