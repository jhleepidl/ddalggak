import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoomGovernanceMetrics,
  collectRoomGovernanceItems,
  formatRoomGovernanceDigestForTelegram,
  shouldSendRoomGovernanceDigest,
} from '../src/application/room_governance_metrics.js';

const NOW = '2026-07-10T12:00:00.000Z';

function hoursAgo(hours) {
  return new Date(Date.parse(NOW) - hours * 3600000).toISOString();
}

function sampleInputs() {
  return {
    now: NOW,
    memoryView: {
      candidates: [
        { candidate_id: 'cand_pending_old', status: 'pending', created_at: hoursAgo(100), memory_summary: 'user prefers Korean summaries', source_quote: 'RAW QUOTE MUST NOT LEAK' },
        { candidate_id: 'cand_rejected', status: 'rejected', created_at: hoursAgo(50), updated_at: hoursAgo(45), memory_summary: 'noisy observation' },
      ],
      active_items: [
        { memory_id: 'mem_1', status: 'active', source_candidate_id: 'cand_approved', created_at: hoursAgo(30), updated_at: hoursAgo(29), summary: 'approved memory', review: { approved_at: hoursAgo(29) } },
      ],
    },
    companionEvents: [
      { event_type: 'merge_proposal_created', event_id: 'mp_1', ts: hoursAgo(48), summary: 'promote correction about citations' },
      { event_type: 'merge_proposal_decision', proposal_event_id: 'mp_1', decision: 'approve', ts: hoursAgo(24) },
      { event_type: 'merge_proposal_created', event_id: 'mp_2', ts: hoursAgo(10), summary: 'another correction' },
      { event_type: 'companion_memory_exchange_proposed', event_id: 'ex_1', ts: hoursAgo(6), memory_summary: 'share preference with researcher companion' },
    ],
    usageEvents: [
      { event_type: 'room_agent_specialization_proposed', ts: hoursAgo(80) },
      { event_type: 'room_agent_specialization_rejected', ts: hoursAgo(79) },
      { event_type: 'room_topology_replay_evaluated', ts: hoursAgo(5) },
      { event_type: 'room_preference_scorer_view', ts: hoursAgo(4) },
    ],
    pendingAgentSpecialization: null,
  };
}

test('collects governance items across memory, companion, and roster sources', () => {
  const items = collectRoomGovernanceItems(sampleInputs());
  const bySource = {};
  for (const item of items) bySource[item.source] = (bySource[item.source] || 0) + 1;
  assert.equal(bySource.memory_candidate, 3);
  assert.equal(bySource.correction_merge, 2);
  assert.equal(bySource.memory_exchange, 1);
  assert.equal(bySource.agent_specialization, 1);
});

test('computes review rate, decision latency, and backlog age', () => {
  const metrics = buildRoomGovernanceMetrics(sampleInputs());
  assert.equal(metrics.totals.proposed, 7);
  assert.equal(metrics.totals.approved, 2);
  assert.equal(metrics.totals.rejected, 2);
  assert.equal(metrics.totals.pending, 3);
  assert.equal(metrics.totals.review_rate, Math.round((4 / 7) * 100) / 100);
  const merge = metrics.by_source.correction_merge;
  assert.equal(merge.median_hours_to_decision, 24);
  assert.equal(metrics.totals.oldest_pending_age_hours, 100);
  assert.equal(metrics.by_source.memory_candidate.oldest_pending_item_id, 'cand_pending_old');
  assert.equal(metrics.shadow_recommendation_views, 2);
});

test('flags backlog when the oldest pending proposal exceeds 72h', () => {
  const metrics = buildRoomGovernanceMetrics(sampleInputs());
  assert.equal(metrics.status, 'review_backlog');
  assert.ok(metrics.reasons.some((reason) => /72h/.test(reason)));
});

test('flags stalled review when pending exists but nothing was decided in 7d', () => {
  const inputs = sampleInputs();
  inputs.companionEvents = [
    { event_type: 'merge_proposal_created', event_id: 'mp_old', ts: hoursAgo(400), summary: 'stale proposal' },
  ];
  inputs.memoryView = { candidates: [], active_items: [] };
  inputs.usageEvents = [];
  const metrics = buildRoomGovernanceMetrics(inputs);
  assert.equal(metrics.status, 'review_stalled');
  assert.equal(metrics.throughput_7d.backlog_clear_days_at_current_pace, null);
});

test('reports no_governance_items for an empty room', () => {
  const metrics = buildRoomGovernanceMetrics({ now: NOW });
  assert.equal(metrics.status, 'no_governance_items');
  const text = formatRoomGovernanceDigestForTelegram(metrics);
  assert.match(text, /리뷰할 proposal이 없습니다/);
});

test('digest text surfaces pending items with review commands and never leaks raw quotes', () => {
  const metrics = buildRoomGovernanceMetrics(sampleInputs());
  const text = formatRoomGovernanceDigestForTelegram(metrics);
  assert.match(text, /Room governance digest/);
  assert.match(text, /pending=3/);
  assert.match(text, /\/memory proposals/);
  assert.match(text, /\/correct proposals/);
  assert.match(text, /user prefers Korean summaries/);
  assert.doesNotMatch(text, /RAW QUOTE MUST NOT LEAK/);
});

test('digest send gate honors enable flag, pending backlog, and cooldown', () => {
  const metrics = buildRoomGovernanceMetrics(sampleInputs());
  const env = {};
  assert.equal(shouldSendRoomGovernanceDigest({ session: {}, metrics, now: NOW, env }).send, true);
  assert.equal(shouldSendRoomGovernanceDigest({ session: {}, metrics, now: NOW, env: { DDALGGAK_ROOM_GOVERNANCE_DIGEST_ENABLED: 'false' } }).send, false);
  const emptyMetrics = buildRoomGovernanceMetrics({ now: NOW });
  assert.equal(shouldSendRoomGovernanceDigest({ session: {}, metrics: emptyMetrics, now: NOW, env }).send, false);
  const recent = { last_governance_digest_at: hoursAgo(2) };
  assert.equal(shouldSendRoomGovernanceDigest({ session: recent, metrics, now: NOW, env }).send, false);
  const stale = { last_governance_digest_at: hoursAgo(30) };
  assert.equal(shouldSendRoomGovernanceDigest({ session: stale, metrics, now: NOW, env }).send, true);
});
