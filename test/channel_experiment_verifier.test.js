import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildChannelExperimentVerificationRecord,
  loadChannelExperimentVerificationSummary,
  recordChannelExperimentVerification,
} from '../src/application/channel_experiment_verifier.js';

test('buildChannelExperimentVerificationRecord recommends promotion for strong candidate channels', () => {
  const record = buildChannelExperimentVerificationRecord({
    runId: 'run_candidate_good',
    goal: 'Summarize and verify findings',
    status: 'done',
    runtimeBehavior: {
      motif: { channel: 'candidate' },
      participant: { policy_channel: 'candidate' },
    },
    plannerMetadata: {
      selected_motif_ids: ['motif_operator_parallel_research'],
      motif_feedback_run_count: 5,
      registry_motif_count: 7,
    },
    executionInsights: {
      execution_pattern: 'parallel',
      execution: {
        participation_pct: 90,
      },
    },
    runtime: {
      participantContributionDecisionLog: [
        { action: 'fold_into_reply', kind: 'critique' },
        { action: 'store_internal', kind: 'summary' },
      ],
    },
    runtimeSessionState: {
      observability_state: {
        participant_surface: {
          last_folded_count: 2,
        },
      },
    },
  });

  assert.equal(record.motif.channel, 'candidate');
  assert.equal(record.participant_policy.channel, 'candidate');
  assert.equal(record.motif.recommendation, 'promote_to_stable');
  assert.equal(record.participant_policy.recommendation, 'promote_to_stable');
  assert.equal(record.overall_recommendation, 'promote_to_stable');
});

test('recordChannelExperimentVerification persists summary with latest recommendation', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-verifier-'));
  const jobDir = path.join(runsDir, 'job_1');
  fs.mkdirSync(jobDir, { recursive: true });

  recordChannelExperimentVerification({
    runsDir,
    jobDir,
    runId: 'run_candidate_hold',
    status: 'await_user',
    runtimeBehavior: {
      motif: { channel: 'candidate' },
      participant: { policy_channel: 'candidate' },
    },
    plannerMetadata: { selected_motif_ids: ['motif_operator_parallel_research'] },
    executionInsights: { execution: { participation_pct: 65 } },
    runtime: { participantContributionDecisionLog: [{ action: 'fold_into_reply', kind: 'summary' }] },
    runtimeSessionState: { observability_state: { participant_surface: { last_folded_count: 1 } } },
  });

  const summary = loadChannelExperimentVerificationSummary({ runsDir, jobDir });
  assert.equal(summary.run_count, 1);
  assert.equal(summary.latest.run_id, 'run_candidate_hold');
  assert.equal(summary.motif.candidate.run_count, 1);
  assert.equal(summary.participant_policy.candidate.run_count, 1);
});
