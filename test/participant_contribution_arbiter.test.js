import test from 'node:test';
import assert from 'node:assert/strict';

import { arbitrateParticipantContribution } from '../src/application/participant_contribution_arbiter.js';
import { normalizeParticipantDescriptor, normalizeContributionEvent } from '../src/shared/participant_protocol.js';

const runtimePolicy = {
  participant_policy: {
    open_participation_enabled: true,
    surface_threshold: 0.8,
    default_visibility: 'internal_only',
    max_surface_per_turn: 1,
    surface_candidate_kinds: ['summary', 'critique', 'evidence', 'conflict_flag'],
  },
  human_interface_policy: {
    external_contribution_mode: 'folded_only',
    reply_only_external_interventions: true,
  },
};

test('human participant is always surfaced through primary interface', () => {
  const participant = normalizeParticipantDescriptor({ participant_type: 'human', transport: 'telegram', participant_id: 'human.telegram' });
  const contribution = normalizeContributionEvent({ kind: 'question', content: '사용자 입력', turn_id: 'turn_1' }, { participant });
  const decision = arbitrateParticipantContribution({ runtimePolicy, participant, contribution, registry: {} });
  assert.equal(decision.action, 'surface_to_runtime');
  assert.equal(decision.should_surface, true);
});

test('external participant folds into reply instead of directly interrupting human channel', () => {
  const participant = normalizeParticipantDescriptor({ participant_id: 'phone.scout', participant_type: 'device_scout', visibility_default: 'may_surface' });
  const contribution = normalizeContributionEvent({ kind: 'summary', content: '로컬 파일에서 관련 요약 발견', confidence: 0.91, turn_id: 'turn_1' }, { participant });
  const decision = arbitrateParticipantContribution({ runtimePolicy, participant, contribution, registry: {} });
  assert.equal(decision.action, 'fold_into_reply');
  assert.equal(decision.should_fold, true);
  assert.equal(decision.should_surface, false);
});

test('surface budget exhaustion downgrades contributions to folded delivery', () => {
  const participant = normalizeParticipantDescriptor({ participant_id: 'critic.mini', participant_type: 'small_llm', visibility_default: 'may_surface' });
  const contribution = normalizeContributionEvent({ kind: 'critique', content: '앞뒤 숫자가 다름', confidence: 0.95, turn_id: 'turn_1' }, { participant });
  const decision = arbitrateParticipantContribution({
    runtimePolicy: { ...runtimePolicy, human_interface_policy: { external_contribution_mode: 'reply_allowed', reply_only_external_interventions: false } },
    participant,
    contribution,
    registry: { surfaced_count_by_turn: { turn_1: 1 } },
  });
  assert.equal(decision.action, 'fold_into_reply');
  assert.equal(decision.should_fold, true);
});


test('candidate participant policy channel relaxes surfacing thresholds for experiments', () => {
  const participant = normalizeParticipantDescriptor({ participant_id: 'critic.experimental', participant_type: 'small_llm', visibility_default: 'may_surface' });
  const contribution = normalizeContributionEvent({ kind: 'critique', content: 'candidate policy should surface this critique', confidence: 0.74, turn_id: 'turn_2' }, { participant });
  const decision = arbitrateParticipantContribution({
    runtimePolicy: {
      participant_policy: {
        open_participation_enabled: true,
        policy_channel: 'candidate',
        surface_threshold: 0.8,
        default_visibility: 'may_surface',
        max_surface_per_turn: 1,
        surface_candidate_kinds: ['critique'],
      },
      human_interface_policy: {
        external_contribution_mode: 'reply_allowed',
        reply_only_external_interventions: false,
      },
    },
    participant,
    contribution,
    registry: {},
  });
  assert.equal(decision.policy_channel, 'candidate');
  assert.equal(decision.action, 'surface_to_human');
  assert.equal(decision.should_surface, true);
});
