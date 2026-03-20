import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnswerCapsules, findAnswerCapsuleByTelegramMessageId } from '../src/application/answer_capsules.js';
import { planAgentFollowupShortcut } from '../src/application/agent_followup_shortcuts.js';

test('buildAnswerCapsules records per-message reply anchors with inferred agent', () => {
  const capsules = buildAnswerCapsules({
    telegramMessages: [{ message_id: 101 }, { message_id: 102 }],
    replyToMessageId: 55,
    runId: 'run_1',
    jobId: 'job_1',
    routePlan: {
      final_owner_agent_id: 'synthesizer',
    },
    execution: {
      outputs: [
        { agentId: 'researcher', output: '조사 결과 초안' },
        { agentId: 'synthesizer', output: '최종 요약과 근거' },
      ],
    },
    replyText: '최종 요약입니다.',
    originalGoal: '시스템 문제를 설명해줘',
  });

  assert.equal(capsules.length, 2);
  assert.equal(capsules[0].reply_to_message_id, 55);
  assert.equal(capsules[0].agent_id, 'synthesizer');
  assert.match(capsules[0].answer_summary, /최종 요약/);
});

test('reply-anchored shortcut prefers stored capsule over recent turn heuristics', () => {
  const session = {
    answer_capsules: [
      {
        telegram_message_id: 777,
        agent_id: 'reviewer',
        answer_summary: '이전 답변에서는 reviewer가 위험요소를 지적했다.',
        answer_excerpt: '리스크는 runtime helper 경계가 불안정하다는 점이다.',
        original_goal_summary: '코드 구조를 검토하고 문제를 찾아라.',
        evidence_refs: ['runtime_metadata.js'],
        artifact_refs: ['reports/findings.md'],
      },
    ],
    recent_agent_turns: [
      {
        agent_id: 'researcher',
        provider: 'gemini',
        role: 'researcher',
        goal: '최근 조사',
        output: 'research output',
      },
    ],
  };

  const planned = planAgentFollowupShortcut({
    message: '이 부분을 좀 더 자세히 설명해줘',
    replyToMessageId: 777,
    session,
    runtime: {},
    teamConfig: {},
  });

  assert.equal(planned.matched, true);
  assert.equal(planned.reason, 'reply_anchor_capsule');
  assert.equal(planned.target_agent_id, 'reviewer');
  assert.match(planned.action.goal, /PREVIOUS ANSWER SUMMARY/);
  assert.equal(findAnswerCapsuleByTelegramMessageId(session, 777)?.agent_id, 'reviewer');
});
