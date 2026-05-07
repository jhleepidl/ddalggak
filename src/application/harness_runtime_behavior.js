function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value = '', { lower = false, maxLen = 96 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function cleanChannel(value = '', fallback = 'stable') {
  const clean = cleanText(value, { lower: true, maxLen: 32 });
  return clean === 'candidate' ? 'candidate' : fallback;
}

function readChannelOverrides(row = {}, channel = 'stable') {
  const direct = asObject(row[`${channel}_overrides`] || row[`${channel}Overrides`]);
  const nested = asObject(asObject(row.experimental_channels || row.experimentalChannels)[channel]);
  return { ...nested, ...direct };
}

export function resolveHarnessRuntimePolicy(source = null) {
  const row = asObject(source);
  const direct = (
    row.schema_version
    || row.audit_flags
    || row.auditFlags
    || row.tool_policy
    || row.toolPolicy
    || row.approval_policy
    || row.approvalPolicy
    || row.participant_policy
    || row.participantPolicy
    || row.human_interface_policy
    || row.humanInterfacePolicy
    || row.motif_policy
    || row.motifPolicy
    || row.experimental_channels
    || row.experimentalChannels
    || row.delivery_policy
    || row.deliveryPolicy
    || row.runtime_execution
    || row.runtimeExecution
    || row.execution_mode_policy
    || row.executionModePolicy
  ) ? row : null;
  return asObject(
    direct
    || row.runtime_policy
    || row.runtimePolicy
    || row.harnessRuntimePolicy
    || row.harness_runtime_policy
    || row.openharness_runtime_policy
    || row?.openharnessInstallState?.runtime_policy
    || row?.openharness_install_state?.runtime_policy
  );
}

export function readHarnessAuditFlags(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const flags = asObject(policy.audit_flags || policy.auditFlags);
  return {
    timeline_enabled: flags.timeline_enabled !== false && flags.timelineEnabled !== false,
    cross_reference_enabled: flags.cross_reference_enabled !== false && flags.crossReferenceEnabled !== false,
    show_lifecycle: flags.show_lifecycle !== false && flags.showLifecycle !== false,
    show_conflict_history: flags.show_conflict_history !== false && flags.showConflictHistory !== false,
  };
}

export function isHarnessTimelineEnabled(source = null) {
  return readHarnessAuditFlags(source).timeline_enabled;
}

export function isHarnessLifecycleVisible(source = null) {
  const flags = readHarnessAuditFlags(source);
  return flags.timeline_enabled && flags.show_lifecycle;
}

export function isHarnessConflictHistoryEnabled(source = null) {
  const flags = readHarnessAuditFlags(source);
  return flags.timeline_enabled && flags.show_conflict_history;
}

export function isHarnessCrossReferenceEnabled(source = null) {
  return readHarnessAuditFlags(source).cross_reference_enabled;
}

export function readHarnessToolPolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const row = asObject(policy.tool_policy || policy.toolPolicy);
  return {
    tool_rag_enabled: row.tool_rag_enabled !== false && row.toolRagEnabled !== false,
    tool_view_mode: cleanText(row.tool_view_mode || row.toolViewMode || 'task_scoped', { lower: true, maxLen: 64 }) || 'task_scoped',
  };
}

export function isHarnessToolRagEnabled(source = null) {
  return readHarnessToolPolicy(source).tool_rag_enabled;
}

export function readHarnessApprovalPolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const row = asObject(policy.approval_policy || policy.approvalPolicy);
  return {
    deny_feedback_mode: cleanText(row.deny_feedback_mode || row.denyFeedbackMode || 'structured_feedback', { lower: true, maxLen: 64 }) || 'structured_feedback',
    default_escalation: cleanText(row.default_escalation || row.defaultEscalation || 'operator', { lower: true, maxLen: 64 }) || 'operator',
  };
}

export function readHarnessMotifPolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const channels = asObject(policy.experimental_channels || policy.experimentalChannels);
  const row = asObject(policy.motif_policy || policy.motifPolicy);
  const channel = cleanChannel(
    row.channel || row.motif_channel || row.motifChannel || channels.motif_channel || channels.motifChannel || 'stable',
    'stable',
  );
  return {
    channel,
    include_feedback_only: channel === 'candidate',
  };
}

