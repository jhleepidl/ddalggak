import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapTelegramRuntimeSession } from '../src/application/telegram_runtime_session.js';

function createSessionStore(initial = {}) {
  const sessions = new Map(Object.entries(initial));
  return {
    get(key) {
      return sessions.get(String(key));
    },
    upsert(key, valueOrFn) {
      const current = sessions.get(String(key)) || {};
      const next = typeof valueOrFn === 'function' ? valueOrFn(current) : valueOrFn;
      sessions.set(String(key), next);
      return next;
    },
  };
}

test('bootstrapTelegramRuntimeSession applies install state and registers human interface state', () => {
  const sessionStore = createSessionStore({
    chat_7: {
      openharness_install_state: {
        package_ref: { package_id: 'pkg.beta', version: '2.0.0' },
        runtime_policy: {
          participant_policy: {
            open_participation_enabled: true,
            max_surface_per_turn: 1,
          },
          human_interface_policy: {
            human_channel: 'telegram',
            external_contribution_mode: 'folded_only',
          },
        },
      },
    },
  });
  const runtime = { map: { threadId: 'thread_77' } };
  const result = bootstrapTelegramRuntimeSession({
    runtime,
    sessionStore,
    chatId: 'chat_7',
    telegramUserId: 'user_77',
    currentTurnId: 'turn_77',
    jobId: 'job_77',
  });
  assert.equal(result.installedHarnessState.package_ref.package_id, 'pkg.beta');
  assert.equal(runtime.harnessPackageRef.package_id, 'pkg.beta');
  assert.equal(runtime.runtimeBehavior.human_interface.human_channel, 'telegram');
  assert.equal(runtime.runtimeSessionState.session_identity.chat_id, 'chat_7');
  assert.equal(runtime.runtimeSessionState.active_turn.turn_id, 'turn_77');
  assert.equal(runtime.participantRegistry.human_interface_participant_id, 'human.telegram');
});
