import { buildRoomSkillDiscoveryBundle } from './room_skill_discovery.js';
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 1200, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen).trim() : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function slugify(value = '', fallback = 'item') {
  const text = cleanText(value || fallback, { maxLen: 160, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function unique(values = [], max = 32) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanText(raw, { maxLen: 160 });
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

function countMatches(text = '', patterns = []) {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

const SIGNAL_PATTERNS = Object.freeze({
  recurring_work: [/매번|계속|자주|반복|기록|로그|추적|관리|history|track|log|again|every/i],
  preference: [/좋아|싫어|별로|선호|취향|피해|avoid|prefer|like|dislike|favorite|restriction|allergy|알레르기/i],
  observation_event: [/먹었|샀|봤|운동|잤|공부|회의|작성|업로드|사진|기록|logged|ate|bought|uploaded|watched|worked/i],
  aggregate_query: [/최근|이번\s*주|지난\s*주|평균|합계|패턴|추세|분석|요약|weekly|monthly|average|sum|trend|pattern|analy/i],
  correction: [/수정|정정|아니라|틀렸|취소|다시|빼줘|추가|correct|actually|instead|wrong|remove|undo/i],
  image_input: [/사진|이미지|업로드|그림|photo|image|picture|screenshot|camera/i],
  external_search: [/근처|주변|지도|검색|식당|가격|영업|장소|주소|nearby|map|search|restaurant|store|open|hours|price/i],
  gateway_need: [/보드|대시보드|표|차트|확인|수정하기 쉽게|입력하기 쉽게|dashboard|board|chart|table|visuali|edit|correct/i],
  database_need: [/DB|RDB|데이터베이스|쿼리|테이블|SQL|분석|통계|database|query|table|analytics|structured/i],
  uncertainty: [/정확|대략|추정|확실|모르겠|확인|estimate|rough|approx|confirm|uncertain|confidence/i],
});

function inferCandidateObjectNames(text = '') {
  const lower = cleanText(text, { lower: true, maxLen: 3000 });
  const candidates = [];
  if (/식사|먹었|메뉴|음식|영양|칼로리|meal|food|nutrition|calorie/.test(lower)) candidates.push('meal_or_intake_event');
  if (/운동|러닝|헬스|걸음|workout|exercise|run|steps/.test(lower)) candidates.push('activity_event');
  if (/지출|결제|샀|구매|영수증|expense|receipt|bought|spent/.test(lower)) candidates.push('spending_event');
  if (/회의|미팅|액션|할 일|todo|meeting|action item|task/.test(lower)) candidates.push('task_or_meeting_item');
  if (/팬픽|캐릭터|설정|줄거리|canon|character|plot|story/.test(lower)) candidates.push('story_or_canon_fact');
  if (/논문|실험|claim|related work|paper|experiment|research/.test(lower)) candidates.push('research_claim_or_experiment');
  if (!candidates.length && countMatches(lower, SIGNAL_PATTERNS.observation_event) > 0) candidates.push('observed_event');
  if (!candidates.length && countMatches(lower, SIGNAL_PATTERNS.preference) > 0) candidates.push('preference_or_constraint');
  return unique(candidates, 8);
}

function inferDomainHints(text = '') {
  const lower = cleanText(text, { lower: true, maxLen: 3000 });
  const hints = [];
  if (/식사|아침|점심|저녁|간식|메뉴|음식|영양|칼로리|restaurant|meal|food|nutrition/.test(lower)) hints.push('meal_or_nutrition_like');
  if (/팬픽|캐릭터|소설|줄거리|canon|character|fiction|story/.test(lower)) hints.push('creative_writing_like');
  if (/논문|실험|research|paper|experiment|related work/.test(lower)) hints.push('research_like');
  if (/코드|패치|테스트|버그|repo|code|patch|test|bug/.test(lower)) hints.push('code_like');
  if (/주식|투자|portfolio|stock|market|finance/.test(lower)) hints.push('finance_like');
  return unique(hints, 8);
}

export function extractRoomLearningSignals({
  text = '',
  command = '',
  workMode = '',
  attachments = [],
  userFeedback = '',
  currentRoom = null,
} = {}) {
  const body = cleanText([text, userFeedback].filter(Boolean).join(' '), { maxLen: 5000 });
  const lower = body.toLowerCase();
  const mediaTypes = asArray(attachments).map((item) => cleanText(asObject(item).mime_type || asObject(item).mimeType || asObject(item).type || '', { lower: true, maxLen: 120 }));
  const hasImageAttachment = mediaTypes.some((type) => type.startsWith('image/')) || countMatches(lower, SIGNAL_PATTERNS.image_input) > 0;
  const patternCounts = Object.fromEntries(Object.entries(SIGNAL_PATTERNS).map(([key, patterns]) => [key, countMatches(lower, patterns)]));
  const objectNames = inferCandidateObjectNames(body);
  const domainHints = inferDomainHints(body);
  const room = asObject(currentRoom);
  const signals = {
    kind: 'room_learning_signal_pack_v1',
    command: cleanText(command, { maxLen: 80 }),
    work_mode: cleanText(workMode, { maxLen: 80 }) || (command === '/loop' ? 'team_loop_task' : command === '/team' ? 'team_task' : 'ask'),
    domain_hints: domainHints,
    candidate_object_types: objectNames,
    repeated_work_signal: patternCounts.recurring_work > 0,
    preference_signal: patternCounts.preference > 0,
    observation_event_signal: patternCounts.observation_event > 0,
    aggregate_query_signal: patternCounts.aggregate_query > 0,
    correction_signal: patternCounts.correction > 0,
    image_input_signal: hasImageAttachment,
    external_search_signal: patternCounts.external_search > 0,
    gateway_need_signal: patternCounts.gateway_need > 0,
    database_need_signal: patternCounts.database_need > 0,
    uncertainty_or_confirmation_signal: patternCounts.uncertainty > 0,
    evidence_counts: patternCounts,
    room_hint: {
      package_id: room.package_id || room.packageId || '',
      domain_label: room.domain_label || room.domainLabel || '',
    },
  };
  return signals;
}

export function buildRoomLearningEvent({
  chatId = '',
  userId = '',
  runId = '',
  command = '',
  text = '',
  workMode = '',
  attachments = [],
  roomPackage = null,
  currentRoom = null,
  source = 'ddalggak_room_evolution',
} = {}) {
  const room = asObject(roomPackage || currentRoom);
  const signals = extractRoomLearningSignals({ text, command, workMode, attachments, currentRoom: room });
  return {
    kind: 'room_learning_event_v1',
    ts: nowIso(),
    source,
    chat_id: String(chatId || ''),
    user_id: String(userId || ''),
    run_id: String(runId || ''),
    event_type: 'room_learning_signal',
    command: cleanText(command, { maxLen: 80 }),
    goal: cleanText(text, { maxLen: 1000 }),
    room: {
      package_id: room.package_id || room.packageId || '',
      domain_label: room.domain_label || room.domainLabel || signals.domain_hints[0] || 'emergent',
      title: room.title || room.name || 'Emergent AI Room',
    },
    signal_pack: signals,
    privacy: {
      local_event_may_include_short_goal: true,
      public_export_includes_raw_text: false,
      private_memory_copied: false,
      uploaded_files_copied: false,
    },
  };
}

function aggregateSignals(events = []) {
  const rows = asArray(events);
  const counts = {
    total_events: rows.length,
    ask_count: 0,
    team_count: 0,
    loop_count: 0,
    repeated_work: 0,
    preference: 0,
    observation_event: 0,
    aggregate_query: 0,
    correction: 0,
    image_input: 0,
    external_search: 0,
    gateway_need: 0,
    database_need: 0,
    confirmation_need: 0,
  };
  const objectCounts = new Map();
  const domainCounts = new Map();
  for (const event of rows) {
    const row = asObject(event);
    const pack = asObject(row.signal_pack || asObject(row.payload).signal_pack || asObject(asObject(row.payload).event).signal_pack);
    const command = cleanText(row.command || pack.command || '', { lower: true, maxLen: 80 });
    const mode = cleanText(pack.work_mode || asObject(row.extra).depth || '', { lower: true, maxLen: 80 });
    if (command === '/ask' || mode === 'ask') counts.ask_count += 1;
    if (command === '/team' || mode === 'team_task') counts.team_count += 1;
    if (command === '/loop' || mode === 'team_loop_task') counts.loop_count += 1;
    if (pack.repeated_work_signal) counts.repeated_work += 1;
    if (pack.preference_signal) counts.preference += 1;
    if (pack.observation_event_signal) counts.observation_event += 1;
    if (pack.aggregate_query_signal) counts.aggregate_query += 1;
    if (pack.correction_signal) counts.correction += 1;
    if (pack.image_input_signal) counts.image_input += 1;
    if (pack.external_search_signal) counts.external_search += 1;
    if (pack.gateway_need_signal) counts.gateway_need += 1;
    if (pack.database_need_signal) counts.database_need += 1;
    if (pack.uncertainty_or_confirmation_signal) counts.confirmation_need += 1;
    for (const obj of asArray(pack.candidate_object_types)) objectCounts.set(obj, (objectCounts.get(obj) || 0) + 1);
    for (const hint of asArray(pack.domain_hints)) domainCounts.set(hint, (domainCounts.get(hint) || 0) + 1);
    const domain = asObject(row.room).domain_label || row.domain_label || '';
    if (domain && domain !== 'general_workbench') domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }
  const topObjects = [...objectCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count }));
  const topDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count }));
  return { counts, top_objects: topObjects, top_domains: topDomains };
}

