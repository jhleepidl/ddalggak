import { resolveHarnessRuntimePolicy } from './harness_runtime_behavior.js';

export const OPENHARNESS_RUNTIME_SESSION_SCHEMA_VERSION = 'openharness.runtime_session_state/v1';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 128 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function normalizeIdentity(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const defaults = asObject(fallback);
  return {
    session_id: cleanText(row.session_id || row.sessionId || defaults.session_id || defaults.sessionId || '', { maxLen: 128 }) || undefined,
    thread_id: cleanText(row.thread_id || row.threadId || defaults.thread_id || defaults.threadId || '', { maxLen: 128 }) || undefined,
    job_id: cleanText(row.job_id || row.jobId || defaults.job_id || defaults.jobId || '', { maxLen: 128 }) || undefined,
    chat_id: cleanText(row.chat_id || row.chatId || defaults.chat_id || defaults.chatId || '', { maxLen: 128 }) || undefined,
    telegram_user_id: cleanText(row.telegram_user_id || row.telegramUserId || defaults.telegram_user_id || defaults.telegramUserId || '', { maxLen: 128 }) || undefined,
  };
}

function normalizeParticipantState(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const defaults = asObject(fallback);
  return {
    registry: asObject(row.registry || row.participant_registry || row.participantRegistry || defaults.registry || defaults.participant_registry || defaults.participantRegistry),
    inbox_size: Math.max(0, Math.floor(Number(row.inbox_size || row.inboxSize || defaults.inbox_size || defaults.inboxSize || 0) || 0)),
    surface_queue_size: Math.max(0, Math.floor(Number(row.surface_queue_size || row.surfaceQueueSize || defaults.surface_queue_size || defaults.surfaceQueueSize || 0) || 0)),
    history_size: Math.max(0, Math.floor(Number(row.history_size || row.historySize || defaults.history_size || defaults.historySize || 0) || 0)),
    decision_log_size: Math.max(0, Math.floor(Number(row.decision_log_size || row.decisionLogSize || defaults.decision_log_size || defaults.decisionLogSize || 0) || 0)),
  };
}


function normalizeExecutionState(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const defaults = asObject(fallback);
  const adaptive = asObject(row.adaptive_execution || row.adaptiveExecution || defaults.adaptive_execution || defaults.adaptiveExecution);
  const modeHistory = asArray(adaptive.mode_history || adaptive.modeHistory).map((entry) => {
    const item = asObject(entry);
    return {
      ts: cleanText(item.ts || item.timestamp || '', { maxLen: 128 }) || undefined,
      mode: cleanText(item.mode || '', { lower: true, maxLen: 64 }) || undefined,
      status: cleanText(item.status || '', { lower: true, maxLen: 32 }) || undefined,
      followup_burden: Math.max(0, Math.min(8, Math.floor(Number(item.followup_burden || item.followupBurden || 0) || 0))),
      quality_gap: Math.max(0, Math.min(16, Math.floor(Number(item.quality_gap || item.qualityGap || 0) || 0))),
      contradiction_pressure: Math.max(0, Math.min(16, Math.floor(Number(item.contradiction_pressure || item.contradictionPressure || 0) || 0))),
      quality_health_score: Math.max(0, Math.min(1, Number(item.quality_health_score || item.qualityHealthScore || 0) || 0)),
    };
  }).filter((entry) => entry.mode).slice(-8);
  return {
    adaptive_execution: {
      current_mode: cleanText(adaptive.current_mode || adaptive.currentMode || 'single_compiled', { lower: true, maxLen: 64 }) || 'single_compiled',
      last_mode: cleanText(adaptive.last_mode || adaptive.lastMode || '', { lower: true, maxLen: 64 }) || undefined,
      escalation_level: Math.max(0, Math.min(2, Math.floor(Number(adaptive.escalation_level || adaptive.escalationLevel || 0) || 0))),
      last_status: cleanText(adaptive.last_status || adaptive.lastStatus || '', { lower: true, maxLen: 32 }) || undefined,
      failure_streak: Math.max(0, Math.min(16, Math.floor(Number(adaptive.failure_streak || adaptive.failureStreak || 0) || 0))),
      success_streak: Math.max(0, Math.min(16, Math.floor(Number(adaptive.success_streak || adaptive.successStreak || 0) || 0))),
      capability_gap_runs: Math.max(0, Math.min(16, Math.floor(Number(adaptive.capability_gap_runs || adaptive.capabilityGapRuns || 0) || 0))),
      await_user_streak: Math.max(0, Math.min(16, Math.floor(Number(adaptive.await_user_streak || adaptive.awaitUserStreak || 0) || 0))),
      followup_burden_runs: Math.max(0, Math.min(16, Math.floor(Number(adaptive.followup_burden_runs || adaptive.followupBurdenRuns || 0) || 0))),
      quality_gap_runs: Math.max(0, Math.min(16, Math.floor(Number(adaptive.quality_gap_runs || adaptive.qualityGapRuns || 0) || 0))),
      contradiction_pressure_runs: Math.max(0, Math.min(16, Math.floor(Number(adaptive.contradiction_pressure_runs || adaptive.contradictionPressureRuns || 0) || 0))),
      contradiction_resolved_runs: Math.max(0, Math.min(16, Math.floor(Number(adaptive.contradiction_resolved_runs || adaptive.contradictionResolvedRuns || 0) || 0))),
      run_count: Math.max(0, Math.min(100000, Math.floor(Number(adaptive.run_count || adaptive.runCount || 0) || 0))),
      last_signals: asObject(adaptive.last_signals || adaptive.lastSignals),
      last_quality_signals: asObject(adaptive.last_quality_signals || adaptive.lastQualitySignals),
      mode_history: modeHistory,
    },
  };
}

