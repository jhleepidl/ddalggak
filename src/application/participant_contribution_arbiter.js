import { buildContributionDigest, normalizeContributionEvent, normalizeParticipantDescriptor } from '../shared/participant_protocol.js';
import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';
import { normalizeParticipantRegistry } from './participant_registry.js';

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

function hasAllowedType(policy = {}, participant = {}) {
  const allowed = Array.isArray(policy.allowed_participant_types) ? policy.allowed_participant_types : [];
  if (allowed.length === 0) return true;
  return allowed.includes(cleanText(participant.participant_type, { lower: true, maxLen: 64 }));
}

function hasAllowedModality(policy = {}, contribution = {}) {
  const allowed = Array.isArray(policy.allowed_modalities) ? policy.allowed_modalities : [];
  if (allowed.length === 0) return true;
  const contributionModalities = new Set(asArray(contribution.modalities).map((entry) => cleanText(entry, { lower: true, maxLen: 32 })).filter(Boolean));
  for (const modality of allowed) {
    if (contributionModalities.has(cleanText(modality, { lower: true, maxLen: 32 }))) return true;
  }
  return false;
}

function resolveSurfaceBudgetAvailable(registry = {}, contribution = {}, participantPolicy = {}) {
  const turnId = cleanText(contribution.turn_id, { maxLen: 128 });
  if (!turnId) return true;
  const count = Number(asObject(registry.surfaced_count_by_turn)[turnId] || 0);
  const budget = Number.isFinite(Number(participantPolicy.max_surface_per_turn)) ? Number(participantPolicy.max_surface_per_turn) : 1;
  return count < budget;
}

