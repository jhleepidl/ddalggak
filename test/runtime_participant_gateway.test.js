import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureRuntimeHumanTelegramParticipant, submitRuntimeParticipantContribution, consumeFoldedParticipantContributions } from '../src/application/runtime_participant_gateway.js';

function createSink() {
  const events = [];
  return {
    events,
    async recordAgentEvent(eventType = '', payload = {}) {
      events.push({ eventType, payload });
      return null;
    },
  };
}

test('runtime gateway registers telegram human and records ambient contributions', async () => {
  const runtime = {
    harnessRuntimePolicy: {
      participant_policy: {
        open_participation_enabled: true,
        surface_threshold: 0.8,
        max_surface_per_turn: 1,
        surface_candidate_kinds: ['summary', 'critique', 'evidence'],
      },
      human_interface_policy: {
        human_channel: 'telegram',
        external_contribution_mode: 'folded_only',
        reply_only_external_interventions: true,
      },
    },
    currentTurnId: 'turn_42',
    sessionId: 'session_1',
    map: { threadId: 'thread_1' },
  };
  const sink = createSink();
  const human = ensureRuntimeHumanTelegramParticipant(runtime, { chatId: 'chat_1', telegramUserId: 'user_9' });
  assert.equal(human.participant_id, 'human.telegram');
  assert.equal(runtime.participantRegistry.human_interface_participant_id, 'human.telegram');

  const result = await submitRuntimeParticipantContribution({
    runtime,
    descriptor: {
      participant_id: 'phone.scout',
      participant_type: 'device_scout',
      label: 'Phone Scout',
      visibility_default: 'may_surface',
      channel_mode: 'ambient',
      privacy_scope: 'summary_only',
    },
    contribution: {
      contribution_kind: 'summary',
      content: '로컬 파일에서 TODO 메모를 발견함',
      confidence: 0.91,
      turn_id: 'turn_42',
    },
    runEventSink: sink,
    jobId: 'job_1',
  });

  assert.equal(result.decision.action, 'fold_into_reply');
  assert.equal(runtime.participantContributionInbox.length, 1);
  assert.equal(runtime.participantContributionDecisionLog.length, 1);
  assert.equal(runtime.runtimeSessionState.participant_state.decision_log_size, 1);
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].eventType, 'participant.contribution');

  const folded = consumeFoldedParticipantContributions(runtime, { turnId: 'turn_42', maxItems: 2 });
  assert.equal(folded.length, 1);
  assert.equal(runtime.participantContributionSurfaceQueue.length, 0);
});