function normalizeObservabilityState(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const defaults = asObject(fallback);
  return {
    participant_surface: {
      decision_log_size: Math.max(0, Math.floor(Number(
        row?.participant_surface?.decision_log_size
        || row?.participantSurface?.decisionLogSize
        || defaults?.participant_surface?.decision_log_size
        || defaults?.participantSurface?.decisionLogSize
        || 0
      ) || 0)),
      last_turn_id: cleanText(
        row?.participant_surface?.last_turn_id
          || row?.participantSurface?.lastTurnId
          || defaults?.participant_surface?.last_turn_id
          || defaults?.participantSurface?.lastTurnId
          || '',
        { maxLen: 128 }
      ) || undefined,
      last_folded_count: Math.max(0, Math.floor(Number(
        row?.participant_surface?.last_folded_count
        || row?.participantSurface?.lastFoldedCount
        || defaults?.participant_surface?.last_folded_count
        || defaults?.participantSurface?.lastFoldedCount
        || 0
      ) || 0)),
      last_folded_labels: asArray(
        row?.participant_surface?.last_folded_labels
        || row?.participantSurface?.lastFoldedLabels
        || defaults?.participant_surface?.last_folded_labels
        || defaults?.participantSurface?.lastFoldedLabels
      ).map((entry) => cleanText(entry, { maxLen: 120 })).filter(Boolean).slice(0, 8),
      last_digest_turn_id: cleanText(
        row?.participant_surface?.last_digest_turn_id
          || row?.participantSurface?.lastDigestTurnId
          || defaults?.participant_surface?.last_digest_turn_id
          || defaults?.participantSurface?.lastDigestTurnId
          || '',
        { maxLen: 128 }
      ) || undefined,
      last_digest_signature: cleanText(
        row?.participant_surface?.last_digest_signature
          || row?.participantSurface?.lastDigestSignature
          || defaults?.participant_surface?.last_digest_signature
          || defaults?.participantSurface?.lastDigestSignature
          || '',
        { maxLen: 256 }
      ) || undefined,
    },
  };
}

export function getRuntimeHarnessPolicy(runtime = null, fallback = null) {
  return resolveHarnessRuntimePolicy(fallback || runtime || null);
}

export function ensureRuntimeSessionState(runtime = null, {
  chatId = '',
  telegramUserId = '',
  currentTurnId = '',
  sessionId = '',
  threadId = '',
  jobId = '',
  runtimePolicy = null,
} = {}) {
  const target = asObject(runtime);
  const existing = asObject(target.runtimeSessionState || target.runtime_session_state);
  const identity = normalizeIdentity(existing.session_identity || existing.sessionIdentity, {
    session_id: sessionId || target.sessionId || target.session_id,
    thread_id: threadId || target.map?.threadId || target.threadId || target.thread_id,
    job_id: jobId || target.jobId || target.job_id,
    chat_id: chatId || target.chatId || target.chat_id,
    telegram_user_id: telegramUserId || target.telegramUserId || target.telegram_user_id,
  });
  const activeTurnId = cleanText(
    currentTurnId
      || existing.active_turn?.turn_id
      || existing.activeTurn?.turnId
      || target.currentTurnId
      || target.current_turn_id,
    { maxLen: 128 }
  ) || undefined;
  const harnessPackageRef = asObject(
    target.harnessPackageRef
      || target.harnessPackage
      || existing.active_harness?.package_ref
      || existing.activeHarness?.packageRef
  );
  const policy = getRuntimeHarnessPolicy(target, runtimePolicy || existing.active_harness?.runtime_policy || existing.activeHarness?.runtimePolicy || null);
  const participantState = normalizeParticipantState(existing.participant_state || existing.participantState, {
    registry: target.participantRegistry || target.participant_registry || null,
    inbox_size: asArray(target.participantContributionInbox).length,
    surface_queue_size: asArray(target.participantContributionSurfaceQueue).length,
    history_size: asArray(target.participantContributionHistory).length,
    decision_log_size: asArray(target.participantContributionDecisionLog).length,
  });
  const observabilityState = normalizeObservabilityState(existing.observability_state || existing.observabilityState, {
    participant_surface: {
      decision_log_size: asArray(target.participantContributionDecisionLog).length,
    },
  });
  const state = {
    schema_version: OPENHARNESS_RUNTIME_SESSION_SCHEMA_VERSION,
    session_identity: identity,
    active_turn: {
      turn_id: activeTurnId,
    },
    active_harness: {
      package_ref: harnessPackageRef,
      runtime_policy: policy,
    },
    participant_state: participantState,
    planner_state: asObject(existing.planner_state || existing.plannerState),
    execution_state: normalizeExecutionState(existing.execution_state || existing.executionState),
    observability_state: observabilityState,
  };
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}

