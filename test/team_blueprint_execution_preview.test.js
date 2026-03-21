import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExecutionBlueprintSummary, formatExecutionBlueprintSummaryLines } from '../src/application/team_blueprint.js';
import { createRuntimeTeamSnapshot } from '../src/application/runtime_metadata.js';

test('execution blueprint summary infers implementation template from coding goal', () => {
  const summary = resolveExecutionBlueprintSummary({
    goal: 'Implement a new feature in this repository and add tests',
  });
  assert.equal(summary.task_archetype, 'implementation');
  assert.equal(summary.source, 'task_archetype_template');
  assert.ok(Array.isArray(summary.memory_map));
  assert.ok(summary.memory_map.some((surface) => surface.surface_id === 'implementation_notes'));
  const lines = formatExecutionBlueprintSummaryLines(summary);
  assert.ok(lines.some((line) => /task archetype: implementation/i.test(line)));
  assert.ok(lines.some((line) => /memory map:/i.test(line)));
});

test('runtime snapshot preserves blueprint summary metadata', () => {
  const snapshot = createRuntimeTeamSnapshot({
    teamPlan: { slots: [] },
    runtimeAgents: [],
    blueprintSummary: {
      title: 'Implementation Strike Team',
      task_archetype: 'implementation',
      execution_pattern: 'sequential_with_review',
      memory_map: [
        { surface_id: 'mission_brief', load_policy: 'always', write_policy: 'shared' },
        { surface_id: 'implementation_notes', load_policy: 'always', write_policy: 'shared' },
      ],
    },
  });
  assert.equal(snapshot.blueprint_summary?.task_archetype, 'implementation');
  assert.equal(snapshot.blueprint_summary?.execution_pattern, 'sequential_with_review');
  assert.equal(snapshot.blueprint_summary?.memory_map?.[1]?.surface_id, 'implementation_notes');
});


test('execution blueprint summary infers iterative improvement template from repeated-improvement goal', () => {
  const summary = resolveExecutionBlueprintSummary({
    goal: '이 저장소를 여러 모델로 계속 개선하고 반복적으로 검토해줘',
  });
  assert.equal(summary.task_archetype, 'iterative_improvement');
  assert.equal(summary.execution_pattern, 'builder_reviewer_loop');
  assert.ok(summary.memory_map.some((surface) => surface.surface_id === 'critic_log'));
});
