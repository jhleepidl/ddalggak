import crypto from 'node:crypto';

export const OPENHARNESS_PACKAGE_SCHEMA_VERSION = 'openharness.package/v1';
export const OPENHARNESS_RUN_TRACE_SCHEMA_VERSION = 'openharness.run_trace/v1';
export const OPENHARNESS_RUN_SYNC_SCHEMA_VERSION = 'openharness.run_sync/v1';
export const OPENHARNESS_RUNTIME_POLICY_SCHEMA_VERSION = 'openharness.runtime_policy/v1';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 256 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function cleanId(value = '', { maxLen = 128 } = {}) {
  return cleanText(value, { lower: true, maxLen })
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function uniqTextList(values = [], { lower = false, limit = 32, maxLen = 96 } = {}) {
  const rows = Array.isArray(values) ? values : (typeof values === 'string' ? [values] : []);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const value = cleanText(row, { lower, maxLen });
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  return Boolean(value);
}

function cleanRatio(value, fallback = 0.35) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(num, 1));
}

function normalizeHarnessRuntimeExecution(raw = {}) {
  const row = asObject(raw);
  return {
    checkpointing: asObject(row.checkpointing || row.checkpoints),
    continuous_improvement: asObject(row.continuous_improvement || row.continuousImprovement),
    approval_matrix: asObject(row.approval_matrix || row.approvalMatrix),
    providers: asObject(row.providers || row.provider_policies || row.providerPolicies),
  };
}

