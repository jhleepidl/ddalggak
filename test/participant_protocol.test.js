import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeParticipantDescriptor, normalizeContributionEvent } from '../src/shared/participant_protocol.js';
import { normalizeHarnessRuntimePolicy } from '../src/shared/openharness_contracts.js';

test('participant descriptor treats telegram human as privileged foreground interface', () => {
  const participant = normalizeParticipantDescriptor({
    participant_id: 'human.telegram',
    participant_type: 'human',
    transport: 'telegram',
    label: 'Human',
  });

  assert.equal(participant.human_special, true);
  assert.equal(participant.channel_mode, 'foreground');
  assert.equal(participant.visibility_default, 'always_surface');
  assert.equal(participant.trust_tier, 'trusted');
});

test('contribution event inherits participant defaults and keeps privacy metadata', () => {
  const participant = normalizeParticipantDescriptor({
    participant_id: 'phone.scout',
    participant_type: 'device_scout',
    visibility_default: 'fold_into_reply',
    privacy_scope: 'summary_only',
    modalities: ['text', 'image'],
  });
  const contribution = normalizeContributionEvent({
    contribution_kind: 'evidence',
    content: '로컬 메모에서 관련 단서를 찾음',
    confidence: 0.88,
    turn_id: 'turn_1',
  }, { participant });

  assert.equal(contribution.participant_id, 'phone.scout');
  assert.equal(contribution.visibility_default, 'fold_into_reply');
  assert.equal(contribution.privacy_scope, 'summary_only');
  assert.deepEqual(contribution.modalities, ['text', 'image']);
});

test('runtime policy normalization includes participant and human interface governance', () => {
  const policy = normalizeHarnessRuntimePolicy({
    runtime_policy: {
      participant_policy: {
        open_participation_enabled: true,
        default_visibility: 'internal_only',
        surface_threshold: 0.9,
        max_surface_per_turn: 2,
        allowed_participant_types: ['device_scout', 'small_llm'],
      },
      human_interface_policy: {
        human_channel: 'telegram',
        external_contribution_mode: 'folded_only',
        reply_only_external_interventions: true,
      },
    },
  });

  assert.equal(policy.participant_policy.surface_threshold, 0.9);
  assert.equal(policy.participant_policy.max_surface_per_turn, 2);
  assert.deepEqual(policy.participant_policy.allowed_participant_types, ['device_scout', 'small_llm']);
  assert.equal(policy.human_interface_policy.human_channel, 'telegram');
  assert.equal(policy.human_interface_policy.external_contribution_mode, 'folded_only');
});
