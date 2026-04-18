import { normalizeContributionEvent, normalizeParticipantDescriptor } from '../shared/participant_protocol.js';
import {
  attachParticipantToRegistry,
  ensureRuntimeParticipantRegistry,
  incrementSurfacedTurnCount,
  registerHumanInterfaceParticipant,
  resolveParticipantFromRegistry,
} from './participant_registry.js';
import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';
import { ensureRuntimeSessionState, getRuntimeHarnessPolicy, setRuntimeCurrentTurn, syncRuntimeObservabilityState, syncRuntimeParticipantState } from './runtime_session_state.js';
import { arbitrateParticipantContribution } from './participant_contribution_arbiter.js';

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

function ensureContributionBuffers(runtime = null) {
  const target = asObject(runtime);
  if (!Array.isArray(target.participantContributionInbox)) target.participantContributionInbox = [];
  if (!Array.isArray(target.participantContributionSurfaceQueue)) target.participantContributionSurfaceQueue = [];
  if (!Array.isArray(target.participantContributionHistory)) target.participantContributionHistory = [];
  if (!Array.isArray(target.participantContributionDecisionLog)) target.participantContributionDecisionLog = [];
  return target;
}

export function ensureRuntimeHumanTelegramParticipant(runtime = null, { chatId = '', telegramUserId = '' } = {}) {
  ensureRuntimeSessionState(runtime, { chatId, telegramUserId });
  return registerHumanInterfaceParticipant(runtime, {
    participantId: 'human.telegram',
    label: 'Human',
    transport: 'telegram',
    chatId,
    telegramUserId,
  });
}

export function registerRuntimeParticipant(runtime = null, descriptor = {}, options = {}) {
  const target = ensureContributionBuffers(runtime);
  const runtimePolicy = getRuntimeHarnessPolicy(target);
  ensureRuntimeBehavior(target, { runtimePolicy });
  const registry = ensureRuntimeParticipantRegistry(target, { runtimePolicy });
  const participant = normalizeParticipantDescriptor(descriptor);
  const nextRegistry = attachParticipantToRegistry(registry, participant, options);
  target.participantRegistry = nextRegistry;
  target.participant_registry = nextRegistry;
  syncRuntimeParticipantState(target, { registry: nextRegistry });
  return participant;
}