function confidenceFrom(count = 0, total = 1, boost = 0) {
  const raw = 0.25 + Math.min(0.5, count / Math.max(4, total) * 0.5) + boost;
  return Math.max(0.1, Math.min(0.92, Number(raw.toFixed(2))));
}

function buildSchemaProposal({ objectId = 'observed_event', count = 0, total = 1, needsConfirmation = false } = {}) {
  const localId = slugify(objectId, 'observed_event');
  return {
    kind: 'room_evolution_proposal_v1',
    proposal_type: 'memory_schema',
    proposal_id: `schema:${localId}`,
    status: 'pending_review',
    confidence: confidenceFrom(count, total),
    title: `Create soft memory object: ${localId}`,
    reason_codes: ['repeated_memory_shape_observed', ...(needsConfirmation ? ['uncertain_observation_requires_confirmation'] : [])],
    memory_schema_card: {
      kind: 'memory_schema_proposal_v1',
      schema_name: localId,
      maturity_stage: 'soft_typed_object',
      fields: [
        { name: 'id', type: 'text', required: true },
        { name: 'observed_at', type: 'datetime?', required: false },
        { name: 'summary', type: 'text', required: true },
        { name: 'attributes_json', type: 'json', required: false },
        { name: 'source_ref', type: 'text', required: true },
        { name: 'confidence', type: 'number', required: true },
        { name: 'user_confirmed', type: 'boolean', required: true, default: false },
        { name: 'status', type: 'active|corrected|discarded', required: true, default: 'active' },
      ],
      write_policy: 'proposal_then_user_or_policy_confirm',
      export_policy: { copies_private_memory: false, share_schema_only: true },
    },
  };
}