export function readHarnessExecutionModePolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const row = asObject(policy.execution_mode_policy || policy.executionModePolicy);
  return {
    default_mode: cleanText(row.default_mode || row.defaultMode || 'single_compiled', { lower: true, maxLen: 64 }) || 'single_compiled',
    auto_escalation_enabled: row.auto_escalation_enabled !== false && row.autoEscalationEnabled !== false,
    auto_deescalation_enabled: row.auto_deescalation_enabled !== false && row.autoDeescalationEnabled !== false,
    respect_explicit_multi_intent: row.respect_explicit_multi_intent !== false && row.respectExplicitMultiIntent !== false,
    respect_explicit_hybrid_intent: row.respect_explicit_hybrid_intent !== false && row.respectExplicitHybridIntent !== false,
    allow_direct_multi_start: row.allow_direct_multi_start !== false && row.allowDirectMultiStart !== false,
    allow_direct_hybrid_start: row.allow_direct_hybrid_start !== false && row.allowDirectHybridStart !== false,
    respect_task_family_default: row.respect_task_family_default !== false && row.respectTaskFamilyDefault !== false,
    task_family_confidence_threshold: Number.isFinite(Number(row.task_family_confidence_threshold ?? row.taskFamilyConfidenceThreshold))
      ? Math.max(0.4, Math.min(1, Number(row.task_family_confidence_threshold ?? row.taskFamilyConfidenceThreshold)))
      : 0.62,
    decomposability_threshold: Number.isFinite(Number(row.decomposability_threshold ?? row.decomposabilityThreshold))
      ? Math.max(0.5, Math.min(4, Number(row.decomposability_threshold ?? row.decomposabilityThreshold)))
      : 1.8,
    participant_pressure_threshold: Number.isFinite(Number(row.participant_pressure_threshold ?? row.participantPressureThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.participant_pressure_threshold ?? row.participantPressureThreshold))))
      : 3,
    failure_streak_threshold: Number.isFinite(Number(row.failure_streak_threshold ?? row.failureStreakThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.failure_streak_threshold ?? row.failureStreakThreshold))))
      : 1,
    capability_gap_threshold: Number.isFinite(Number(row.capability_gap_threshold ?? row.capabilityGapThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.capability_gap_threshold ?? row.capabilityGapThreshold))))
      : 1,
    followup_burden_threshold: Number.isFinite(Number(row.followup_burden_threshold ?? row.followupBurdenThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.followup_burden_threshold ?? row.followupBurdenThreshold))))
      : 1,
    contradiction_pressure_threshold: Number.isFinite(Number(row.contradiction_pressure_threshold ?? row.contradictionPressureThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.contradiction_pressure_threshold ?? row.contradictionPressureThreshold))))
      : 2,
    quality_gap_threshold: Number.isFinite(Number(row.quality_gap_threshold ?? row.qualityGapThreshold))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.quality_gap_threshold ?? row.qualityGapThreshold))))
      : 1,
    min_quality_health_score: Number.isFinite(Number(row.min_quality_health_score ?? row.minQualityHealthScore))
      ? Math.max(0.1, Math.min(1, Number(row.min_quality_health_score ?? row.minQualityHealthScore)))
      : 0.55,
    success_cooldown_turns: Number.isFinite(Number(row.success_cooldown_turns ?? row.successCooldownTurns))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.success_cooldown_turns ?? row.successCooldownTurns))))
      : 2,
  };
}

export function buildHarnessApprovalGuidance(source = null, { reason = '', requireExplicitApproval = false } = {}) {
  const approval = readHarnessApprovalPolicy(source);
  const lines = [];
  if (requireExplicitApproval) {
    lines.push(`explicit approval required; escalation=${approval.default_escalation}`);
  }
  if (approval.deny_feedback_mode === 'structured_feedback') {
    lines.push(`next step: escalate to ${approval.default_escalation}`);
  }
  if (reason) lines.push(`reason=${String(reason || '').trim()}`);
  return lines.filter(Boolean);
}


