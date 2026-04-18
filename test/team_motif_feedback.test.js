import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';
import { buildTeamMotifRegistry } from '../src/application/team_motif_registry.js';
import { buildTeamMotifFeedbackRecord, loadTeamMotifFeedbackSummary, recordTeamMotifFeedback } from '../src/application/team_motif_feedback.js';
import { loadAgents } from '../src/agents.js';

const runtimeTeamSnapshot = {
  task_interpretation: {
    task_type: 'analysis',
    deliverable_type: 'brief',
  },
  runtime_agents: [
    { instance_id: 'inst_op', slot_id: 'slot_op', role_id: 'operator' },
    { instance_id: 'inst_r1', slot_id: 'slot_r1', role_id: 'researcher' },
    { instance_id: 'inst_r2', slot_id: 'slot_r2', role_id: 'researcher' },
    { instance_id: 'inst_syn', slot_id: 'slot_syn', role_id: 'synthesizer' },
  ],
  execution_graph: {
    pattern: 'parallel',
    order: ['slot_op', 'slot_r1', 'slot_r2', 'slot_syn'],
    parallel_groups: [{ slot_ids: ['slot_r1', 'slot_r2'] }],
  },
};

const plannerMetadata = {
  planner_type: 'graph_librarian',
  selected_motif_ids: ['motif_operator_parallel_research'],
};

test('team motif feedback record captures motif ids and execution outcome', () => {
  const record = buildTeamMotifFeedbackRecord({
    runId: 'run_1',
    goal: '병렬 조사 후 브리핑',
    status: 'done',
    plannerMetadata,
    runtimeTeamSnapshot,
    executionInsights: {
      execution: {
        participation_pct: 100,
        planned_agent_count: 4,
        observed_agent_count: 4,
      },
    },
  });

  assert.equal(record.run_id, 'run_1');
  assert.deepEqual(record.motif_ids, ['motif_operator_parallel_research']);
  assert.equal(record.pattern, 'parallel');
  assert.equal(record.status, 'done');
  assert.equal(record.score >= 0.9, true);
});

test('recordTeamMotifFeedback persists summary and feeds registry construction', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-feedback-'));
  const jobDir = path.join(runsDir, 'job_1');
  fs.mkdirSync(jobDir, { recursive: true });

  recordTeamMotifFeedback({
    runsDir,
    jobDir,
    runId: 'run_ok',
    goal: 'Compare evidence in parallel and summarize findings',
    status: 'done',
    plannerMetadata,
    runtimeTeamSnapshot,
    executionInsights: {
      execution: {
        participation_pct: 95,
        planned_agent_count: 4,
        observed_agent_count: 4,
      },
    },
  });
  recordTeamMotifFeedback({
    runsDir,
    jobDir,
    runId: 'run_ok_2',
    goal: 'Second parallel briefing',
    status: 'done',
    plannerMetadata,
    runtimeTeamSnapshot,
    executionInsights: {
      execution: {
        participation_pct: 90,
        planned_agent_count: 4,
        observed_agent_count: 4,
      },
    },
  });

  const summary = loadTeamMotifFeedbackSummary({ runsDir, jobDir });
  assert.equal(summary.run_count, 2);
  assert.ok(summary.recommended_motifs.some((row) => row.motif_id === 'motif_operator_parallel_research'));
  assert.ok(summary.channels?.stable?.motifs?.some((row) => row.motif_id === 'motif_operator_parallel_research'));
  assert.ok(summary.channels?.candidate?.motifs?.some((row) => row.motif_id === 'motif_operator_parallel_research'));

  const registry = buildTeamMotifRegistry({ motifFeedbackSummary: summary, channel: 'stable' });
  const feedbackMotif = registry.find((row) => row.motif_id === 'motif_operator_parallel_research');
  assert.ok(feedbackMotif);
  assert.equal(feedbackMotif.source, 'feedback_summary');
  assert.equal(Number(feedbackMotif.historical_stats?.run_count || 0) >= 2, true);
});

test('buildRuntimeOrchestration loads motif feedback summary from runsDir', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-orchestrator-'));
  const summaryPath = path.join(runsDir, 'team_motif_feedback_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    run_count: 4,
    recommended_motifs: [
      {
        motif_id: 'motif_operator_parallel_research',
        pattern: 'parallel',
        role_ids: ['operator', 'researcher', 'researcher', 'synthesizer'],
        task_types: ['analysis'],
        deliverable_types: ['brief'],
        run_count: 4,
        success_rate_pct: 100,
        avg_participation_pct: 92,
        avg_score: 0.95,
        recommendation: 'recommended',
        default_weight: 1.35,
      },
    ],
  }, null, 2), 'utf8');

  const orchestration = buildRuntimeOrchestration({
    mode: 'run',
    goal: '두 소스를 병렬 조사하고 브리핑으로 정리해줘',
    registry: loadAgents(),
    maxAgents: 5,
    runtimeTeamSnapshot,
    runsDir,
    runtimePolicy: { motif_policy: { channel: 'candidate' } },
  });

  assert.equal(orchestration.planner_metadata.motif_feedback_run_count, 4);
  assert.equal(orchestration.planner_metadata.motif_channel, 'candidate');
  assert.ok(orchestration.planner_metadata.selected_motif_ids.length > 0);
  assert.ok(orchestration.team_plan.slots.some((slot) => slot.role_id === 'operator'));
});