function buildComponentProposal(type, { reasonCodes = [], confidence = 0.5 } = {}) {
  const specs = {
    image_interpreter: {
      title: 'Add image interpretation agent component',
      role: 'image_interpreter',
      description: 'Interpret uploaded images into uncertain candidate records, then ask for confirmation before persistent memory writes.',
      tool_policy: { allowed_tools: ['vision_model'], external_side_effects: 'none' },
      memory_access: { write_memory_directly: false, allow_propose_update: true },
    },
    local_info_scout: {
      title: 'Add live/local information scout component',
      role: 'local_info_scout',
      description: 'Use approved live search, maps, or local APIs to fetch fresh external facts with TTL and provenance.',
      tool_policy: { allowed_tools: ['web_search', 'maps_or_local_search'], external_side_effects: 'approval_required' },
      memory_access: { write_memory_directly: false, allow_propose_update: true },
    },
    pattern_analyst: {
      title: 'Add pattern analyst component',
      role: 'pattern_analyst',
      description: 'Analyze repeated typed memories using query tools after shadow/canonical materialization is approved.',
      tool_policy: { allowed_tools: ['room_memory_query'], external_side_effects: 'none' },
      memory_access: { write_memory_directly: false, allow_propose_update: true },
    },
    confirmation_clerk: {
      title: 'Add confirmation/correction agent component',
      role: 'confirmation_clerk',
      description: 'Turn uncertain observations into compact confirmation questions and handle user corrections.',
      tool_policy: { allowed_tools: [], external_side_effects: 'none' },
      memory_access: { write_memory_directly: false, allow_propose_update: true },
    },
  };
  const spec = specs[type];
  if (!spec) return null;
  return {
    kind: 'room_evolution_proposal_v1',
    proposal_type: 'agent_component',
    proposal_id: `agent:${spec.role}`,
    status: 'pending_review',
    confidence,
    title: spec.title,
    reason_codes: reasonCodes,
    agent_card: {
      kind: 'room_component_v1',
      component_type: 'agent_card',
      local_id: spec.role,
      title: spec.title,
      role: spec.role,
      description: spec.description,
      memory_access: spec.memory_access,
      tool_policy: spec.tool_policy,
      install_policy: { default_scope: 'borrow_or_install_after_review', can_borrow: true, can_install_resident: true, can_fork: true },
    },
  };
}

