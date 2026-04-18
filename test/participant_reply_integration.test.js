import test from 'node:test';
import assert from 'node:assert/strict';

import { appendFoldedContributionDigest, buildFoldedContributionPromptBlock, collectFoldedParticipantSignals, recordFoldedParticipantSignals } from '../src/application/participant_reply_integration.js';
import { submitRuntimeParticipantContribution } from '../src/application/runtime_participant_gateway.js';
import { synthesizeChatReply } from '../src/application/telegram_chat_execution.js';

async function seedFoldedSignal(runtime, { participantId = 'phone.scout', label = 'Phone Scout', kind = 'summary', content = '로컬 문서에서 일정 메모를 발견함', confidence = 0.91 } = {}) {
  return await submitRuntimeParticipantContribution({
    runtime,
    descriptor: {
      participant_id: participantId,
      participant_type: 'device_scout',
      label,
      visibility_default: 'may_surface',
      channel_mode: 'ambient',
      privacy_scope: 'summary_only',
    },
    contribution: {
      contribution_kind: kind,
      content,
      confidence,
      turn_id: runtime.currentTurnId,
    },
  });
}

test('collectFoldedParticipantSignals consumes foldable contributions and builds prompt/digest blocks', async () => {
  const runtime = {
    harnessRuntimePolicy: {
      participant_policy: {
        open_participation_enabled: true,
        max_surface_per_turn: 1,
        surface_candidate_kinds: ['summary', 'critique', 'evidence'],
      },
      human_interface_policy: {
        external_contribution_mode: 'folded_only',
      },
    },
    currentTurnId: 'turn_ctx',
    sessionId: 'session_ctx',
    map: { threadId: 'thread_ctx' },
  };
  await seedFoldedSignal(runtime);
  const folded = collectFoldedParticipantSignals(runtime, { turnId: 'turn_ctx' });
  assert.equal(folded.items.length, 1);
  assert.match(folded.prompt_block, /Participant signals/);
  assert.match(folded.prompt_block, /Summaries and hints/);
  assert.match(folded.digest_block, /참고 신호/);
  assert.deepEqual(folded.kind_counts, { summary: 1 });
  assert.equal(runtime.participantContributionSurfaceQueue.length, 0);
  assert.equal(runtime.runtimeSessionState.observability_state.participant_surface.last_folded_count, 1);
});

test('appendFoldedContributionDigest appends a readable note block', () => {
  const text = appendFoldedContributionDigest('기본 답변입니다.', {
    digest_block: '참고 신호:\n- Phone Scout: 일정 메모 발견',
  });
  assert.match(text, /기본 답변입니다/);
  assert.match(text, /참고 신호/);
});

test('synthesizeChatReply includes folded participant digest in fallback paths', async () => {
  const runtime = {
    harnessRuntimePolicy: {
      participant_policy: {
        open_participation_enabled: true,
        max_surface_per_turn: 1,
        surface_candidate_kinds: ['summary', 'critique', 'evidence'],
      },
      human_interface_policy: {
        external_contribution_mode: 'folded_only',
      },
    },
    currentTurnId: 'turn_fallback',
    currentJobId: 'job_fallback',
    sessionId: 'session_fallback',
    map: { threadId: 'thread_fallback' },
    runEventSink: {
      events: [],
      async recordAgentEvent(eventType, payload) {
        this.events.push({ eventType, payload });
      },
    },
  };
  await seedFoldedSignal(runtime, { content: '로컬 파일에 관련 TODO와 날짜 후보가 있음' });
  const text = await synthesizeChatReply('일정 정리해줘', { runtime, reason: 'test' }, {
    runtime,
    outputs: [],
    results: [],
  });
  assert.match(text, /참고 신호/);
  assert.match(text, /요약\/힌트/);
  assert.match(text, /날짜 후보/);
  assert.equal(runtime.runEventSink.events.length, 1);
  assert.equal(runtime.runEventSink.events[0].eventType, 'participant.folded_digest');
  assert.equal(runtime.runtimeSessionState.observability_state.participant_surface.last_digest_turn_id, 'turn_fallback');
});

test('recordFoldedParticipantSignals deduplicates repeated folded digests for the same turn', async () => {
  const runtime = {
    currentTurnId: 'turn_repeat',
    currentJobId: 'job_repeat',
    runtimeSessionState: {
      observability_state: {
        participant_surface: {},
      },
    },
    runEventSink: {
      events: [],
      async recordAgentEvent(eventType, payload) {
        this.events.push({ eventType, payload });
      },
    },
  };
  const folded = {
    mode: 'folded_only',
    items: [{ participant: { participant_id: 'phone.scout', label: 'Phone Scout' }, contribution: { contribution_id: 'c1', kind: 'summary' } }],
    prompt_block: 'Participant signals',
    digest_block: '참고 신호',
  };

  const first = await recordFoldedParticipantSignals(runtime, folded, { turnId: 'turn_repeat' });
  const second = await recordFoldedParticipantSignals(runtime, folded, { turnId: 'turn_repeat' });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(runtime.runEventSink.events.length, 1);
});

test('buildFoldedContributionPromptBlock summarizes contributor labels and confidence', () => {
  const block = buildFoldedContributionPromptBlock([
    {
      participant: { label: 'Mini Critic', participant_id: 'mini.critic' },
      contribution: { kind: 'critique', summary: '숫자 충돌 가능성', confidence: 0.82 },
    },
  ]);
  assert.match(block, /Mini Critic/);
  assert.match(block, /82%/);
  assert.match(block, /critique/);
});


test('buildFoldedContributionPromptBlock groups critique and evidence separately', () => {
  const block = buildFoldedContributionPromptBlock([
    {
      participant: { label: 'Mini Critic', participant_id: 'mini.critic' },
      contribution: { kind: 'critique', summary: '숫자 충돌 가능성', confidence: 0.82 },
    },
    {
      participant: { label: 'Phone Scout', participant_id: 'phone.scout' },
      contribution: { kind: 'evidence', summary: '로컬 문서에 일정 초안이 있음', confidence: 0.9 },
    },
  ]);
  assert.match(block, /Critiques and conflict checks/);
  assert.match(block, /Evidence and observations/);
  assert.match(block, /Mini Critic/);
  assert.match(block, /Phone Scout/);
});
