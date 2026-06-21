import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPublicRoomEvolutionExport,
  buildRoomLearningEvent,
  extractRoomLearningSignals,
  formatRoomEvolutionSnapshot,
  proposeRoomEvolution,
} from '../src/application/room_evolution.js';

test('room learning signals are generic and capture emergent memory/tool needs', () => {
  const signals = extractRoomLearningSignals({
    command: '/ask',
    text: '오늘 점심 뭐 먹을까? 어제는 김치찌개 먹었고 매운 건 별로야. 근처 식당도 검색해줘.',
  });
  assert.equal(signals.preference_signal, true);
  assert.equal(signals.observation_event_signal, true);
  assert.equal(signals.external_search_signal, true);
  assert.ok(signals.candidate_object_types.includes('meal_or_intake_event'));
});

test('room evolution proposes dynamic schema/components without auto applying them', () => {
  const events = [
    buildRoomLearningEvent({ command: '/ask', text: '오늘 점심 메뉴 추천해줘. 매운 건 별로야.' }),
    buildRoomLearningEvent({ command: '/ask', text: '어제는 김치찌개 먹었고 오늘은 가벼운 음식 추천해줘.' }),
    buildRoomLearningEvent({ command: '/ask', text: '사진 올릴게. 이 식사 대략 칼로리 추정하고 기록해줘.', attachments: [{ mime_type: 'image/jpeg' }] }),
    buildRoomLearningEvent({ command: '/ask', text: '최근 식사 패턴을 분석해줘. 나중에는 DB로 쿼리하고 싶어.' }),
  ];
  const snapshot = proposeRoomEvolution({ events });
  assert.equal(snapshot.governance.ai_role, 'architect_advisor_proposer_not_controller');
  assert.equal(snapshot.governance.auto_apply, false);
  assert.ok(snapshot.proposals.some((p) => p.proposal_type === 'memory_schema'));
  assert.ok(snapshot.proposals.some((p) => p.proposal_id === 'agent:image_interpreter'));
  assert.ok(snapshot.proposals.some((p) => p.proposal_type === 'memory_materialization'));
  assert.ok(snapshot.proposals.some((p) => p.proposal_type === 'gateway_or_board'));
  assert.match(formatRoomEvolutionSnapshot(snapshot), /AI proposes/);
});

test('public room evolution export strips raw text and private records', () => {
  const event = buildRoomLearningEvent({
    command: '/ask',
    text: '개인 식사 기록: 어제 김치찌개 먹었어. 이건 raw text로 공유되면 안 됨.',
  });
  const snapshot = proposeRoomEvolution({ events: [event] });
  const exported = buildPublicRoomEvolutionExport(snapshot);
  const json = JSON.stringify(exported);
  assert.equal(exported.privacy.includes_raw_text, false);
  assert.equal(exported.privacy.includes_private_memory, false);
  assert.equal(json.includes('김치찌개'), false);
});
