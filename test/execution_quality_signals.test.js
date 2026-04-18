import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExecutionQualitySignals } from '../src/application/execution_quality_signals.js';

test('buildExecutionQualitySignals summarizes follow-up, contradiction, and quality health', () => {
  const quality = buildExecutionQualitySignals({
    status: 'await_user',
    routePlan: { await_user: true, quality_signals: ['needs_more_revision'] },
    execution: { pendingApproval: { reason: 'approve tool' }, results: [{ label: 'tool retry#1', note: 'verification recovered' }] },
    executionInsights: { execution: { participation_pct: 72, missing_agent_count: 1 } },
    runtime: { participantContributionHistory: [{ contribution: { kind: 'critique' } }, { contribution: { kind: 'conflict_flag' } }] },
    runtimeSessionState: { observability_state: { participant_surface: { last_folded_count: 1 } } },
    capabilityGapCount: 1,
  });

  assert.equal(quality.user_followup_required, true);
  assert.equal(quality.pending_approval, true);
  assert.ok(quality.followup_burden >= 1);
  assert.ok(quality.contradiction_pressure >= 2);
  assert.ok(quality.quality_gap >= 2);
  assert.ok(quality.quality_health_score < 0.8);
  assert.ok(Array.isArray(quality.quality_tags));
  assert.ok(quality.quality_tags.includes('needs_more_revision'));
});