export async function submitRuntimeParticipantContribution({
  runtime = null,
  descriptor = null,
  contribution = null,
  runEventSink = null,
  jobId = '',
} = {}) {
  const target = ensureContributionBuffers(runtime);
  const runtimePolicy = getRuntimeHarnessPolicy(target);
  ensureRuntimeBehavior(target, { runtimePolicy });
  const registry = ensureRuntimeParticipantRegistry(target, { runtimePolicy });
  const participant = descriptor
    ? registerRuntimeParticipant(target, descriptor)
    : resolveParticipantFromRegistry(registry, contribution?.participant_id || contribution?.participantId || '')
      || registerRuntimeParticipant(target, { participant_id: contribution?.participant_id || contribution?.participantId || 'participant.unknown', participant_type: 'other' });
  ensureRuntimeSessionState(target, { currentTurnId: target.currentTurnId || target.current_turn_id || '' });
  const event = normalizeContributionEvent(contribution || {}, {
    participant,
    defaults: {
      session_id: cleanText(target.sessionId || target.session_id || '', { maxLen: 128 }) || undefined,
      thread_id: cleanText(target.map?.threadId || target.threadId || target.thread_id || '', { maxLen: 128 }) || undefined,
      turn_id: cleanText(target.currentTurnId || target.current_turn_id || '', { maxLen: 128 }) || undefined,
    },
  });
  const decision = arbitrateParticipantContribution({
    runtimePolicy,
    registry: target.participantRegistry || target.participant_registry || null,
    participant,
    contribution: event,
  });
  const envelope = {
    participant,
    contribution: event,
    decision,
  };
  const decisionLogEntry = {
    contribution_id: event.contribution_id,
    participant_id: participant.participant_id,
    participant_label: cleanText(participant.label || participant.participant_id || '', { maxLen: 120 }) || participant.participant_id,
    turn_id: event.turn_id || undefined,
    kind: event.kind,
    confidence: event.confidence,
    action: decision.action,
    audience: decision.audience,
    surface_mode: decision.surface_mode,
    policy_channel: decision.policy_channel,
    digest: decision.digest,
    reasons: asArray(decision.reasons).slice(0, 6),
  };
  target.participantContributionHistory.push(envelope);
  if (target.participantContributionHistory.length > 64) target.participantContributionHistory.shift();
  target.participantContributionDecisionLog.push(decisionLogEntry);
  if (target.participantContributionDecisionLog.length > 128) target.participantContributionDecisionLog.shift();
  if (decision.should_store_internal) {
    target.participantContributionInbox.push(envelope);
    if (target.participantContributionInbox.length > 24) target.participantContributionInbox.shift();
  }
  if (decision.should_fold || decision.should_surface) {
    target.participantContributionSurfaceQueue.push(envelope);
    if (target.participantContributionSurfaceQueue.length > 24) target.participantContributionSurfaceQueue.shift();
  }
  if (event.turn_id) setRuntimeCurrentTurn(target, event.turn_id);
  if (decision.should_surface && event.turn_id) {
    const nextRegistry = incrementSurfacedTurnCount(target.participantRegistry || target.participant_registry || {}, event.turn_id, 1);
    target.participantRegistry = nextRegistry;
    target.participant_registry = nextRegistry;
  }
  syncRuntimeParticipantState(target, {
    registry: target.participantRegistry || target.participant_registry || null,
    inbox: target.participantContributionInbox,
    surfaceQueue: target.participantContributionSurfaceQueue,
    history: target.participantContributionHistory,
  });
  syncRuntimeObservabilityState(target, {
    participant_surface: {
      decision_log_size: target.participantContributionDecisionLog.length,
      last_turn_id: event.turn_id || undefined,
    },
  });
  if (runEventSink && typeof runEventSink.recordAgentEvent === 'function') {
    await runEventSink.recordAgentEvent('participant.contribution', {
      participant,
      contribution: event,
      decision: {
        action: decision.action,
        audience: decision.audience,
        surface_mode: decision.surface_mode,
        reasons: asArray(decision.reasons),
      },
    }, { jobId });
  }
  return envelope;
}

export function consumeFoldedParticipantContributions(runtime = null, { turnId = '', maxItems = 4 } = {}) {
  const target = ensureContributionBuffers(runtime);
  const cleanTurnId = cleanText(turnId, { maxLen: 128 });
  const kept = [];
  const picked = [];
  for (const envelope of asArray(target.participantContributionSurfaceQueue)) {
    const contributionTurnId = cleanText(envelope?.contribution?.turn_id, { maxLen: 128 });
    const shouldPick = (!cleanTurnId || contributionTurnId === cleanTurnId)
      && (envelope?.decision?.should_fold === true || envelope?.decision?.should_surface === true);
    if (shouldPick && picked.length < Math.max(1, Math.floor(Number(maxItems) || 4))) {
      picked.push(envelope);
      continue;
    }
    kept.push(envelope);
  }
  target.participantContributionSurfaceQueue = kept;
  syncRuntimeParticipantState(target, { surfaceQueue: kept });
  syncRuntimeObservabilityState(target, {
    participant_surface: {
      last_turn_id: cleanTurnId || undefined,
      last_folded_count: picked.length,
      last_folded_labels: picked.map((entry) => cleanText(entry?.participant?.label || entry?.participant?.participant_id || '', { maxLen: 120 })).filter(Boolean).slice(0, 8),
      decision_log_size: asArray(target.participantContributionDecisionLog).length,
    },
  });
  return picked;
}