function buildMaterializationProposal({ counts = {}, topObjects = [] } = {}) {
  const enoughSignals = counts.database_need > 0 || counts.aggregate_query >= 2 || counts.correction >= 2 || counts.observation_event >= 4;
  if (!enoughSignals) return null;
  return {
    kind: 'room_evolution_proposal_v1',
    proposal_type: 'memory_materialization',
    proposal_id: 'memory:soft_object_to_shadow_store',
    status: 'pending_review',
    confidence: confidenceFrom(counts.aggregate_query + counts.database_need + counts.observation_event, counts.total_events, 0.05),
    title: 'Materialize repeated room memory into a queryable shadow store',
    reason_codes: [
      counts.aggregate_query ? 'aggregate_questions_observed' : '',
      counts.database_need ? 'database_or_query_need_observed' : '',
      counts.correction ? 'corrections_require_editable_records' : '',
    ].filter(Boolean),
    materialization_plan: {
      maturity_stage_from: 'soft_typed_object',
      maturity_stage_to: 'shadow_queryable_store',
      canonical_write: false,
      review_required: true,
      preserves_raw_source_refs: true,
      rollback_supported: true,
      suggested_object_types: topObjects.slice(0, 5).map((row) => row.id),
      store_sequence: ['raw_notes', 'memory_candidates', 'typed_jsonl', 'shadow_table', 'approved_canonical_store'],
    },
  };
}

function buildGatewayProposal({ counts = {}, topObjects = [] } = {}) {
  const need = counts.gateway_need > 0 || counts.correction >= 2 || counts.image_input >= 2 || counts.database_need > 0 || counts.total_events >= 6;
  if (!need) return null;
  return {
    kind: 'room_evolution_proposal_v1',
    proposal_type: 'gateway_or_board',
    proposal_id: 'gateway:room_memory_board',
    status: 'pending_review',
    confidence: confidenceFrom(counts.gateway_need + counts.correction + counts.image_input, counts.total_events, 0.05),
    title: 'Create a room-specific memory board/gateway',
    reason_codes: [
      counts.gateway_need ? 'user_requested_easier_review_or_visualization' : '',
      counts.correction ? 'user_corrections_need_edit_surface' : '',
      counts.image_input ? 'uploads_need_fast_confirmation_surface' : '',
      counts.database_need ? 'queryable_memory_needs_review_surface' : '',
      counts.total_events >= 6 ? 'room_has_enough_repeated_use_for_gateway' : '',
    ].filter(Boolean),
    gateway_spec: {
      kind: 'room_gateway_proposal_v1',
      default_surface: 'goc_room_board',
      capabilities: ['review_memory_candidates', 'correct_records', 'quick_add_entry', 'view_recent_patterns'],
      suggested_object_types: topObjects.slice(0, 5).map((row) => row.id),
      privacy: { local_or_tenant_private_content_only: true, public_package_exports_schema_only: true },
    },
  };
}