export function normalizeHarnessRuntimePolicy(raw = {}, { fallbackPackage = null } = {}) {
  const row = asObject(raw);
  const fallbackPkg = asObject(fallbackPackage);
  const nested = asObject(row.runtime_policy || row.runtimePolicy);
  const harnessSummary = asObject(row.harness_summary || row.harnessSummary || fallbackPkg.harness_summary || fallbackPkg.harnessSummary);
  const harnessSpec = asObject(row.harness_spec || row.harnessSpec || fallbackPkg.harness_spec || fallbackPkg.harnessSpec);
  const teamManifest = asObject(row.team_manifest || row.teamManifest || fallbackPkg.team_manifest || fallbackPkg.teamManifest);
  const manifestTeam = asObject(teamManifest.team);
  const deliveryPolicy = asObject(nested.delivery_policy || nested.deliveryPolicy || harnessSummary.delivery_policy || harnessSummary.deliveryPolicy);
  const resolvedRoleDelivery = asObject(nested.resolved_role_delivery || nested.resolvedRoleDelivery || harnessSummary.resolved_role_delivery || harnessSummary.resolvedRoleDelivery);
  const auditFlags = asObject(nested.audit_flags || nested.auditFlags || harnessSummary.audit_flags || harnessSummary.auditFlags);
  const toolPolicyRaw = asObject(nested.tool_policy || nested.toolPolicy || harnessSpec.tool_policy || harnessSpec.toolPolicy);
  const approvalPolicyRaw = asObject(nested.approval_policy || nested.approvalPolicy || harnessSpec.approval_policy || harnessSpec.approvalPolicy);
  const participantPolicyRaw = asObject(nested.participant_policy || nested.participantPolicy || harnessSpec.participant_policy || harnessSpec.participantPolicy);
  const humanInterfacePolicyRaw = asObject(nested.human_interface_policy || nested.humanInterfacePolicy || harnessSpec.human_interface_policy || harnessSpec.humanInterfacePolicy);
  const executionModePolicyRaw = asObject(nested.execution_mode_policy || nested.executionModePolicy || harnessSpec.execution_mode_policy || harnessSpec.executionModePolicy);
  const runtimeExecutionRaw = nested.runtime_execution || nested.runtimeExecution || manifestTeam.runtime_execution || manifestTeam.runtimeExecution || teamManifest.runtime_execution || teamManifest.runtimeExecution || {};
  return {
    schema_version: OPENHARNESS_RUNTIME_POLICY_SCHEMA_VERSION,
    delivery_policy: {
      default_delivery_mode: cleanText(deliveryPolicy.default_delivery_mode || deliveryPolicy.defaultDeliveryMode || 'compression_plus_appendix', { lower: true, maxLen: 64 }) || 'compression_plus_appendix',
      appendix_char_budget_ratio: cleanRatio(deliveryPolicy.appendix_char_budget_ratio ?? deliveryPolicy.appendixCharBudgetRatio, 0.35),
      default_budget_tier: cleanText(deliveryPolicy.default_budget_tier || deliveryPolicy.defaultBudgetTier || 'medium', { lower: true, maxLen: 32 }) || 'medium',
      default_risk_level: cleanText(deliveryPolicy.default_risk_level || deliveryPolicy.defaultRiskLevel || 'standard', { lower: true, maxLen: 32 }) || 'standard',
      projection_appendix_enabled_by_default: cleanBoolean(deliveryPolicy.projection_appendix_enabled_by_default ?? deliveryPolicy.projectionAppendixEnabledByDefault, true),
    },
    resolved_role_delivery: resolvedRoleDelivery,
    audit_flags: {
      timeline_enabled: cleanBoolean(auditFlags.timeline_enabled ?? auditFlags.timelineEnabled, true),
      cross_reference_enabled: cleanBoolean(auditFlags.cross_reference_enabled ?? auditFlags.crossReferenceEnabled, true),
      show_lifecycle: cleanBoolean(auditFlags.show_lifecycle ?? auditFlags.showLifecycle, true),
      show_conflict_history: cleanBoolean(auditFlags.show_conflict_history ?? auditFlags.showConflictHistory, true),
    },
    tool_policy: {
      tool_rag_enabled: cleanBoolean(toolPolicyRaw.tool_rag_enabled ?? toolPolicyRaw.toolRagEnabled, true),
      tool_view_mode: cleanText(toolPolicyRaw.tool_view_mode || toolPolicyRaw.toolViewMode || 'task_scoped', { lower: true, maxLen: 64 }) || 'task_scoped',
    },
    approval_policy: {
      deny_feedback_mode: cleanText(approvalPolicyRaw.deny_feedback_mode || approvalPolicyRaw.denyFeedbackMode || 'structured_feedback', { lower: true, maxLen: 64 }) || 'structured_feedback',
      default_escalation: cleanText(approvalPolicyRaw.default_escalation || approvalPolicyRaw.defaultEscalation || 'operator', { lower: true, maxLen: 64 }) || 'operator',
    },
    participant_policy: {
      open_participation_enabled: cleanBoolean(participantPolicyRaw.open_participation_enabled ?? participantPolicyRaw.openParticipationEnabled, true),
      default_visibility: cleanText(participantPolicyRaw.default_visibility || participantPolicyRaw.defaultVisibility || 'internal_only', { lower: true, maxLen: 64 }) || 'internal_only',
      surface_threshold: cleanRatio(participantPolicyRaw.surface_threshold ?? participantPolicyRaw.surfaceThreshold, 0.82),
      max_surface_per_turn: Math.max(0, Math.min(8, Math.floor(Number(participantPolicyRaw.max_surface_per_turn ?? participantPolicyRaw.maxSurfacePerTurn) || 1))),
      allowed_participant_types: uniqTextList(participantPolicyRaw.allowed_participant_types || participantPolicyRaw.allowedParticipantTypes || [], { lower: true, limit: 16, maxLen: 64 }),
      allowed_modalities: uniqTextList(participantPolicyRaw.allowed_modalities || participantPolicyRaw.allowedModalities || [], { lower: true, limit: 8, maxLen: 32 }),
      surface_candidate_kinds: uniqTextList(participantPolicyRaw.surface_candidate_kinds || participantPolicyRaw.surfaceCandidateKinds || ['critique', 'evidence', 'summary', 'conflict_flag'], { lower: true, limit: 12, maxLen: 64 }),
      require_provenance: cleanBoolean(participantPolicyRaw.require_provenance ?? participantPolicyRaw.requireProvenance, true),
    },
    human_interface_policy: {
      human_is_privileged: cleanBoolean(humanInterfacePolicyRaw.human_is_privileged ?? humanInterfacePolicyRaw.humanIsPrivileged, true),
      human_channel: cleanText(humanInterfacePolicyRaw.human_channel || humanInterfacePolicyRaw.humanChannel || 'telegram', { lower: true, maxLen: 64 }) || 'telegram',
      external_contribution_mode: cleanText(humanInterfacePolicyRaw.external_contribution_mode || humanInterfacePolicyRaw.externalContributionMode || 'folded_only', { lower: true, maxLen: 64 }) || 'folded_only',
      reply_only_external_interventions: cleanBoolean(humanInterfacePolicyRaw.reply_only_external_interventions ?? humanInterfacePolicyRaw.replyOnlyExternalInterventions, true),
      always_show_human_messages: cleanBoolean(humanInterfacePolicyRaw.always_show_human_messages ?? humanInterfacePolicyRaw.alwaysShowHumanMessages, true),
      preserve_human_turn_order: cleanBoolean(humanInterfacePolicyRaw.preserve_human_turn_order ?? humanInterfacePolicyRaw.preserveHumanTurnOrder, true),
    },
    execution_mode_policy: {
      default_mode: cleanText(executionModePolicyRaw.default_mode || executionModePolicyRaw.defaultMode || 'single_compiled', { lower: true, maxLen: 64 }) || 'single_compiled',
      auto_escalation_enabled: cleanBoolean(executionModePolicyRaw.auto_escalation_enabled ?? executionModePolicyRaw.autoEscalationEnabled, true),
      auto_deescalation_enabled: cleanBoolean(executionModePolicyRaw.auto_deescalation_enabled ?? executionModePolicyRaw.autoDeescalationEnabled, true),
      respect_explicit_multi_intent: cleanBoolean(executionModePolicyRaw.respect_explicit_multi_intent ?? executionModePolicyRaw.respectExplicitMultiIntent, true),
      respect_explicit_hybrid_intent: cleanBoolean(executionModePolicyRaw.respect_explicit_hybrid_intent ?? executionModePolicyRaw.respectExplicitHybridIntent, true),
      allow_direct_multi_start: cleanBoolean(executionModePolicyRaw.allow_direct_multi_start ?? executionModePolicyRaw.allowDirectMultiStart, true),
      allow_direct_hybrid_start: cleanBoolean(executionModePolicyRaw.allow_direct_hybrid_start ?? executionModePolicyRaw.allowDirectHybridStart, true),
      respect_task_family_default: cleanBoolean(executionModePolicyRaw.respect_task_family_default ?? executionModePolicyRaw.respectTaskFamilyDefault, true),
      task_family_confidence_threshold: Math.max(0.4, Math.min(1, Number(executionModePolicyRaw.task_family_confidence_threshold ?? executionModePolicyRaw.taskFamilyConfidenceThreshold) || 0.62)),
      decomposability_threshold: Math.max(0.5, Math.min(4, Number(executionModePolicyRaw.decomposability_threshold ?? executionModePolicyRaw.decomposabilityThreshold) || 1.8)),
      participant_pressure_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.participant_pressure_threshold ?? executionModePolicyRaw.participantPressureThreshold) || 3))),
      failure_streak_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.failure_streak_threshold ?? executionModePolicyRaw.failureStreakThreshold) || 1))),
      capability_gap_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.capability_gap_threshold ?? executionModePolicyRaw.capabilityGapThreshold) || 1))),
      followup_burden_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.followup_burden_threshold ?? executionModePolicyRaw.followupBurdenThreshold) || 1))),
      contradiction_pressure_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.contradiction_pressure_threshold ?? executionModePolicyRaw.contradictionPressureThreshold) || 2))),
      quality_gap_threshold: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.quality_gap_threshold ?? executionModePolicyRaw.qualityGapThreshold) || 1))),
      min_quality_health_score: Math.max(0.1, Math.min(1, Number(executionModePolicyRaw.min_quality_health_score ?? executionModePolicyRaw.minQualityHealthScore) || 0.55)),
      success_cooldown_turns: Math.max(1, Math.min(8, Math.floor(Number(executionModePolicyRaw.success_cooldown_turns ?? executionModePolicyRaw.successCooldownTurns) || 2))),
    },
    runtime_execution: normalizeHarnessRuntimeExecution(runtimeExecutionRaw),
  };
}

