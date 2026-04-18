import { applyInstalledHarnessPackageToRuntime, getInstalledHarnessPackageState } from './harness_package_runtime.js';
import { ensureRuntimeBehavior, resolveRuntimePolicyForRuntime } from './runtime_behavior_resolver.js';
import { attachRuntimeHarnessState, ensureRuntimeSessionState, setRuntimeCurrentTurn } from './runtime_session_state.js';
import { ensureRuntimeHumanTelegramParticipant } from './runtime_participant_gateway.js';
import { loadChannelPromotionSummary } from './channel_promotion_manager.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mergeParticipantPolicyWithPromotion(runtimePolicy = null, promotionSummary = null) {
  const policy = asObject(runtimePolicy);
  const summary = asObject(promotionSummary);
  const snapshot = asObject(summary.latest_participant_policy_snapshot);
  if (Object.keys(snapshot).length === 0) return policy;
  const current = asObject(policy.participant_policy || policy.participantPolicy);
  const merged = {
    ...snapshot,
    ...current,
    allowed_participant_types: asArray(current.allowed_participant_types || current.allowedParticipantTypes).length > 0
      ? (current.allowed_participant_types || current.allowedParticipantTypes)
      : asArray(snapshot.allowed_participant_types),
    allowed_modalities: asArray(current.allowed_modalities || current.allowedModalities).length > 0
      ? (current.allowed_modalities || current.allowedModalities)
      : asArray(snapshot.allowed_modalities),
    surface_candidate_kinds: asArray(current.surface_candidate_kinds || current.surfaceCandidateKinds).length > 0
      ? (current.surface_candidate_kinds || current.surfaceCandidateKinds)
      : asArray(snapshot.surface_candidate_kinds),
  };
  return {
    ...policy,
    participant_policy: merged,
    channel_promotion_summary: summary,
  };
}

export function bootstrapTelegramRuntimeSession({
  runtime = null,
  sessionStore = null,
  chatId = '',
  telegramUserId = '',
  currentTurnId = '',
  jobId = '',
  runsDir = '',
  jobDir = '',
} = {}) {
  const installedHarnessState = getInstalledHarnessPackageState(sessionStore, chatId);
  applyInstalledHarnessPackageToRuntime(runtime, { installState: installedHarnessState });
  const promotionSummary = loadChannelPromotionSummary({ runsDir, jobDir: jobDir || (jobId && runsDir ? `${runsDir}/${jobId}` : '') });
  const baseRuntimePolicy = resolveRuntimePolicyForRuntime(runtime, installedHarnessState?.runtime_policy || null);
  const runtimePolicy = mergeParticipantPolicyWithPromotion(baseRuntimePolicy, promotionSummary);
  runtime.channelPromotionSummary = promotionSummary || null;
  runtime.channel_promotion_summary = promotionSummary || null;
  ensureRuntimeBehavior(runtime, { runtimePolicy });
  attachRuntimeHarnessState(runtime, {
    packageRef: installedHarnessState?.package_ref || runtime?.harnessPackageRef || runtime?.harnessPackage || null,
    runtimePolicy,
  });
  const runtimeSessionState = ensureRuntimeSessionState(runtime, {
    chatId,
    telegramUserId,
    currentTurnId,
    jobId,
    runtimePolicy,
  });
  runtimeSessionState.planner_state = {
    ...asObject(runtimeSessionState.planner_state || runtimeSessionState.plannerState),
    promoted_stable_motif_ids: asArray(asObject(promotionSummary?.stable_registry).motif_ids || []).slice(0, 16),
  };
  runtimeSessionState.observability_state = {
    ...asObject(runtimeSessionState.observability_state || runtimeSessionState.observabilityState),
    channel_promotions: {
      stable_motif_count: asArray(asObject(promotionSummary?.stable_registry).motifs || []).length,
      rolled_back_motif_count: asArray(asObject(promotionSummary?.rolled_back_registry).motifs || []).length,
      has_participant_policy_snapshot: Object.keys(asObject(promotionSummary?.latest_participant_policy_snapshot)).length > 0,
    },
  };
  if (currentTurnId) setRuntimeCurrentTurn(runtime, currentTurnId);
  ensureRuntimeHumanTelegramParticipant(runtime, { chatId, telegramUserId });
  return {
    installedHarnessState,
    runtimePolicy,
    promotionSummary,
    runtimeSessionState: runtime?.runtimeSessionState || runtime?.runtime_session_state || null,
  };
}
