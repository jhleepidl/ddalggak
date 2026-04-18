import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildChannelPromotionRecord,
  loadChannelPromotionSummary,
  recordChannelPromotion,
} from '../src/application/channel_promotion_manager.js';
import { buildTeamMotifRegistry } from '../src/application/team_motif_registry.js';
import { bootstrapTelegramRuntimeSession } from '../src/application/telegram_runtime_session.js';

const motifFeedbackSummary = {
  stable_motifs: [],
  candidate_motifs: [
    {
      motif_id: 'motif.parallel_research_synthesis',
      pattern: 'parallel',
      role_ids: ['researcher', 'researcher', 'synthesizer'],
      task_types: ['analysis'],
      deliverable_types: ['brief'],
      default_weight: 1.1,
      recommendation: 'promising',
      run_count: 2,
      success_rate_pct: 80,
      avg_score: 0.7,
    },
  ],
};

test('buildChannelPromotionRecord promotes motifs and participant snapshot from candidate verifier', () => {
  const record = buildChannelPromotionRecord({
    verificationRecord: {
      run_id: 'run_1',
      overall_recommendation: 'promote_to_stable',
      motif: {
        channel: 'candidate',
        recommendation: 'promote_to_stable',
        next_channel: 'stable',
        selected_motif_ids: ['motif.parallel_research_synthesis'],
      },
      participant_policy: {
        channel: 'candidate',
        recommendation: 'promote_to_stable',
        next_channel: 'stable',
      },
    },
    motifFeedbackSummary,
    runtimeBehavior: {
      participant: {
        policy_channel: 'candidate',
        surface_threshold: 0.58,
        max_surface_per_turn: 2,
        allowed_participant_types: ['small_llm'],
        allowed_modalities: ['text'],
        surface_candidate_kinds: ['critique', 'summary'],
      },
    },
  });
  assert.equal(record.applied, true);
  assert.deepEqual(record.motif.promoted_motif_ids, ['motif_parallel_research_synthesis']);
  assert.equal(record.participant_policy.snapshot.policy_channel, 'stable');
  assert.equal(record.participant_policy.snapshot.surface_threshold, 0.58);
});

test('recordChannelPromotion persists summary and promoted motifs are reused by motif registry', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-promo-'));
  const jobDir = path.join(runsDir, 'job_1');
  fs.mkdirSync(jobDir, { recursive: true });

  recordChannelPromotion({
    runsDir,
    jobDir,
    verificationRecord: {
      run_id: 'run_2',
      overall_recommendation: 'promote_to_stable',
      motif: {
        channel: 'candidate',
        recommendation: 'promote_to_stable',
        next_channel: 'stable',
        selected_motif_ids: ['motif.parallel_research_synthesis'],
      },
      participant_policy: {
        channel: 'candidate',
        recommendation: 'promote_to_stable',
        next_channel: 'stable',
      },
    },
    motifFeedbackSummary,
    runtimeBehavior: {
      participant: {
        policy_channel: 'candidate',
        surface_threshold: 0.61,
        max_surface_per_turn: 2,
      },
    },
  });

  const promotionSummary = loadChannelPromotionSummary({ runsDir, jobDir });
  assert.ok(Array.isArray(promotionSummary?.stable_registry?.motif_ids));
  assert.equal(promotionSummary.stable_registry.motif_ids.includes('motif_parallel_research_synthesis'), true);

  const registry = buildTeamMotifRegistry({
    motifFeedbackSummary,
    promotionSummary,
    channel: 'stable',
  });
  const promoted = registry.find((row) => row.motif_id === 'motif_parallel_research_synthesis');
  assert.ok(promoted);
  assert.equal(promoted.historical_stats?.promoted_stable, true);
});



test('channel promotion summary learns task-family stable default execution mode', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-promo-family-'));
  const jobDir = path.join(runsDir, 'job_family');
  fs.mkdirSync(jobDir, { recursive: true });

  recordChannelPromotion({
    runsDir,
    jobDir,
    verificationRecord: {
      run_id: 'run_family_1',
      overall_recommendation: 'promote_to_stable',
      status: 'done',
      execution_mode: 'multi_motif',
      task_type: 'analysis',
      deliverable_type: 'brief',
      task_family_key: 'analysis::brief',
      quality_signals: { quality_health_score: 0.9 },
      motif: { channel: 'candidate', recommendation: 'promote_to_stable', next_channel: 'stable', selected_motif_ids: ['motif.parallel_research_synthesis'] },
      participant_policy: { channel: 'stable', recommendation: 'keep_stable', next_channel: 'stable' },
    },
    motifFeedbackSummary,
    runtimeBehavior: { participant: { policy_channel: 'stable' } },
  });

  recordChannelPromotion({
    runsDir,
    jobDir,
    verificationRecord: {
      run_id: 'run_family_2',
      overall_recommendation: 'keep_stable',
      status: 'done',
      execution_mode: 'multi_motif',
      task_type: 'analysis',
      deliverable_type: 'brief',
      task_family_key: 'analysis::brief',
      quality_signals: { quality_health_score: 0.8 },
      motif: { channel: 'stable', recommendation: 'keep_stable', next_channel: 'stable', selected_motif_ids: [] },
      participant_policy: { channel: 'stable', recommendation: 'keep_stable', next_channel: 'stable' },
    },
    motifFeedbackSummary,
    runtimeBehavior: { participant: { policy_channel: 'stable' } },
  });

  const summary = loadChannelPromotionSummary({ runsDir, jobDir });
  assert.equal(summary.task_family_mode_profiles['analysis::brief'].recommended_mode, 'multi_motif');
  assert.ok(summary.task_family_mode_profiles['analysis::brief'].confidence >= 0.6);
});

test('bootstrapTelegramRuntimeSession folds latest participant promotion snapshot into runtime policy defaults', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-promo-bootstrap-'));
  const jobDir = path.join(runsDir, 'job_boot');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'channel_promotions_summary.json'), JSON.stringify({
    latest_participant_policy_snapshot: {
      policy_channel: 'stable',
      surface_threshold: 0.67,
      max_surface_per_turn: 2,
      allowed_participant_types: ['small_llm'],
      allowed_modalities: ['text'],
      surface_candidate_kinds: ['critique'],
    },
    stable_registry: { motif_ids: ['motif.parallel_research_synthesis'], motifs: [] },
    rolled_back_registry: { motif_ids: [], motifs: [] },
  }), 'utf8');

  const runtime = { runtimePolicy: { participant_policy: { open_participation_enabled: true } } };
  const out = bootstrapTelegramRuntimeSession({
    runtime,
    sessionStore: new Map(),
    chatId: 'chat-1',
    telegramUserId: 'user-1',
    currentTurnId: 'turn-1',
    jobId: 'job_boot',
    runsDir,
    jobDir,
  });

  assert.equal(out.runtimePolicy.participant_policy.surface_threshold, 0.67);
  assert.equal(out.runtimeSessionState?.planner_state?.promoted_stable_motif_ids?.includes('motif.parallel_research_synthesis'), true);
});
