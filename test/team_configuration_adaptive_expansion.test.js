import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTeamConfiguration } from '../src/application/team_configuration.js';

test('validateTeamConfiguration preserves adaptive expansion planner metadata', () => {
  const team = validateTeamConfiguration({
    team_name: 'starter_expand',
    composition_mode: 'structured',
    proposal_mode: 'refine',
    status: 'suggested',
    task_brief: '코드 수정 후 검토',
    agents: [
      {
        agent_id: 'builder',
        name: 'Builder',
        role: 'builder',
        model: 'gpt-5.4',
        provider: 'codex',
        skills: ['repo.patch'],
      },
      {
        agent_id: 'reviewer',
        name: 'Reviewer',
        role: 'reviewer',
        model: 'gemini-2.5-pro',
        provider: 'gemini',
        skills: ['review.code'],
      },
    ],
    interaction_spec: {
      execution_pattern: 'builder_reviewer_loop',
      final_answer_owner: 'Builder',
      handoffs: [{ from: 'Builder', to: 'Reviewer', when: 'after implementation' }],
      reviewer_visibility: 'folded',
      builder_direct_response: true,
    },
    planner_metadata: {
      planner_type: 'codex_cli',
      planning_source: 'adaptive_refine',
      adaptive_expansion: {
        recommendation: 'expand_team',
        rationale: ['independent sidecar is justified'],
        augmentation: { score: 2.1, reasons: ['missing_capability_or_skill'] },
        role_separation: {
          score: 3.4,
          reasons: ['independent_review_required'],
          independent_review_needed: true,
          persistent_split_needed: false,
        },
        capability_gap_summary: 'missing_capability:review.code',
      },
    },
  });
  assert.equal(team.planner_metadata?.adaptive_expansion?.recommendation, 'expand_team');
  assert.equal(team.planner_metadata?.adaptive_expansion?.role_separation?.independent_review_needed, true);
  assert.equal(team.planner_metadata?.adaptive_expansion?.capability_gap_summary, 'missing_capability:review.code');
});