export function stableObjectHash(value = null, { length = 16 } = {}) {
  const encoded = JSON.stringify(value, Object.keys(asObject(value)).sort());
  return crypto.createHash('sha1').update(encoded || 'null').digest('hex').slice(0, Math.max(8, length));
}

function stableStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return null;
      seen.add(val);
      if (Array.isArray(val)) return val;
      return Object.keys(val).sort().reduce((acc, itemKey) => {
        acc[itemKey] = val[itemKey];
        return acc;
      }, {});
    }
    return val;
  });
}

export function stableJsonHash(value = null, { length = 16 } = {}) {
  const encoded = stableStringify(value);
  return crypto.createHash('sha1').update(encoded || 'null').digest('hex').slice(0, Math.max(8, length));
}

function unwrapPackageEnvelope(raw = {}) {
  const row = asObject(raw);
  const nested = row.package || row.harness_package || row.data;
  return nested && typeof nested === 'object' ? asObject(nested) : row;
}

export function buildHarnessPackageHashInput(raw = {}) {
  const row = unwrapPackageEnvelope(raw);
  const metadata = asObject(row.metadata);
  const harnessSummary = asObject(row.harness_summary || row.harnessSummary);
  const sharing = asObject(row.sharing);
  const compatibility = asObject(row.compatibility);
  const harnessSpec = asObject(row.harness_spec || row.harnessSpec);
  const teamManifest = asObject(row.team_manifest || row.teamManifest);
  const skillPackages = asArray(row.skill_packages || row.skillPackages).filter((item) => item && typeof item === 'object');

  return {
    schema_version: OPENHARNESS_PACKAGE_SCHEMA_VERSION,
    kind: 'openharness_package',
    metadata: {
      name: cleanText(metadata.name || harnessSummary.name || row.name || 'OpenHarness Package', { maxLen: 160 }) || 'OpenHarness Package',
      description: cleanText(metadata.description || harnessSummary.description || row.description || '', { maxLen: 512 }) || undefined,
      visibility: cleanText(metadata.visibility || harnessSummary.visibility || 'workspace', { lower: true, maxLen: 64 }) || 'workspace',
      tags: uniqTextList(metadata.tags || harnessSummary.tags || [], { lower: true, limit: 16, maxLen: 48 }),
    },
    compatibility: {
      runner: cleanText(compatibility.runner || 'ddalggak', { lower: true, maxLen: 64 }) || 'ddalggak',
      observability: cleanText(compatibility.observability || 'goc', { lower: true, maxLen: 64 }) || 'goc',
      install_target: cleanText(compatibility.install_target || compatibility.installTarget || teamManifest?.compatibility?.install_target || 'thread_team_config', { lower: true, maxLen: 96 }) || 'thread_team_config',
      ddalggak: compatibility.ddalggak !== false,
      goc: compatibility.goc !== false,
    },
    sharing: {
      shareable: sharing.shareable !== false,
      exportable: sharing.exportable !== false,
    },
    execution_binding: {
      runner_mode: 'local_execution',
      observability_mode: 'goc_sync',
      install_target: cleanText(compatibility.install_target || compatibility.installTarget || teamManifest?.compatibility?.install_target || 'thread_team_config', { lower: true, maxLen: 96 }) || 'thread_team_config',
    },
    trace_contract: {
      schema_version: OPENHARNESS_RUN_TRACE_SCHEMA_VERSION,
      transport: cleanText(row.trace_contract?.transport || row.traceContract?.transport || 'goc_execution_graph', { lower: true, maxLen: 64 }) || 'goc_execution_graph',
      storage: cleanText(row.trace_contract?.storage || row.traceContract?.storage || 'runtime_events_jsonl', { lower: true, maxLen: 64 }) || 'runtime_events_jsonl',
    },
    sync_contract: {
      schema_version: OPENHARNESS_RUN_SYNC_SCHEMA_VERSION,
      mode: cleanText(row.sync_contract?.mode || row.syncContract?.mode || 'ddalggak_push_goc_observe', { lower: true, maxLen: 96 }) || 'ddalggak_push_goc_observe',
      direction: cleanText(row.sync_contract?.direction || row.syncContract?.direction || 'ddalggak_to_goc', { lower: true, maxLen: 64 }) || 'ddalggak_to_goc',
      semantics: cleanText(row.sync_contract?.semantics || row.syncContract?.semantics || 'append_only', { lower: true, maxLen: 64 }) || 'append_only',
    },
    runtime_policy: normalizeHarnessRuntimePolicy(row, { fallbackPackage: row }),
    harness_spec: harnessSpec,
    harness_summary: harnessSummary,
    team_manifest: teamManifest,
    skill_packages: skillPackages,
  };
}