function buildRoomEvolutionDecisionPolicy({ counts = {}, proposalCount = 0 } = {}) {
  return {
    kind: 'room_evolution_decision_policy_v1',
    goal: 'avoid uncontrolled self-improvement and room drift',
    auto_apply_allowed: [
      'deduplicate_candidates',
      'refresh_indexes',
      'quarantine_corrupted_context',
      'recompute_package_scores',
    ],
    trial_mode_allowed: [
      'temporary_protocol_addition',
      'temporary_companion_priority_shift',
      'temporary_loop_policy_patch',
      'temporary_projection_budget_change',
    ],
    approval_required: [
      'active_room_package_change',
      'resident_companion_change',
      'durable_memory_schema_change',
      'cross_companion_memory_exchange',
      'new_room_protocol_or_skill_install',
      'risk_policy_relaxation',
    ],
    improvement_signals: [
      'task_completion',
      'artifact_created_or_validated',
      'user_approval_or_low_correction_rate',
      'lower_manual_configuration_burden',
      'fewer_unsafe_or_ungrounded_claims',
      'successful_counterfactual_replay',
    ],
    deterioration_signals: [
      'user_stop_or_repeated_retry',
      'correction_after_memory_use',
      'artifact_missing_or_tests_not_run',
      'room_drift_from_declared_goal',
      'unsafe_or_unverified_claim',
      'higher_latency_without_better_outcome',
    ],
    current_observation: {
      events: counts.total_events || 0,
      proposals: proposalCount,
      enough_for_durable_change: (counts.total_events || 0) >= 6 && proposalCount > 0,
    },
  };
}

export function proposeRoomEvolution({ events = [], roomPackage = null, policy = {} } = {}) {
  const aggregate = aggregateSignals(events);
  const counts = aggregate.counts;
  const proposals = [];
  const minSchemaEvents = Number(asObject(policy).min_schema_events || 2);
  for (const obj of aggregate.top_objects.slice(0, 4)) {
    if (obj.count >= minSchemaEvents || (counts.total_events <= 2 && obj.count >= 1 && counts.observation_event > 0)) {
      proposals.push(buildSchemaProposal({ objectId: obj.id, count: obj.count, total: counts.total_events, needsConfirmation: counts.confirmation_need > 0 || counts.image_input > 0 }));
    }
  }
  if (counts.image_input > 0) proposals.push(buildComponentProposal('image_interpreter', { confidence: confidenceFrom(counts.image_input, counts.total_events, 0.1), reasonCodes: ['image_uploads_or_image_requests_observed', 'image_outputs_must_remain_uncertain_until_confirmed'] }));
  if (counts.external_search > 0) proposals.push(buildComponentProposal('local_info_scout', { confidence: confidenceFrom(counts.external_search, counts.total_events, 0.05), reasonCodes: ['fresh_external_or_local_information_needed', 'facts_need_ttl_and_provenance'] }));
  if (counts.aggregate_query > 0 || counts.database_need > 0) proposals.push(buildComponentProposal('pattern_analyst', { confidence: confidenceFrom(counts.aggregate_query + counts.database_need, counts.total_events), reasonCodes: ['aggregate_or_db_analysis_requests_observed'] }));
  if (counts.confirmation_need > 0 || counts.correction > 0 || counts.image_input > 0) proposals.push(buildComponentProposal('confirmation_clerk', { confidence: confidenceFrom(counts.confirmation_need + counts.correction + counts.image_input, counts.total_events), reasonCodes: ['uncertain_or_corrected_records_need_confirmation_flow'] }));
  const materialization = buildMaterializationProposal({ counts, topObjects: aggregate.top_objects });
  if (materialization) proposals.push(materialization);
  const gateway = buildGatewayProposal({ counts, topObjects: aggregate.top_objects });
  if (gateway) proposals.push(gateway);

  const skillDiscovery = buildRoomSkillDiscoveryBundle({ aggregate, proposals, roomPackage });
  const domain = aggregate.top_domains[0]?.id || asObject(roomPackage).domain_label || 'emergent_room';
  return {
    kind: 'room_evolution_snapshot_v1',
    ts: nowIso(),
    room: {
      package_id: asObject(roomPackage).package_id || asObject(roomPackage).packageId || '',
      domain_label: domain,
      formation_mode: 'emergent_from_interactions',
    },
    maturity: inferMaturityStage(counts),
    aggregate,
    proposals: proposals.filter(Boolean),
    skill_discovery: skillDiscovery,
    room_memory_trial_plan: skillDiscovery.room_memory_schema_trial_plan,
    decision_policy: buildRoomEvolutionDecisionPolicy({ counts, proposalCount: proposals.filter(Boolean).length }),
    governance: {
      ai_role: 'architect_advisor_proposer_not_controller',
      auto_apply: false,
      runtime_validates: true,
      goc_review_required: true,
      private_content_export: 'never_by_default',
      schema_is_dynamic: true,
      canonical_db_write_requires_approval: true,
    },
  };
}