export function attachRuntimeHarnessState(runtime = null, { packageRef = null, runtimePolicy = null } = {}) {
  const target = asObject(runtime);
  const state = ensureRuntimeSessionState(target, { runtimePolicy });
  state.active_harness = {
    ...asObject(state.active_harness),
    package_ref: asObject(packageRef || target.harnessPackageRef || target.harnessPackage),
    runtime_policy: getRuntimeHarnessPolicy(target, runtimePolicy || state.active_harness?.runtime_policy || null),
  };
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}

export function setRuntimeCurrentTurn(runtime = null, turnId = '') {
  const target = asObject(runtime);
  const state = ensureRuntimeSessionState(target);
  state.active_turn = {
    ...asObject(state.active_turn),
    turn_id: cleanText(turnId || target.currentTurnId || target.current_turn_id, { maxLen: 128 }) || undefined,
  };
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}

export function syncRuntimeParticipantState(runtime = null, {
  registry = null,
  inbox = null,
  surfaceQueue = null,
  history = null,
} = {}) {
  const target = asObject(runtime);
  const state = ensureRuntimeSessionState(target);
  state.participant_state = normalizeParticipantState(state.participant_state, {
    registry: registry || target.participantRegistry || target.participant_registry || null,
    inbox_size: asArray(inbox || target.participantContributionInbox).length,
    surface_queue_size: asArray(surfaceQueue || target.participantContributionSurfaceQueue).length,
    history_size: asArray(history || target.participantContributionHistory).length,
    decision_log_size: asArray(target.participantContributionDecisionLog).length,
  });
  state.observability_state = normalizeObservabilityState(state.observability_state, {
    participant_surface: {
      decision_log_size: asArray(target.participantContributionDecisionLog).length,
      last_turn_id: state.active_turn?.turn_id || target.currentTurnId || target.current_turn_id || '',
    },
  });
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}

export function syncRuntimeObservabilityState(runtime = null, patch = null) {
  const target = asObject(runtime);
  const state = ensureRuntimeSessionState(target);
  const current = normalizeObservabilityState(state.observability_state || state.observabilityState, {
    participant_surface: {
      decision_log_size: asArray(target.participantContributionDecisionLog).length,
      last_turn_id: state.active_turn?.turn_id || target.currentTurnId || target.current_turn_id || '',
    },
  });
  const row = asObject(patch);
  const participantSurface = asObject(row.participant_surface || row.participantSurface);
  state.observability_state = normalizeObservabilityState({
    participant_surface: {
      ...asObject(current.participant_surface),
      decision_log_size: participantSurface.decision_log_size ?? participantSurface.decisionLogSize ?? current.participant_surface?.decision_log_size,
      last_turn_id: participantSurface.last_turn_id ?? participantSurface.lastTurnId ?? current.participant_surface?.last_turn_id,
      last_folded_count: participantSurface.last_folded_count ?? participantSurface.lastFoldedCount ?? current.participant_surface?.last_folded_count,
      last_folded_labels: Array.isArray(participantSurface.last_folded_labels || participantSurface.lastFoldedLabels)
        ? (participantSurface.last_folded_labels || participantSurface.lastFoldedLabels)
        : current.participant_surface?.last_folded_labels,
      last_digest_turn_id: participantSurface.last_digest_turn_id ?? participantSurface.lastDigestTurnId ?? current.participant_surface?.last_digest_turn_id,
      last_digest_signature: participantSurface.last_digest_signature ?? participantSurface.lastDigestSignature ?? current.participant_surface?.last_digest_signature,
    },
  });
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}


export function syncRuntimeExecutionState(runtime = null, patch = null) {
  const target = asObject(runtime);
  const state = ensureRuntimeSessionState(target);
  const current = normalizeExecutionState(state.execution_state || state.executionState);
  const row = asObject(patch);
  state.execution_state = normalizeExecutionState({
    adaptive_execution: {
      ...asObject(current.adaptive_execution),
      ...asObject(row.adaptive_execution || row.adaptiveExecution),
    },
  });
  target.runtimeSessionState = state;
  target.runtime_session_state = state;
  return state;
}