export function normalizeHarnessPackage(raw = {}) {
  const row = unwrapPackageEnvelope(raw);
  const metadata = asObject(row.metadata);
  const teamManifest = asObject(row.team_manifest || row.teamManifest);
  const hashInput = buildHarnessPackageHashInput(row);

  const packageBody = {
    ...hashInput,
    package_id: cleanId(row.package_id || row.packageId || metadata.package_id || metadata.packageId || row.thread_id || row.threadId || 'openharness_package') || 'openharness_package',
    version: Number.isFinite(Number(row.version)) ? Math.max(1, Math.floor(Number(row.version))) : 1,
    metadata: {
      ...asObject(hashInput.metadata),
      exported_at: cleanText(metadata.exported_at || metadata.exportedAt || row.exported_at || row.exportedAt || '', { maxLen: 64 }) || undefined,
      thread_id: cleanText(metadata.thread_id || metadata.threadId || row.thread_id || row.threadId || teamManifest.thread_id || '', { maxLen: 128 }) || undefined,
      service_id: cleanText(metadata.service_id || metadata.serviceId || row.service_id || row.serviceId || teamManifest.service_id || '', { maxLen: 128 }) || undefined,
      source_thread_title: cleanText(metadata.source_thread_title || metadata.sourceThreadTitle || row.thread_title || row.threadTitle || '', { maxLen: 200 }) || undefined,
    },
  };

  const packageHash = cleanText(row.package_hash || row.packageHash, { lower: true, maxLen: 64 }) || stableJsonHash(hashInput);
  return {
    ...packageBody,
    runtime_policy: normalizeHarnessRuntimePolicy(row, { fallbackPackage: hashInput }),
    package_hash: packageHash,
  };
}

