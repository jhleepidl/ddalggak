import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendTeamBlueprintCandidates, scoreTeamBlueprintCandidate } from '../src/application/team_composer_advisor.js';
import { buildTeamSeedFromTaskArchetype } from '../src/application/team_blueprint_templates.js';
import { attachTeamBlueprint } from '../src/application/team_blueprint.js';

test('team composer advisor ranks implementation archetype for code task', () => {
  const candidates = recommendTeamBlueprintCandidates({ taskText: 'Implement a code patch and modify the repo files', limit: 2 });
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].task_archetype, 'implementation');
  assert.ok(candidates[0].executable_definition.member_count >= 1);
});

test('team composer score exposes topology and memory fit', () => {
  const seed = buildTeamSeedFromTaskArchetype('review_repair', { taskBrief: 'Review and repair a regression bug' });
  const attached = attachTeamBlueprint(seed, { applyState: 'pending', source: 'test' });
  const scored = scoreTeamBlueprintCandidate({ taskText: 'Review and repair a regression bug', blueprint: attached.team_blueprint });
  assert.equal(scored.archetype, 'review_repair');
  assert.ok(typeof scored.topology.pattern === 'string');
  assert.ok(typeof scored.memory_fit.final_answer_surface_ready === 'boolean');
});
