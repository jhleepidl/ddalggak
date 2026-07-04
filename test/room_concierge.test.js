import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDirectAskPrompt,
  buildSearchAskFallbackPrompt,
  classifyRoomConciergeRoute,
  shouldUseDirectAskFastPath,
  shouldUseSearchAskPath,
} from '../src/application/room_concierge.js';

test('short low-risk /chat uses direct fast path', () => {
  const decision = classifyRoomConciergeRoute({ text: '오늘 저녁 메뉴 추천해줘', command: '/chat' });
  assert.equal(decision.route, 'concierge_direct_answer');
  assert.equal(decision.should_bypass_workbench, true);
  assert.equal(decision.should_show_plan_preview, false);
  assert.equal(shouldUseDirectAskFastPath(decision), true);
});

test('legacy /ask remains supported as a conversational command', () => {
  const decision = classifyRoomConciergeRoute({ text: '간단히 설명해줘', command: '/ask' });
  assert.equal(decision.route, 'concierge_direct_answer');
  assert.equal(decision.should_bypass_workbench, true);
});

test('search or freshness request uses bounded search fast path', () => {
  const decision = classifyRoomConciergeRoute({ text: '실제로 해당 식당 메뉴판을 검색해서 추천해줘', command: '/ask' });
  assert.equal(decision.route, 'concierge_search_answer');
  assert.equal(decision.should_bypass_workbench, true);
  assert.equal(decision.should_show_plan_preview, false);
  assert.equal(decision.answer_mode, 'bounded_search_minimal_prompt');
  assert.equal(shouldUseDirectAskFastPath(decision), false);
  assert.equal(shouldUseSearchAskPath(decision), true);
  assert.ok(decision.signals.includes('search_or_freshness_intent'));
});

test('workspace and code tasks stay in standard workbench', () => {
  const decision = classifyRoomConciergeRoute({ text: '첨부 zip을 확인해서 코드를 패치하고 테스트 돌려줘', command: '/ask' });
  assert.equal(decision.route, 'standard_workbench');
  assert.ok(decision.blockers.includes('needs_workspace_or_artifact'));
});

test('team and review requests escalate out of direct fast path', () => {
  const decision = classifyRoomConciergeRoute({ text: '여러 에이전트가 토론해서 리뷰해줘', command: '/ask' });
  assert.equal(decision.route, 'team_orchestration');
  assert.ok(decision.blockers.includes('needs_team_or_review'));
});

test('direct prompt keeps routing internals out of user-facing answer request', () => {
  const prompt = buildDirectAskPrompt({ question: '간단히 설명해줘', roomName: '메뉴추천' });
  assert.match(prompt, /direct chat mode/);
  assert.match(prompt, /Do not mention routing, agents, plans/);
  assert.match(prompt, /간단히 설명해줘/);
  assert.match(prompt, /USER-FACING LANGUAGE/);
  assert.match(prompt, /natural Korean/);
});

test('learned concierge model can safely escalate a direct-looking ask to workbench', () => {
  const learnedModel = {
    kind: 'room_concierge_model_v1',
    version: 'test-escalator',
    policy: { enabled: true, min_confidence: 0.55, allow_safe_escalation: true, allow_direct_override: false },
    route_weights: {
      standard_workbench: { bias: 3, signal_simple_qa: 0.1 },
      concierge_direct_answer: { bias: 0, signal_simple_qa: 0.1 },
    },
  };
  const decision = classifyRoomConciergeRoute({
    text: '오늘 저녁 메뉴 추천해줘',
    command: '/ask',
    learnedModel,
  });
  assert.equal(decision.route, 'standard_workbench');
  assert.equal(decision.learned_model.applied, true);
  assert.equal(decision.learned_model.base_route, 'concierge_direct_answer');
});

test('learned concierge model cannot force direct path across hard blockers by default', () => {
  const learnedModel = {
    kind: 'room_concierge_model_v1',
    version: 'test-direct-forcer',
    policy: { enabled: true, min_confidence: 0.55, allow_safe_escalation: true, allow_direct_override: false },
    route_weights: {
      concierge_direct_answer: { bias: 5 },
      standard_workbench: { bias: 0 },
    },
  };
  const decision = classifyRoomConciergeRoute({
    text: '첨부 파일을 보고 간단히 답해줘',
    command: '/ask',
    hasAttachment: true,
    learnedModel,
  });
  assert.notEqual(decision.route, 'concierge_direct_answer');
  assert.equal(decision.learned_model.applied, false);
  assert.equal(decision.learned_model.reason, 'direct_override_disabled');
});

test('search fallback prompt forbids inventing unavailable fresh facts', () => {
  const prompt = buildSearchAskFallbackPrompt({ question: '실제 메뉴를 검색해서 추천해줘', maxSeconds: 12 });
  assert.match(prompt, /search-intent mode/);
  assert.match(prompt, /no reliable source is available/);
  assert.match(prompt, /실제 메뉴를 검색해서 추천해줘/);
});

test('artifact/image follow-up asks for workbench artifact context instead of stale direct answer', () => {
  const decision = classifyRoomConciergeRoute({ text: '전에 upload로 메뉴 이미지 올렸잖아. 그 이미지 보고 주류 추천해줘', command: '/ask' });
  assert.equal(decision.route, 'standard_workbench');
  assert.ok(decision.signals.includes('artifact_reference_intent'));
  assert.ok(decision.blockers.includes('needs_artifact_context'));
  assert.equal(decision.should_show_plan_preview, true);
});

test('direct prompt pins the latest user request over previous-room state', () => {
  const prompt = buildDirectAskPrompt({ question: '오늘 저녁 혼자 배달시켜먹을 메뉴 추천해줘' });
  assert.match(prompt, /LATEST TURN IS AUTHORITATIVE/);
  assert.match(prompt, /answer only the user question below/);
});

test('search prompt includes room continuity context when provided', () => {
  const prompt = buildSearchAskFallbackPrompt({
    question: '배달해서 먹을만한 곳은 없을까? 실제 있는 식당으로 검색해서 찾아줘.',
    context: '[ROOM CONTINUITY — HIGH PRIORITY]\n- user: 서울대입구역 주변에서 먹을만한 식당으로 추천해줘.',
  });
  assert.match(prompt, /ROOM CONTINUITY/);
  assert.match(prompt, /서울대입구역/);
  assert.match(prompt, /omitted referents, constraints, preferences/);
});

test('search prompt does not treat continuity as external verification evidence', () => {
  const prompt = buildSearchAskFallbackPrompt({
    question: '실제로 서울대입구 주변에서 시킬 수 있는 검증된 음식 메뉴들이야?',
    context: '[ROOM CONTEXT STATE]\nunverified_assistant_recommendations: 포케올데이 / 샐러디\nwarnings: previous_assistant_recommendations_are_unverified',
  });
  assert.match(prompt, /previous assistant recommendations.*NOT external evidence/i);
  assert.match(prompt, /Do not answer.*verified/i);
});
