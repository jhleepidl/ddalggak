import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { jobs } from '../src/application/telegram_runtime_state.js';
import { recordExecutionFeedback, loadExecutionFeedbackSummary } from '../src/application/execution_feedback.js';
import { normalizeRuntimeMetadataEnvelope, buildRuntimeMetadataPatch } from '../src/application/runtime_metadata.js';

test('recordExecutionFeedback aggregates pattern and overlay stats', () => {
  const created = jobs.createJob({ title: 'job-feedback-stats' });
  const jobDir = created.dir;
  try {
    fs.writeFileSync(path.join(jobDir, 'prompt_metrics.jsonl'), [
      JSON.stringify({ ts: new Date().toISOString(), overlay: { overlay_id: 'agency:engineering/frontend-developer', overlay_title: 'Frontend Developer', tokens: 80, share_pct: 10 } }),
      JSON.stringify({ ts: new Date().toISOString(), overlay: { overlay_id: 'agency:engineering/frontend-developer', overlay_title: 'Frontend Developer', tokens: 100, share_pct: 12 } }),
    ].join('\n') + '\n', 'utf8');

    const result = recordExecutionFeedback({
      jobDir,
      runId: 'run_1',
      status: 'done',
      runtimeTeamSnapshot: {
        runtime_agents: [
          { role_id: 'builder', agency_overlay_id: 'agency:engineering/frontend-developer', agency_overlay: { display: { title: 'Frontend Developer' } } },
        ],
      },
      executionInsights: {
        execution_pattern: 'builder_reviewer_loop',
        execution: {
          planned_agent_count: 3,
          observed_agent_count: 2,
          participation_pct: 66.7,
          missing_agents: ['Delivery Owner'],
          participation_by_role: ['구현 1/1', '검토 1/1', '최종 정리 0/1'],
        },
      },
    });

    assert.equal(result.record.execution_pattern, 'builder_reviewer_loop');
    assert.equal(result.record.participation_pct, 66.7);
    assert.equal(result.summary.run_count, 1);
    assert.equal(result.summary.patterns[0].execution_pattern, 'builder_reviewer_loop');
    assert.equal(result.summary.overlays[0].title, 'Frontend Developer');
    assert.equal(result.summary.overlays[0].avg_overlay_tokens, 90);
    assert.equal(loadExecutionFeedbackSummary(jobDir).patterns[0].run_count, 1);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('runtime metadata envelope preserves execution insights and feedback', () => {
  const normalized = normalizeRuntimeMetadataEnvelope({
    runtime_team_snapshot: {
      runtime_agents: [{ role_id: 'builder', template_id: 'builder' }],
      execution_insights: {
        execution_pattern: 'builder_reviewer_loop',
        execution: { planned_agent_count: 2, observed_agent_count: 1, participation_pct: 50 },
      },
      execution_feedback: {
        run_count: 3,
        patterns: [{ execution_pattern: 'builder_reviewer_loop', run_count: 3, avg_participation_pct: 75 }],
      },
    },
  });

  assert.equal(normalized.runtime_team_snapshot.execution_insights.execution_pattern, 'builder_reviewer_loop');
  assert.equal(normalized.runtime_team_snapshot.execution_feedback.run_count, 3);
  const patch = buildRuntimeMetadataPatch(normalized);
  assert.equal(patch.execution_insights.execution.observed_agent_count, 1);
  assert.equal(patch.execution_feedback.run_count, 3);
});
