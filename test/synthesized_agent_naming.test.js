import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';

function labelsFor(input) {
  const result = buildRuntimeOrchestration(input);
  return (result?.runtime_agents || []).map((agent) => ({
    role: agent.role_id,
    label: agent.display_label,
    synthesized: agent.synthesized,
  }));
}

test('synthesized finance researcher/reviewer labels are more descriptive', () => {
  const labels = labelsFor({
    goal: '삼성전자 최근 뉴스와 공시를 바탕으로 투자 포인트와 리스크를 정리해줘',
  });
  const researcher = labels.find((item) => item.role === 'researcher');
  const reviewer = labels.find((item) => item.role === 'reviewer');
  const synthesizer = labels.find((item) => item.role === 'synthesizer');
  assert.ok(researcher);
  assert.ok(reviewer);
  assert.ok(synthesizer);
  assert.notEqual(researcher.label, 'Researcher');
  assert.notEqual(reviewer.label, 'Reviewer');
  assert.notEqual(synthesizer.label, 'Synthesizer');
});

test('synthesized code builder/reviewer labels reflect implementation intent', () => {
  const labels = labelsFor({
    goal: '파이썬으로 CSV를 읽고 요약 통계를 출력하는 스크립트를 작성해줘',
  });
  const builder = labels.find((item) => item.role === 'builder');
  const reviewer = labels.find((item) => item.role === 'reviewer');
  assert.ok(builder);
  assert.ok(reviewer);
  assert.match(builder.label, /Builder/i);
  assert.notEqual(builder.label, 'Builder');
});
