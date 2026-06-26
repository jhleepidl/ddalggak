import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRoomPackageQuestionAnswer,
  classifyRoomPackageQuestionSignals,
  planRoomPackageQuestions,
} from '../src/application/room_package_question_planner.js';

test('does not ask passive schema-learning questions for ordinary paper discussion', () => {
  const plan = planRoomPackageQuestions({
    taskText: 'Room별 specialized memory structure를 찾는 것을 paper 4 topic으로 하자. room footprint로 schema를 학습하고 제안하자.',
    roomPackage: { domain_label: 'research_paper', memory_schema: { object_types: ['paper_claim', 'experiment_result'] } },
  });
  assert.equal(plan.kind, 'room_package_question_plan_v1');
  assert.equal(plan.should_ask, false);
  assert.equal(plan.suppressed_reason, 'no_explicit_high_impact_ambiguity');
  assert.equal(plan.policy.ask_only_when_confirmation_is_required, true);
});

test('asks exportability only for explicit high-impact export ambiguity', () => {
  const signals = classifyRoomPackageQuestionSignals({
    taskText: '다음 zip handoff bundle에 private pricing note를 포함해도 되는지 애매해.',
  });
  assert.equal(signals.has_room_package, true);
  assert.equal(signals.has_privacy_risk, true);
  assert.equal(signals.has_export_decision_request, true);
  const plan = planRoomPackageQuestions({ taskText: '다음 zip handoff bundle에 private pricing note를 포함해도 되는지 애매해.' });
  assert.equal(plan.should_ask, true);
  assert.equal(plan.questions[0].question_type, 'exportability_confirmation');
  assert.equal(plan.questions[0].requires_user_confirmation, true);
  assert.equal(plan.questions[0].interaction_style, 'inline_only_when_confirmation_needed');
});

test('does not ask when user already stated a resolved export policy', () => {
  const plan = planRoomPackageQuestions({ taskText: 'handoff bundle에는 private notes를 넣지 말자.' });
  assert.equal(plan.signals.has_resolved_negative_policy, true);
  assert.equal(plan.should_ask, false);
});

test('asks scope question only when scope is explicitly ambiguous', () => {
  const resolved = planRoomPackageQuestions({ taskText: '앞으로 전체 workflow 기본으로 해줘.' });
  assert.equal(resolved.should_ask, false);

  const ambiguous = planRoomPackageQuestions({ taskText: '이 규칙은 현재 room에만 적용할지 전체 AI Rooms에 적용할지 애매해.' });
  assert.equal(ambiguous.should_ask, true);
  assert.equal(ambiguous.questions[0].question_type, 'scope_confirmation');
});

test('applies user answer as confirmed room package policy update', () => {
  const plan = planRoomPackageQuestions({ taskText: 'handoff bundle에 private pricing note를 넣어도 될까?' });
  const event = applyRoomPackageQuestionAnswer(plan, {
    question_id: plan.questions[0].question_id,
    selected: 'internal_only',
    note: 'Do not include private pricing in exports.',
  });
  assert.equal(event.kind, 'room_package_elicitation_event_v1');
  assert.equal(event.memory_update.status, 'confirmed_by_user');
  assert.equal(event.memory_update.source, 'conversational_room_package_elicitation');
});