export function buildHarnessPackageRef(raw = {}) {
  const pkg = normalizeHarnessPackage(raw);
  return {
    schema_version: pkg.schema_version,
    package_id: pkg.package_id,
    package_hash: pkg.package_hash,
    version: pkg.version,
    name: pkg.metadata?.name || undefined,
  };
}

export function buildRunTraceRecord(eventType = '', payload = {}, extra = {}) {
  const cleanType = cleanText(eventType, { lower: true, maxLen: 96 });
  const normalizedPayload = asObject(payload);
  const jobId = cleanText(extra.jobId || extra.job_id || '', { maxLen: 128 }) || undefined;
  const runId = cleanText(extra.runId || extra.run_id || normalizedPayload.run_id || normalizedPayload.runId || '', { maxLen: 128 }) || undefined;
  const eventId = cleanText(extra.eventId || extra.event_id || '', { maxLen: 200 }) || `evt_${crypto.randomUUID()}`;
  const eventSequence = Math.max(0, Math.floor(Number(extra.eventSequence ?? extra.event_sequence ?? 0) || 0));
  const aggregateType = cleanText(extra.aggregateType || extra.aggregate_type || (runId ? 'run' : (jobId ? 'job' : 'runtime')), { lower: true, maxLen: 64 }) || 'runtime';
  const aggregateId = cleanText(extra.aggregateId || extra.aggregate_id || runId || jobId || eventId, { maxLen: 160 }) || eventId;
  return {
    schema_version: OPENHARNESS_RUN_TRACE_SCHEMA_VERSION,
    sync_schema_version: OPENHARNESS_RUN_SYNC_SCHEMA_VERSION,
    event_id: eventId,
    idempotency_key: eventId,
    event_sequence: eventSequence,
    correlation_id: cleanText(extra.correlationId || extra.correlation_id || runId || jobId || eventId, { maxLen: 200 }) || eventId,
    causation_id: cleanText(extra.causationId || extra.causation_id || normalizedPayload.causation_id || '', { maxLen: 200 }) || undefined,
    command_id: cleanText(extra.commandId || extra.command_id || normalizedPayload.command_id || normalizedPayload.commandId || '', { maxLen: 200 }) || undefined,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    aggregate_revision: Math.max(0, Math.floor(Number(extra.aggregateRevision ?? extra.aggregate_revision ?? eventSequence) || 0)),
    occurred_at: cleanText(extra.occurredAt || extra.occurred_at || new Date().toISOString(), { maxLen: 64 }),
    source: cleanText(extra.source || 'ddalggak', { lower: true, maxLen: 64 }) || 'ddalggak',
    target: cleanText(extra.target || 'local', { lower: true, maxLen: 64 }) || 'local',
    producer: {
      name: cleanText(extra.producerName || extra.producer_name || 'ddalggak', { lower: true, maxLen: 64 }) || 'ddalggak',
      version: cleanText(extra.producerVersion || extra.producer_version || process.env.npm_package_version || 'dev', { maxLen: 64 }) || 'dev',
    },
    privacy_class: cleanText(extra.privacyClass || extra.privacy_class || 'internal_runtime', { lower: true, maxLen: 64 }) || 'internal_runtime',
    payload_digest: stableJsonHash(normalizedPayload, { length: 24 }),
    job_id: jobId,
    run_id: runId,
    event_type: cleanType,
    payload: normalizedPayload,
  };
}
