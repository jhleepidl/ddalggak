import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoomLearningEvent, proposeRoomEvolution, buildPublicRoomEvolutionExport } from '../src/application/room_evolution.js';
import { buildRoomSkillDiscoveryBundle, buildMemorySchemaTrialPlan } from '../src/application/room_skill_discovery.js';

function event(text, command = '/ask') {
  return buildRoomLearningEvent({ chatId: 'room-a', userId: 'u', command, text });
}

test('room evolution includes Ctx2Skill-inspired probe and Paper 4 trial bundle', () => {
  const events = [
    event('오늘 저녁 뭐 먹을까? 나는 버섯은 싫어해'),
    event('어제는 파스타 먹었어. 기록해줘'),
    event('최근 식사 패턴을 분석해서 추천해줘'),
    event('사진 업로드할게. 대략적인 영양을 추정하고 확인 질문해줘'),
  ];
  const snapshot = proposeRoomEvolution({ events });

  assert.equal(snapshot.skill_discovery.kind, 'room_skill_discovery_bundle_v1');
  assert.ok(snapshot.skill_discovery.probe_suite.probes.length >= 2);
  assert.equal(snapshot.paper4_trial_plan.kind, 'paper4_memory_schema_trial_plan_v1');
  assert.ok(snapshot.paper4_trial_plan.novelty_claims.some((claim) => claim.includes('room-scoped intervention')));
  assert.equal(snapshot.skill_discovery.governance.direct_memory_write, false);
});

test('memory schema trial plan names baselines and staged treatments', () => {
  const aggregate = {
    counts: { total_events: 5, observation_event: 3, aggregate_query: 2, database_need: 1 },
    top_objects: [{ id: 'meal_or_intake_event', count: 4 }],
  };
  const plan = buildMemorySchemaTrialPlan({ aggregate, proposals: [] });
  assert.ok(plan.treatments.some((t) => t.id === 'T4_shadow_queryable_store'));
  assert.ok(plan.baselines.includes('all_memory_in_context'));
  assert.ok(plan.trial_axes.includes('privacy_boundary_preservation'));
});

test('skill discovery public export remains private-memory safe via room evolution export', () => {
  const snapshot = proposeRoomEvolution({ events: [event('점심 기록해줘: 김밥 먹었고 다음엔 덜 짜게 추천해줘')] });
  const exported = buildPublicRoomEvolutionExport(snapshot);
  assert.equal(exported.privacy.includes_raw_text, false);
  assert.equal(exported.privacy.includes_private_memory, false);
  assert.equal(exported.privacy.includes_uploaded_files, false);
});

