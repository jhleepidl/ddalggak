import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskArchetypeBlueprintDocument, listTeamBlueprintTemplates } from '../src/application/team_blueprint.js';

test('task archetype templates expose research/implementation/review_repair/iterative_improvement blueprints', () => {
  const templates = listTeamBlueprintTemplates();
  const ids = templates.map((entry) => entry.task_archetype).sort();
  assert.deepEqual(ids, ['implementation', 'iterative_improvement', 'research', 'review_repair']);
  for (const entry of templates) {
    assert.equal(entry.blueprint_document.kind, 'ddalggak_team_blueprint');
    assert.ok(Array.isArray(entry.blueprint_document.blueprint.memory_plan.surfaces));
    assert.ok(entry.blueprint_document.blueprint.memory_map.length >= 4);
  }
});

test('review_repair template produces canonical blueprint without legacy manifest aliases', () => {
  const doc = buildTaskArchetypeBlueprintDocument('review_repair', { taskBrief: '회귀 원인 분석 후 최소 수정안 제시' });
  assert.equal(doc.kind, 'ddalggak_team_blueprint');
  assert.equal(doc.primary_schema, 'team_blueprint_v1');
  assert.equal(doc.blueprint.task_archetype, 'review_repair');
  assert.equal(typeof doc.legacy_manifest_alias, 'undefined');
  assert.ok(doc.blueprint.team_seed.memory_plan.surfaces.some((surface) => surface.surface_id === 'defect_log'));
});


test('iterative_improvement template exposes builder-reviewer loop with bounded iteration policy', () => {
  const doc = buildTaskArchetypeBlueprintDocument('iterative_improvement', { taskBrief: '코드를 계속 개선하고 여러 모델로 검토해줘' });
  assert.equal(doc.blueprint.task_archetype, 'iterative_improvement');
  assert.equal(doc.blueprint.team_seed.interaction_spec.execution_pattern, 'builder_reviewer_loop');
  assert.equal(doc.blueprint.team_seed.runtime_execution?.continuous_improvement?.max_turns, 6);
  assert.ok(doc.blueprint.team_seed.memory_plan.surfaces.some((surface) => surface.surface_id === 'critic_log'));
});
