import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExecutionInsightSnapshot } from '../src/application/team_execution_insights.js';

test('buildExecutionInsightSnapshot summarizes selection reasons and observed participation', () => {
  const snapshot = buildExecutionInsightSnapshot({
    runtimeTeamSnapshot: {
      task_interpretation: {
        task_type: 'code_change',
        deliverable_type: 'software_delivery',
        parallelism_preference: 'hybrid',
        review_policy: 'code_default',
        preferred_role_ids: ['builder', 'reviewer', 'synthesizer'],
      },
      runtime_agents: [
        { template_id: 'builder', role_id: 'builder', display_label: 'Builder', selection_reason: 'web service build requires implementation coverage' },
        { template_id: 'reviewer', role_id: 'reviewer', display_label: 'Reviewer', selection_reason: 'code changes default to reviewer coverage' },
        { template_id: 'synthesizer', role_id: 'synthesizer', display_label: 'Delivery Owner', selection_reason: 'software delivery tasks benefit from final handoff owner' },
      ],
      selection_explanations: [
        { subject_id: 'team_plan', reason: 'builder/reviewer loop selected for implementation-heavy request' },
      ],
      blueprint_summary: {
        execution_pattern: 'builder_reviewer_loop',
      },
    },
    actions: [
      { type: 'run_agent', agent_id: 'builder', inputs: { role_id: 'builder', display_label: 'Builder' } },
      { type: 'run_agent', agent_id: 'reviewer', inputs: { role_id: 'reviewer', display_label: 'Reviewer' } },
      { type: 'synthesize_final', agent_id: 'synthesizer', inputs: { role_id: 'synthesizer', display_label: 'Delivery Owner' } },
    ],
    outputs: [
      { agentId: 'builder', output: 'patched workspace', jobId: 'job1' },
      { agentId: 'reviewer', output: 'reviewed patch', jobId: 'job1' },
    ],
    currentJobId: 'job1',
  });

  assert.equal(snapshot.execution_pattern, 'builder_reviewer_loop');
  assert.match(snapshot.selection.selected.join('\n'), /Builder\(구현\)/);
  assert.match(snapshot.selection.selected.join('\n'), /team_plan: builder\/reviewer loop selected/);
  assert.match(snapshot.selection.planner_facts.join(', '), /deliverable=software_delivery/);
  assert.equal(snapshot.execution.planned_agent_count, 3);
  assert.equal(snapshot.execution.observed_agent_count, 2);
  assert.equal(snapshot.execution.participation_pct, 66.7);
  assert.deepEqual(snapshot.execution.missing_agents, ['Delivery Owner']);
  assert.match(snapshot.execution.participation_by_role.join(', '), /구현 1\/1/);
  assert.match(snapshot.execution.participation_by_role.join(', '), /검토 1\/1/);
  assert.match(snapshot.execution.participation_by_role.join(', '), /최종 정리 0\/1/);
  assert.deepEqual(snapshot.overlays, []);
});