export function inferMaturityStage(counts = {}) {
  if ((counts.database_need || 0) > 0 || (counts.aggregate_query || 0) >= 3) return 'shadow_store_candidate';
  if ((counts.observation_event || 0) >= 3 || (counts.preference || 0) >= 2) return 'soft_typed_memory_candidate';
  if ((counts.total_events || 0) >= 2) return 'room_pattern_observed';
  return 'raw_interaction_only';
}

export function buildPublicRoomEvolutionExport(snapshot = {}) {
  const row = asObject(snapshot);
  const aggregate = asObject(row.aggregate);
  const counts = asObject(aggregate.counts);
  return {
    kind: 'public_room_evolution_signal_v1',
    ts: row.ts || nowIso(),
    room: {
      domain_label: asObject(row.room).domain_label || 'emergent_room',
      formation_mode: 'emergent_from_interactions',
    },
    maturity: row.maturity || 'raw_interaction_only',
    counts: {
      total_events: counts.total_events || 0,
      ask_count: counts.ask_count || 0,
      team_count: counts.team_count || 0,
      loop_count: counts.loop_count || 0,
      image_input: counts.image_input || 0,
      external_search: counts.external_search || 0,
      aggregate_query: counts.aggregate_query || 0,
      database_need: counts.database_need || 0,
      gateway_need: counts.gateway_need || 0,
    },
    top_object_type_labels: asArray(aggregate.top_objects).slice(0, 8).map((item) => asObject(item).id).filter(Boolean),
    proposal_types: unique(asArray(row.proposals).map((proposal) => asObject(proposal).proposal_type), 16),
    privacy: {
      includes_raw_text: false,
      includes_private_memory: false,
      includes_uploaded_files: false,
      includes_location_or_health_records: false,
    },
  };
}

export function formatRoomEvolutionSnapshot(snapshot = {}) {
  const row = asObject(snapshot);
  const aggregate = asObject(row.aggregate);
  const counts = asObject(aggregate.counts);
  const lines = [
    `Room evolution: ${row.maturity || 'raw_interaction_only'}`,
    `- formation: ${asObject(row.room).formation_mode || 'emergent_from_interactions'}`,
    `- events: ${counts.total_events || 0} (ask=${counts.ask_count || 0}, team=${counts.team_count || 0}, loop=${counts.loop_count || 0})`,
  ];
  const topObjects = asArray(aggregate.top_objects).slice(0, 5).map((item) => `${asObject(item).id}(${asObject(item).count})`);
  if (topObjects.length) lines.push(`- candidate memory objects: ${topObjects.join(', ')}`);
  const skillDiscovery = asObject(row.skill_discovery);
  const probeCount = asArray(asObject(skillDiscovery.probe_suite).probes).length;
  if (probeCount) lines.push(`- probe suite: ${probeCount} room-specific probes for schema/component trials`);
  const proposals = asArray(row.proposals).slice(0, 8);
  if (proposals.length) {
    lines.push('- pending proposals:');
    for (const proposal of proposals) lines.push(`  - ${proposal.proposal_type}: ${proposal.title || proposal.proposal_id} · ${proposal.status || 'pending_review'}`);
  }
  const policy = asObject(row.decision_policy);
  if (policy.kind) {
    lines.push(`- improvement guard: approval_required=${asArray(policy.approval_required).slice(0, 3).join(', ')}; trial_allowed=${asArray(policy.trial_mode_allowed).slice(0, 2).join(', ')}`);
  }
  lines.push('- policy: AI proposes; runtime validates; GoC/user approves; private content is not exported.');
  return lines.join('\n');
}
