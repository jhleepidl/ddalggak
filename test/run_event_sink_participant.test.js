import test from 'node:test';
import assert from 'node:assert/strict';

import { GocRunEventSink } from '../src/runtime_capabilities/run_event_sink.js';

test('GocRunEventSink forwards participant contribution events to execution graph and fallback sink', async () => {
  const calls = [];
  const fallback = [];
  const sink = new GocRunEventSink({
    runtimePolicy: { audit_flags: { timeline_enabled: true } },
    executionGraph: {
      isEnabled() { return true; },
      async recordParticipantContribution(input) { calls.push(input); return null; },
    },
    fallbackSink: {
      async recordAgentEvent(eventType, payload) { fallback.push({ eventType, payload }); return null; },
    },
  });

  await sink.recordAgentEvent('participant.contribution', { participant: { participant_id: 'phone.scout' } }, { jobId: 'job_1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].participant.participant_id, 'phone.scout');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].eventType, 'participant.contribution');
});

test('GocRunEventSink forwards folded participant digests to execution graph and fallback sink', async () => {
  const calls = [];
  const fallback = [];
  const sink = new GocRunEventSink({
    runtimePolicy: { audit_flags: { timeline_enabled: true } },
    executionGraph: {
      isEnabled() { return true; },
      async recordParticipantDigest(input) { calls.push(input); return null; },
    },
    fallbackSink: {
      async recordAgentEvent(eventType, payload) { fallback.push({ eventType, payload }); return null; },
    },
  });

  await sink.recordAgentEvent('participant.folded_digest', { item_count: 2, participant_labels: ['Phone Scout', 'Mini Critic'] }, { jobId: 'job_2' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].item_count, 2);
  assert.deepEqual(calls[0].participant_labels, ['Phone Scout', 'Mini Critic']);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].eventType, 'participant.folded_digest');
});


test('GocRunEventSink forwards channel verifier decisions to execution graph and fallback sink', async () => {
  const calls = [];
  const fallback = [];
  const sink = new GocRunEventSink({
    runtimePolicy: { audit_flags: { timeline_enabled: true } },
    executionGraph: {
      isEnabled() { return true; },
      async recordChannelVerifierDecision(input) { calls.push(input); return null; },
    },
    fallbackSink: {
      async recordAgentEvent(eventType, payload) { fallback.push({ eventType, payload }); return null; },
    },
  });

  await sink.recordAgentEvent('channel.verifier_decision', { overall_recommendation: 'promote_to_stable' }, { jobId: 'job_3' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].overall_recommendation, 'promote_to_stable');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].eventType, 'channel.verifier_decision');
});

test('GocRunEventSink forwards channel promotion applications to execution graph and fallback sink', async () => {
  const calls = [];
  const fallback = [];
  const sink = new GocRunEventSink({
    runtimePolicy: { audit_flags: { timeline_enabled: true } },
    executionGraph: {
      isEnabled() { return true; },
      async recordChannelPromotionApplied(input) { calls.push(input); return null; },
    },
    fallbackSink: {
      async recordAgentEvent(eventType, payload) { fallback.push({ eventType, payload }); return null; },
    },
  });

  await sink.recordAgentEvent('channel.promotion_applied', { overall_recommendation: 'promote_to_stable', motif: { promoted_motif_ids: ['motif_parallel_research_synthesis'] } }, { jobId: 'job_4' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].overall_recommendation, 'promote_to_stable');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].eventType, 'channel.promotion_applied');
});
