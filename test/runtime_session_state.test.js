import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachRuntimeHarnessState,
  ensureRuntimeSessionState,
  getRuntimeHarnessPolicy,
  setRuntimeCurrentTurn,
  syncRuntimeObservabilityState,
  syncRuntimeParticipantState,
} from '../src/application/runtime_session_state.js';


test('runtime session state resolves canonical identity and harness policy', () => {
  const runtime = {
    sessionId: 'session_1',
    map: { threadId: 'thread_9' },
    harnessRuntimePolicy: {
      participant_policy: { open_participation_enabled: true },
      human_interface_policy: { human_channel: 'telegram' },
    },
  };
  const state = ensureRuntimeSessionState(runtime, {
    chatId: 'chat_1',
    telegramUserId: 'user_1',
    currentTurnId: 'turn_1',
    jobId: 'job_1',
  });
  assert.equal(state.session_identity.chat_id, 'chat_1');
  assert.equal(state.session_identity.thread_id, 'thread_9');
  assert.equal(state.active_turn.turn_id, 'turn_1');
  assert.equal(getRuntimeHarnessPolicy(runtime).human_interface_policy.human_channel, 'telegram');
});


test('runtime session state tracks harness attachment and participant buffer sizes', () => {
  const runtime = {
    participantContributionInbox: [{ id: 1 }, { id: 2 }],
    participantContributionSurfaceQueue: [{ id: 3 }],
    participantContributionHistory: [{ id: 4 }, { id: 5 }, { id: 6 }],
  };
  attachRuntimeHarnessState(runtime, {
    packageRef: { package_id: 'pkg.alpha', version: '1.0.0' },
    runtimePolicy: {
      participant_policy: { max_surface_per_turn: 2 },
    },
  });
  setRuntimeCurrentTurn(runtime, 'turn_2');
  syncRuntimeParticipantState(runtime, {
    registry: { participants: [{ participant_id: 'human.telegram' }] },
  });
  const state = runtime.runtimeSessionState;
  assert.equal(state.active_harness.package_ref.package_id, 'pkg.alpha');
  assert.equal(state.active_turn.turn_id, 'turn_2');
  assert.equal(state.participant_state.inbox_size, 2);
  assert.equal(state.participant_state.surface_queue_size, 1);
  assert.equal(state.participant_state.history_size, 3);
});


test('runtime session state tracks participant observability details', () => {
  const runtime = {
    participantContributionDecisionLog: [{ id: 1 }, { id: 2 }],
  };
  ensureRuntimeSessionState(runtime, { currentTurnId: 'turn_obs' });
  syncRuntimeObservabilityState(runtime, {
    participant_surface: {
      last_turn_id: 'turn_obs',
      last_folded_count: 2,
      last_folded_labels: ['Phone Scout', 'Mini Critic'],
    },
  });
  const state = runtime.runtimeSessionState;
  assert.equal(state.observability_state.participant_surface.decision_log_size, 2);
  assert.equal(state.observability_state.participant_surface.last_folded_count, 2);
  assert.deepEqual(state.observability_state.participant_surface.last_folded_labels, ['Phone Scout', 'Mini Critic']);
});
