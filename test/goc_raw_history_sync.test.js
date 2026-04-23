import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRawHistorySnapshot } from '../src/application/goc_raw_history_sync.js';


test('buildRawHistorySnapshot produces board-only history metadata without raw secrets', () => {
  const snapshot = buildRawHistorySnapshot({
    chatId: '12345',
    session: {
      state: 'running',
      updated_at: '2026-04-23T12:00:00Z',
      active_run_id: 'run_1',
      pending_user_messages: [{ ts: '2026-04-23T11:58:00Z', text: 'Please review this patch', force_mode: 'normal' }],
      recent_agent_turns: [{ ts: '2026-04-23T11:59:00Z', agent_name: 'Researcher', role: 'analyst', provider: 'openai', model: 'gpt-5', goal: 'find issues', output: 'Found 2 likely regressions' }],
      answer_capsules: [{ ts: '2026-04-23T12:00:00Z', label: 'summary', text: 'Patch is mostly safe' }],
    },
    runtime: { map: { threadId: 'thread_1', ctxSharedId: 'ctx_1', memoryMode: 'goc' }, executionMode: 'multi_agent' },
    teamState: {
      active_team: {
        team_name: 'Patch Crew',
        agents: [{ role: 'analyst', attached_skill_ids: ['skill.kskill_srt_booking.v1'] }],
      },
    },
    credentialBindingState: {
      summary: { bound_count: 2 },
      bindings: [{ credential_key: 'OPENAI_API_KEY', reference_kind: 'env' }],
      raw_secret_value: 'should-never-appear',
    },
  });

  assert.equal(snapshot.source, 'ddalggak');
  assert.equal(snapshot.auto_activate, false);
  assert.equal(snapshot.update_latest, true);
  assert.equal(snapshot.stream_key, 'chat:12345');
  assert.match(snapshot.raw_text, /raw history snapshot/i);
  assert.match(snapshot.raw_text, /Researcher/);
  assert.match(snapshot.raw_text, /credential_bindings: 2/);
  assert.doesNotMatch(snapshot.raw_text, /should-never-appear/);
  assert.equal(Array.isArray(snapshot.extracted_artifacts), true);
  assert.equal(snapshot.extracted_artifacts[0].kind, 'team_blueprint_reference');
  assert.equal(snapshot.extracted_artifacts.some((entry) => entry.kind === 'skill_package_reference' && entry.skill_id === 'skill.kskill_srt_booking.v1'), true);
});
