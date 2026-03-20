function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return v && typeof v === 'object' ? v : {}; }
function clean(v = '') { return String(v || '').trim(); }
function cleanId(v = '') { return clean(v).toLowerCase(); }
function uniq(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = cleanId(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
function includesAny(text = '', terms = []) { return terms.some((term) => text.includes(term)); }

const FAST_DIRECT_TERMS = [
  '바로 답', '바로 대답', '바로 결론', '결론만', '간단히', '짧게', '빠르게', '한 줄',
  '토론 없이', '논쟁 없이', '위원회 없이', '검토 없이', 'review 없이', 'debate 없이',
  'single agent', 'one agent', 'just answer', 'just give me', 'no debate', 'skip debate',
  'skip review', 'single-agent', '단일 에이전트', '한 명만', '한명만', '한 agent', '한 에이전트',
];
const TEMPORARY_TERMS = [
  '이번엔', '이번에는', '지금은', '이번 턴만', '이번 turn만', 'temporarily', 'temporary', 'for now',
  '일단', '우선은', '당장은',
];
const STRUCTURE_EDIT_TERMS = [
  'add agent', 'remove agent', 'replace agent', 'change team', 'change pattern', 'switch pattern',
  '에이전트 추가', '에이전트 제거', '에이전트 교체', '팀 구조', '패턴 바꿔', '패턴 변경', '팀 바꿔',
  'reviewer 빼', 'builder 추가', 'judge 추가', 'router로 바꿔', 'committee로', 'parallel로', 'debate로',
  '/team refine',
];

function findStructure(raw = {}) { return asObject(asObject(raw).structure_v2); }
function participantExecutable(entry = {}) {
  const kind = cleanId(entry.kind || 'agent');
  if (entry.executable === true) return true;
  if (entry.executable === false) return false;
  return ['agent', 'judge', 'workflow_step'].includes(kind);
}
function findParticipants(teamConfig = {}) {
  return asArray(findStructure(teamConfig).participants)
    .map((entry) => asObject(entry))
    .filter((entry) => cleanId(entry.participant_id || entry.id));
}
function chooseDirectTarget(teamConfig = {}) {
  const structure = findStructure(teamConfig);
  const participants = findParticipants(teamConfig).filter(participantExecutable);
  const finalId = cleanId(
    structure?.control_policy?.final_answer_owner_participant_id
    || structure?.topology?.final_participant_id
  );
  const finalParticipant = participants.find((entry) => cleanId(entry.participant_id || entry.id) === finalId);
  if (finalParticipant) return cleanId(finalParticipant.participant_id || finalParticipant.id);
  const preferred = participants.find((entry) => ['synthesizer', 'judge', 'chair', 'reviewer'].includes(cleanId(entry.role)));
  if (preferred) return cleanId(preferred.participant_id || preferred.id);
  return cleanId(participants[0]?.participant_id || participants[0]?.id || '');
}

export function normalizeTemporaryExecutionOverride(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const row = asObject(raw);
  const mode = cleanId(row.mode || row.execution_mode || '');
  if (!mode) return null;
  return {
    mode,
    effective_pattern: cleanId(row.effective_pattern || row.effectivePattern || row.pattern || ''),
    target_participant_ids: uniq(row.target_participant_ids || row.targetParticipantIds || (row.target_participant_id ? [row.target_participant_id] : [])),
    reason: clean(row.reason),
    scope: cleanId(row.scope || 'turn') || 'turn',
    recovery_policy: cleanId(row.recovery_policy || row.recoveryPolicy || 'next_turn_retry') || 'next_turn_retry',
    source_message: clean(row.source_message || row.sourceMessage),
    requested_at: clean(row.requested_at || row.requestedAt) || new Date().toISOString(),
  };
}

export function normalizePatternConflictState(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const row = asObject(raw);
  const classification = cleanId(row.classification || row.type);
  const allowed = ['no_conflict', 'task_override', 'temporary_execution_override', 'structure_override_required'];
  if (!allowed.includes(classification)) return null;
  return {
    classification,
    current_pattern: cleanId(row.current_pattern || row.currentPattern),
    requested_behavior: clean(row.requested_behavior || row.requestedBehavior),
    reason: clean(row.reason),
    suggested_command: clean(row.suggested_command || row.suggestedCommand) || undefined,
    override: normalizeTemporaryExecutionOverride(row.override || row.temporary_execution_override || null),
    detected_at: clean(row.detected_at || row.detectedAt) || new Date().toISOString(),
  };
}

export function normalizePatternRecoveryState(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const row = asObject(raw);
  const status = cleanId(row.status || '');
  if (!status) return null;
  return {
    status,
    original_pattern: cleanId(row.original_pattern || row.originalPattern),
    active_pattern: cleanId(row.active_pattern || row.activePattern),
    recovery_policy: cleanId(row.recovery_policy || row.recoveryPolicy || 'next_turn_retry') || 'next_turn_retry',
    reason: clean(row.reason),
    updated_at: clean(row.updated_at || row.updatedAt) || new Date().toISOString(),
  };
}

export function buildPatternRecoveryState({ originalPattern = '', activePattern = '', reason = '', status = 'temporary_override_active', recoveryPolicy = 'next_turn_retry' } = {}) {
  return normalizePatternRecoveryState({
    status,
    original_pattern: originalPattern,
    active_pattern: activePattern,
    recovery_policy: recoveryPolicy,
    reason,
  });
}

export function detectPatternConflict({ message = '', teamConfig = null } = {}) {
  const cleanMessage = clean(message);
  const lower = cleanMessage.toLowerCase();
  const structure = findStructure(teamConfig || {});
  const currentPattern = cleanId(structure?.topology?.pattern || teamConfig?.composition_mode || 'hybrid') || 'hybrid';
  const hasFastDirect = includesAny(lower, FAST_DIRECT_TERMS.map((term) => term.toLowerCase()));
  const hasTemporary = includesAny(lower, TEMPORARY_TERMS.map((term) => term.toLowerCase()));
  const hasStructureEdit = includesAny(lower, STRUCTURE_EDIT_TERMS.map((term) => term.toLowerCase()));
  const targetParticipantId = chooseDirectTarget(teamConfig || {});

  if (hasStructureEdit && !hasTemporary) {
    return normalizePatternConflictState({
      classification: 'structure_override_required',
      current_pattern: currentPattern,
      requested_behavior: 'team_structure_change',
      reason: '현재 요청이 active team의 participant/pattern 자체 변경을 암시합니다. 실행 중 임시 override보다 /team refine가 더 적합합니다.',
      suggested_command: '/team refine',
    });
  }

  const complexPattern = ['debate', 'committee', 'parallel', 'graph', 'workflow', 'hybrid'].includes(currentPattern);
  if (hasFastDirect && complexPattern) {
    const explicitSingle = includesAny(lower, ['single agent', 'one agent', '단일', '한명', '한 명']);
    return normalizePatternConflictState({
      classification: 'temporary_execution_override',
      current_pattern: currentPattern,
      requested_behavior: explicitSingle ? 'single_agent_direct_answer' : 'direct_answer_without_pattern_overhead',
      reason: '최신 유저 요청이 현재 team pattern보다 빠른 단일/직렬 응답을 우선하도록 요구합니다. active team은 유지하고 이번 turn만 임시 override를 적용합니다.',
      override: {
        mode: explicitSingle ? 'single_agent' : 'direct_answer',
        effective_pattern: explicitSingle ? 'single' : 'sequential',
        target_participant_ids: targetParticipantId ? [targetParticipantId] : [],
        reason: 'latest_user_interrupt_priority',
        scope: 'turn',
        recovery_policy: 'next_turn_retry',
        source_message: cleanMessage,
      },
    });
  }

  if (hasTemporary && complexPattern) {
    return normalizePatternConflictState({
      classification: 'task_override',
      current_pattern: currentPattern,
      requested_behavior: 'temporary_scope_shift',
      reason: '유저가 이번 turn에 한해 응답 형태를 바꾸려는 신호가 있습니다. 팀 구조는 유지하고 routing만 조정합니다.',
    });
  }

  return normalizePatternConflictState({
    classification: 'no_conflict',
    current_pattern: currentPattern,
    requested_behavior: 'none',
    reason: '',
  });
}

function filterEdges(edges = [], allowed = new Set()) {
  return asArray(edges).filter((edge) => {
    const from = cleanId(edge?.from || edge?.from_slot_id || edge?.fromSlotId);
    const to = cleanId(edge?.to || edge?.to_slot_id || edge?.toSlotId);
    return (!from || allowed.has(from)) && (!to || allowed.has(to));
  });
}

function buildFilteredTeamPlan(teamPlan = {}, snapshot = {}, allowedParticipantIds = []) {
  const allowed = new Set(uniq(allowedParticipantIds));
  if (allowed.size === 0) return teamPlan;
  const runtimeAgents = asArray(snapshot.runtime_agents);
  const allowedSlotIds = new Set(
    runtimeAgents
      .filter((agent) => allowed.has(cleanId(agent.participant_id || agent.template_id || agent.slot_id)))
      .map((agent) => cleanId(agent.slot_id || agent.slotId || agent.participant_id || agent.template_id))
      .filter(Boolean)
  );
  const next = { ...asObject(teamPlan) };
  if (Array.isArray(next.roles)) {
    next.roles = next.roles.filter((row) => allowed.has(cleanId(row.id || row.role_id || row.template_id || row.slot_id)) || allowedSlotIds.has(cleanId(row.slot_id)));
  }
  if (Array.isArray(next.slots)) {
    next.slots = next.slots.filter((row) => allowedSlotIds.has(cleanId(row.slot_id || row.slotId)) || allowed.has(cleanId(row.template_id || row.templateId)) || allowed.has(cleanId(row.role_id || row.roleId)));
  }
  if (Array.isArray(next.dependencies)) next.dependencies = filterEdges(next.dependencies, allowedSlotIds);
  if (Array.isArray(next.execution_order)) next.execution_order = next.execution_order.filter((entry) => allowedSlotIds.has(cleanId(entry)) || allowed.has(cleanId(entry)));
  const graph = asObject(next.execution_graph);
  next.execution_graph = {
    ...graph,
    pattern: 'single',
    order: Array.from(allowedSlotIds),
    nodes: asArray(graph.nodes).filter((node) => allowedSlotIds.has(cleanId(node?.slot_id || node?.slotId || node?.participant_id || node?.participantId)) || allowed.has(cleanId(node?.participant_id || node?.participantId))),
    edges: filterEdges(graph.edges, allowedSlotIds),
    final_participant_id: Array.from(allowed)[0] || graph.final_participant_id,
    temporary_execution_override: { active: true, mode: 'single_agent' },
  };
  return next;
}

export function applyTemporaryExecutionOverrideToRuntimeSnapshot(snapshot = null, override = null) {
  const normalizedOverride = normalizeTemporaryExecutionOverride(override);
  if (!snapshot || typeof snapshot !== 'object' || !normalizedOverride) {
    return { runtimeTeamSnapshot: snapshot, runtimeAgents: asArray(snapshot?.runtime_agents), applied: false };
  }
  const original = asObject(snapshot);
  const targetParticipantIds = uniq(normalizedOverride.target_participant_ids);
  const targetSet = new Set(targetParticipantIds);
  const originalAgents = asArray(original.runtime_agents);
  const filteredRuntimeAgents = targetSet.size > 0
    ? originalAgents.filter((agent) => targetSet.has(cleanId(agent.participant_id || agent.template_id || agent.slot_id || agent.slotId)))
    : originalAgents;
  const nextStructure = asObject(original.structure_v2);
  const nextTopology = asObject(nextStructure.topology);
  const runtimeTeamSnapshot = {
    ...original,
    structure_v2: Object.keys(nextStructure).length > 0 ? {
      ...nextStructure,
      topology: {
        ...nextTopology,
        pattern: normalizedOverride.effective_pattern || nextTopology.pattern || original.topology_pattern || 'sequential',
        final_participant_id: targetParticipantIds[0] || nextTopology.final_participant_id,
      },
      runtime_state: {
        ...(asObject(nextStructure.runtime_state)),
        temporary_execution_override: normalizedOverride,
      },
    } : original.structure_v2,
    topology_pattern: normalizedOverride.effective_pattern || original.topology_pattern || 'sequential',
    runtime_agents: filteredRuntimeAgents,
    runtime_participants: targetSet.size > 0 ? asArray(original.runtime_participants).filter((row) => targetSet.has(cleanId(row.participant_id || row.id))) : asArray(original.runtime_participants),
    execution_graph: {
      ...(asObject(original.execution_graph)),
      pattern: normalizedOverride.effective_pattern || cleanId(original.execution_graph?.pattern) || 'sequential',
      execution_mode: normalizedOverride.mode,
      final_participant_id: targetParticipantIds[0] || cleanId(original.execution_graph?.final_participant_id),
      order: filteredRuntimeAgents.map((agent) => cleanId(agent.slot_id || agent.slotId || agent.participant_id || agent.template_id)).filter(Boolean),
      parallel_groups: [],
      temporary_execution_override: normalizedOverride,
    },
    team_plan: normalizedOverride.mode === 'single_agent'
      ? buildFilteredTeamPlan(original.team_plan, original, targetParticipantIds)
      : {
        ...asObject(original.team_plan),
        execution_graph: {
          ...(asObject(original.team_plan?.execution_graph)),
          pattern: normalizedOverride.effective_pattern || cleanId(original.team_plan?.execution_graph?.pattern) || 'sequential',
          temporary_execution_override: normalizedOverride,
          parallel_groups: [],
        },
      },
    temporary_execution_override: normalizedOverride,
  };
  return { runtimeTeamSnapshot, runtimeAgents: filteredRuntimeAgents, applied: true };
}

export function summarizePatternConflictLines(conflict = null) {
  const normalized = normalizePatternConflictState(conflict);
  if (!normalized || normalized.classification === 'no_conflict') return [];
  return [
    `- pattern_conflict: ${normalized.classification}`,
    normalized.current_pattern ? `- current_pattern: ${normalized.current_pattern}` : '',
    normalized.reason ? `- reason: ${normalized.reason}` : '',
    normalized.override?.effective_pattern ? `- temporary_pattern: ${normalized.override.effective_pattern}` : '',
    normalized.override?.target_participant_ids?.length ? `- override_targets: ${normalized.override.target_participant_ids.join(', ')}` : '',
    normalized.suggested_command ? `- suggested_command: ${normalized.suggested_command}` : '',
  ].filter(Boolean);
}

export function inferCompatibilityFallbackState(routePlan = null) {
  const actions = asArray(routePlan?.actions);
  const fallback = actions.some((action) => action?.inputs?.topology_validation_fallback === true || action?.metadata?.topology_validation_fallback === true);
  if (!fallback) return null;
  return buildPatternRecoveryState({
    originalPattern: cleanId(routePlan?.runtime_team_snapshot?.structure_v2?.topology?.pattern || routePlan?.runtime_team_snapshot?.topology_pattern),
    activePattern: cleanId(routePlan?.runtime_team_snapshot?.execution_graph?.pattern || 'sequential'),
    reason: 'topology_validation_fallback',
    status: 'compatibility_fallback',
    recoveryPolicy: 'next_turn_retry',
  });
}
