import test from 'node:test';
import assert from 'node:assert/strict';

import { recommendTeamBlueprintCandidates, scoreTeamBlueprintCandidate } from '../src/application/team_composer_advisor.js';

test('scoreTeamBlueprintCandidate uses structured features instead of whole serialized manifest', () => {
  const score = scoreTeamBlueprintCandidate({
    taskText: 'Implement a code patch in the repo and verify it',
    blueprint: {
      blueprint_id: 'impl_team',
      title: 'Implementation Strike Team',
      description: 'Inspect a repository, implement a scoped patch, verify it, and summarize the change.',
      task_archetype: 'implementation',
      structure: {
        participants: [
          { role: 'researcher', name: 'Repo Scout' },
          { role: 'builder', name: 'Builder' },
          { role: 'reviewer', name: 'Reviewer' },
        ],
      },
      topology: { pattern: 'sequential', participants: [{ role: 'researcher' }, { role: 'builder' }, { role: 'reviewer' }], edges: [] },
      memory_plan: {
        surfaces: [
          { surface_id: 'working_memory', write_policy: 'shared', semantic_slots: ['progress'] },
          { surface_id: 'final_answer', write_policy: 'final', semantic_slots: ['final_answer'] },
        ],
      },
      catalog: { tags: ['implementation', 'repo'], good_for: ['repo fixes'] },
    },
  });

  assert.ok(score.semantic_score >= 3);
  assert.equal(score.feature_score_breakdown.implementation_boost, 4);
  assert.equal(score.memory_fit.final_answer_surface_ready, true);
  assert.ok(score.rationale.includes('final_answer_surface_ready'));
});

test('recommendTeamBlueprintCandidates prefers implementation for code task', () => {
  const candidates = recommendTeamBlueprintCandidates({ taskText: 'Implement a code patch in the repo and verify it', limit: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].task_archetype, 'implementation');
  assert.ok(candidates[0].feature_score_breakdown);
  assert.ok(Array.isArray(candidates[0].rationale));
});