export function readHarnessParticipantPolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const baseRow = asObject(policy.participant_policy || policy.participantPolicy);
  const channels = asObject(policy.experimental_channels || policy.experimentalChannels);
  const policyChannel = cleanChannel(
    baseRow.policy_channel || baseRow.policyChannel || channels.participant_policy_channel || channels.participantPolicyChannel || 'stable',
    'stable',
  );
  const row = {
    ...baseRow,
    ...readChannelOverrides(baseRow, policyChannel),
  };
  const allowedTypes = Array.isArray(row.allowed_participant_types || row.allowedParticipantTypes)
    ? (row.allowed_participant_types || row.allowedParticipantTypes).map((entry) => cleanText(entry, { lower: true, maxLen: 64 })).filter(Boolean).slice(0, 16)
    : [];
  const allowedModalities = Array.isArray(row.allowed_modalities || row.allowedModalities)
    ? (row.allowed_modalities || row.allowedModalities).map((entry) => cleanText(entry, { lower: true, maxLen: 32 })).filter(Boolean).slice(0, 8)
    : [];
  const configuredCandidateKinds = Array.isArray(row.surface_candidate_kinds || row.surfaceCandidateKinds)
    ? (row.surface_candidate_kinds || row.surfaceCandidateKinds).map((entry) => cleanText(entry, { lower: true, maxLen: 64 })).filter(Boolean).slice(0, 12)
    : ['critique', 'evidence', 'summary', 'conflict_flag'];
  const candidateKinds = policyChannel === 'candidate'
    ? Array.from(new Set([...configuredCandidateKinds, 'answer_draft', 'question']))
    : configuredCandidateKinds;
  const configuredThreshold = Number.isFinite(Number(row.surface_threshold ?? row.surfaceThreshold))
    ? Math.max(0, Math.min(1, Number(row.surface_threshold ?? row.surfaceThreshold)))
    : 0.82;
  const configuredBudget = Number.isFinite(Number(row.max_surface_per_turn ?? row.maxSurfacePerTurn))
    ? Math.max(0, Math.min(8, Math.floor(Number(row.max_surface_per_turn ?? row.maxSurfacePerTurn))))
    : 1;
  return {
    policy_channel: policyChannel,
    open_participation_enabled: row.open_participation_enabled !== false && row.openParticipationEnabled !== false,
    default_visibility: cleanText(row.default_visibility || row.defaultVisibility || 'internal_only', { lower: true, maxLen: 64 }) || 'internal_only',
    surface_threshold: policyChannel === 'candidate'
      ? Math.max(0.45, configuredThreshold - 0.12)
      : configuredThreshold,
    max_surface_per_turn: policyChannel === 'candidate'
      ? Math.max(1, Math.min(8, configuredBudget + 1))
      : configuredBudget,
    allowed_participant_types: allowedTypes,
    allowed_modalities: allowedModalities,
    surface_candidate_kinds: candidateKinds,
    require_provenance: row.require_provenance !== false && row.requireProvenance !== false,
  };
}

export function readHarnessHumanInterfacePolicy(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  const row = asObject(policy.human_interface_policy || policy.humanInterfacePolicy);
  return {
    human_is_privileged: row.human_is_privileged !== false && row.humanIsPrivileged !== false,
    human_channel: cleanText(row.human_channel || row.humanChannel || 'telegram', { lower: true, maxLen: 64 }) || 'telegram',
    external_contribution_mode: cleanText(row.external_contribution_mode || row.externalContributionMode || 'folded_only', { lower: true, maxLen: 64 }) || 'folded_only',
    reply_only_external_interventions: row.reply_only_external_interventions !== false && row.replyOnlyExternalInterventions !== false,
    always_show_human_messages: row.always_show_human_messages !== false && row.alwaysShowHumanMessages !== false,
    preserve_human_turn_order: row.preserve_human_turn_order !== false && row.preserveHumanTurnOrder !== false,
  };
}