export function arbitrateParticipantContribution({
  runtimePolicy = null,
  registry = null,
  participant = null,
  contribution = null,
} = {}) {
  const behavior = ensureRuntimeBehavior({}, { runtimePolicy });
  const participantPolicy = behavior.participant;
  const humanPolicy = behavior.human_interface;
  const normalizedRegistry = normalizeParticipantRegistry(registry || {}, { runtimePolicy });
  const descriptor = normalizeParticipantDescriptor(participant || {});
  const event = normalizeContributionEvent(contribution || {}, { participant: descriptor });
  const reasons = [];

  if (descriptor.human_special === true) {
    reasons.push('human participant is privileged and directly surfaced through the primary interface');
    return {
      ok: true,
      action: 'surface_to_runtime',
      audience: 'human',
      surface_mode: 'direct',
      should_record: true,
      should_store_internal: true,
      should_surface: true,
      should_fold: false,
      reasons,
      participant: descriptor,
      contribution: event,
      digest: buildContributionDigest(event),
    };
  }

  if (!participantPolicy.open_participation_enabled) {
    reasons.push('runtime policy disables open participant contributions');
    return {
      ok: false,
      action: 'ignore',
      audience: 'internal',
      surface_mode: 'none',
      should_record: true,
      should_store_internal: false,
      should_surface: false,
      should_fold: false,
      reasons,
      participant: descriptor,
      contribution: event,
      digest: buildContributionDigest(event),
    };
  }

  if (participantPolicy.require_provenance && !descriptor.participant_id) {
    reasons.push('participant provenance missing');
    return {
      ok: false,
      action: 'ignore',
      audience: 'internal',
      surface_mode: 'none',
      should_record: true,
      should_store_internal: false,
      should_surface: false,
      should_fold: false,
      reasons,
      participant: descriptor,
      contribution: event,
      digest: buildContributionDigest(event),
    };
  }

  if (!hasAllowedType(participantPolicy, descriptor)) {
    reasons.push(`participant type ${descriptor.participant_type} is not allowed by runtime policy`);
    return {
      ok: false,
      action: 'ignore',
      audience: 'internal',
      surface_mode: 'none',
      should_record: true,
      should_store_internal: false,
      should_surface: false,
      should_fold: false,
      reasons,
      participant: descriptor,
      contribution: event,
      digest: buildContributionDigest(event),
    };
  }

  if (!hasAllowedModality(participantPolicy, event)) {
    reasons.push('contribution modality is not allowed by runtime policy');
    return {
      ok: false,
      action: 'ignore',
      audience: 'internal',
      surface_mode: 'none',
      should_record: true,
      should_store_internal: false,
      should_surface: false,
      should_fold: false,
      reasons,
      participant: descriptor,
      contribution: event,
      digest: buildContributionDigest(event),
    };
  }

  const candidateKinds = Array.isArray(participantPolicy.surface_candidate_kinds) ? participantPolicy.surface_candidate_kinds : [];
  const kindEligible = candidateKinds.length === 0 || candidateKinds.includes(cleanText(event.kind, { lower: true, maxLen: 64 }));
  const visibility = cleanText(event.visibility_default || descriptor.visibility_default || participantPolicy.default_visibility, { lower: true, maxLen: 64 }) || 'internal_only';
  const confidence = Number(event.confidence || 0);
  const budgetAvailable = resolveSurfaceBudgetAvailable(normalizedRegistry, event, participantPolicy);
  const replyOnly = humanPolicy.reply_only_external_interventions === true;
  const externalMode = cleanText(humanPolicy.external_contribution_mode, { lower: true, maxLen: 64 }) || 'folded_only';
  const digest = buildContributionDigest(event);
  const policyChannel = cleanText(participantPolicy.policy_channel || 'stable', { lower: true, maxLen: 32 }) || 'stable';

  const base = {
    ok: true,
    should_record: true,
    participant: descriptor,
    contribution: event,
    digest,
    policy_channel: policyChannel,
  };

  if (visibility === 'always_surface' && budgetAvailable) {
    reasons.push('participant requests always-surface visibility');
    return {
      ...base,
      action: replyOnly ? 'surface_reply_only' : 'surface_to_human',
      audience: 'human',
      surface_mode: replyOnly ? 'reply_only' : 'direct',
      should_store_internal: true,
      should_surface: true,
      should_fold: false,
      reasons,
    };
  }

  if (visibility === 'internal_only') {
    reasons.push('participant contribution remains internal by default');
    return {
      ...base,
      action: 'store_internal',
      audience: 'foreground',
      surface_mode: 'none',
      should_store_internal: true,
      should_surface: false,
      should_fold: false,
      reasons,
    };
  }

  if (visibility === 'fold_into_reply') {
    reasons.push('participant contribution is folded into the foreground reply by default');
    return {
      ...base,
      action: 'fold_into_reply',
      audience: 'foreground',
      surface_mode: 'folded',
      should_store_internal: true,
      should_surface: false,
      should_fold: true,
      reasons,
    };
  }

  if (!kindEligible) {
    reasons.push(`kind ${event.kind} is not eligible for direct surfacing`);
    return {
      ...base,
      action: 'store_internal',
      audience: 'foreground',
      surface_mode: 'none',
      should_store_internal: true,
      should_surface: false,
      should_fold: false,
      reasons,
    };
  }

  if (confidence < participantPolicy.surface_threshold) {
    reasons.push(`confidence ${confidence.toFixed(2)} below surface threshold ${participantPolicy.surface_threshold.toFixed(2)}`);
    return {
      ...base,
      action: 'store_internal',
      audience: 'foreground',
      surface_mode: 'none',
      should_store_internal: true,
      should_surface: false,
      should_fold: false,
      reasons,
    };
  }

  if (!budgetAvailable) {
    reasons.push('surface budget for the current turn is exhausted');
    return {
      ...base,
      action: 'fold_into_reply',
      audience: 'foreground',
      surface_mode: 'folded',
      should_store_internal: true,
      should_surface: false,
      should_fold: true,
      reasons,
    };
  }

  if (externalMode === 'silent_only') {
    reasons.push('human interface policy forces external participant output to remain silent');
    return {
      ...base,
      action: 'store_internal',
      audience: 'foreground',
      surface_mode: 'none',
      should_store_internal: true,
      should_surface: false,
      should_fold: false,
      reasons,
    };
  }

  if (externalMode === 'folded_only') {
    reasons.push('human interface policy allows only folded external contributions');
    return {
      ...base,
      action: 'fold_into_reply',
      audience: 'foreground',
      surface_mode: 'folded',
      should_store_internal: true,
      should_surface: false,
      should_fold: true,
      reasons,
    };
  }

  reasons.push('external participant contribution passes surfacing thresholds');
  return {
    ...base,
    action: replyOnly ? 'surface_reply_only' : 'surface_to_human',
    audience: 'human',
    surface_mode: replyOnly ? 'reply_only' : 'direct',
    should_store_internal: true,
    should_surface: true,
    should_fold: false,
    reasons,
  };
}
