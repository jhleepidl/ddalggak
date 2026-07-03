import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRoomCompanionEvent,
  buildCorrectionMergeProposalEvent,
  buildRoomCompanionMaterializationCandidateEvent,
  buildRoomCompanionMergeProposalDecisionEvent,
  classifyRoomCorrectionIntent,
  deriveRoomCompanionState,
  formatRoomCompanionMaterializationCandidatesForTelegram,
  formatRoomCompanionProjectionBlock,
  getRoomCompanionProfile,
  readRoomCompanionEvents,
} from '../src/application/room_companions.js';
import { createRoomContextSnapshot, buildBudgetedRoomContextProjection } from '../src/application/room_context_projection.js';

function makeSessionStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(String(key)) || {},
    upsert: (key, updater) => {
      const id = String(key);
      const prev = map.get(id) || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...(updater || {}) };
      map.set(id, next);
      return next;
    },
  };
}

test('companion events derive active companion, context controls, and corrections', () => {
  const sessionStore = makeSessionStore();
  appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-1',
    event: { event_type: 'companion_selected', companion_id: 'product' },
  });
  appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-1',
    event: { event_type: 'context_override', context_mode: 'project-only' },
  });
  appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-1',
    event: { event_type: 'context_override', context_mode: 'exclude', excluded_sources: ['gpt-5.4-nano-assumption'] },
  });
  appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-1',
    event: { event_type: 'user_correction', correction_text: 'docs-only means do not touch runtime code', scope: 'room', promotion_status: 'candidate' },
  });

  const state = deriveRoomCompanionState({ session: sessionStore.get('chat-1') });
  assert.equal(state.active_companion.id, 'product');
  assert.equal(state.context_controls.mode, 'project-only');
  assert.deepEqual(state.context_controls.excluded_sources, ['gpt-5.4-nano-assumption']);
  assert.equal(state.recent_corrections[0].promotion_status, 'candidate');

  const block = formatRoomCompanionProjectionBlock({ state });
  assert.match(block, /ACTIVE AI COMPANION/);
  assert.match(block, /Product Companion/);
  assert.match(block, /gpt-5\.4-nano-assumption/);
  assert.match(block, /docs-only means do not touch runtime code/);
});

test('companion events persist to job local memory and shared mirror', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-companion-events-'));
  try {
    appendRoomCompanionEvent({
      jobDir,
      chatId: 'chat-1',
      event: { event_type: 'companion_selected', companion_id: 'implementation' },
    });
    const events = readRoomCompanionEvents({ jobDir });
    assert.equal(events.length, 1);
    assert.equal(events[0].companion_id, 'implementation');
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobDir, 'shared', 'room_companion_events.jsonl'), 'utf8').trim()).companion_id, 'implementation');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('room context projection includes active companion control block', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-companion-proj-'));
  try {
    appendRoomCompanionEvent({
      jobDir,
      chatId: 'chat-1',
      event: { event_type: 'companion_selected', companion_id: 'research' },
    });
    appendRoomCompanionEvent({
      jobDir,
      chatId: 'chat-1',
      event: { event_type: 'context_override', context_mode: 'clean-slate' },
    });
    const snapshot = createRoomContextSnapshot({ jobDir, latestUserText: '이 아이디어를 기존 맥락 빼고 봐줘.', command: '/chat' });
    assert.equal(snapshot.companion_state.active_companion.id, 'research');
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'agent', maxChars: 2200 });
    assert.match(projection.text, /ACTIVE AI COMPANION/);
    assert.match(projection.text, /Research Companion/);
    assert.match(projection.text, /clean_slate: true/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('unknown companion ids fall back to research profile', () => {
  assert.equal(getRoomCompanionProfile('not-a-real-companion').id, 'research');
});


test('durable corrections create reviewable merge proposals without promotion', () => {
  const sessionStore = makeSessionStore();
  const correction = appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-3',
    event: { event_type: 'user_correction', correction_text: '앞으로 docs-only면 runtime code는 건드리지 마', scope: 'project_candidate', promotion_status: 'proposal_recommended' },
  });
  const stateBefore = deriveRoomCompanionState({ session: sessionStore.get('chat-3') });
  const proposal = buildCorrectionMergeProposalEvent({ correction: { ...correction, text: correction.correction_text }, state: stateBefore });
  assert.ok(proposal);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.source_event_id, correction.event_id);
  assert.equal(proposal.payload.silent_promotion, false);

  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-3', event: proposal });
  const state = deriveRoomCompanionState({ session: sessionStore.get('chat-3') });
  assert.equal(state.merge_proposals.length, 1);
  assert.match(state.merge_proposals[0].summary, /docs-only/);

  const block = formatRoomCompanionProjectionBlock({ state });
  assert.match(block, /REVIEWABLE MEMORY MERGE PROPOSALS/);
  assert.match(block, /pending proposals/);
});

test('temporary corrections stay room-local by default', () => {
  const intent = classifyRoomCorrectionIntent('이번엔 기존 맥락 빼고 봐줘');
  assert.equal(intent.correction_scope, 'room');
  assert.equal(intent.should_create_merge_proposal, false);
  assert.equal(buildCorrectionMergeProposalEvent({ correctionText: intent.text }), null);
});

test('pending companion merge proposals can be explicitly accepted or rejected', () => {
  const sessionStore = makeSessionStore();
  const correction = appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-5',
    event: { event_type: 'user_correction', correction_text: '앞으로 docs-only면 runtime code는 건드리지 마', scope: 'project_candidate', promotion_status: 'proposal_recommended' },
  });
  const proposal = buildCorrectionMergeProposalEvent({
    correction: { ...correction, text: correction.correction_text },
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-5') }),
  });
  const proposalEvent = appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-5', event: proposal });

  const acceptEvent = buildRoomCompanionMergeProposalDecisionEvent({
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-5') }),
    target: 'latest',
    decision: 'approve',
    userId: 'u-1',
  });
  assert.ok(acceptEvent);
  assert.equal(acceptEvent.status, 'accepted');
  assert.equal(acceptEvent.proposal_event_id, proposalEvent.event_id);
  assert.equal(acceptEvent.payload.silent_promotion, false);
  assert.equal(acceptEvent.payload.materialized_project_write, false);

  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-5', userId: 'u-1', event: acceptEvent });
  const acceptedState = deriveRoomCompanionState({ session: sessionStore.get('chat-5') });
  assert.equal(acceptedState.merge_proposals[0].status, 'accepted');
  assert.equal(acceptedState.merge_proposals[0].decided_by, 'u-1');
  assert.equal(buildRoomCompanionMergeProposalDecisionEvent({ state: acceptedState, target: 'latest', decision: 'reject' }), null);

  const acceptedBlock = formatRoomCompanionProjectionBlock({ state: acceptedState });
  assert.match(acceptedBlock, /REVIEWED MEMORY MERGE DECISIONS/);
  assert.match(acceptedBlock, /status=accepted/);
  assert.doesNotMatch(acceptedBlock, /REVIEWABLE MEMORY MERGE PROPOSALS/);

  const reproposal = buildCorrectionMergeProposalEvent({
    correction: acceptedState.recent_corrections[0],
    state: acceptedState,
    force: true,
  });
  assert.equal(reproposal, null);
});


test('accepted companion merge proposals create branchable materialization candidates without canonical writes', () => {
  const sessionStore = makeSessionStore();
  const correction = appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-materialize',
    event: { event_type: 'user_correction', correction_text: '앞으로 docs-only면 runtime code는 건드리지 마', scope: 'project_candidate', promotion_status: 'proposal_recommended' },
  });
  const proposal = buildCorrectionMergeProposalEvent({
    correction: { ...correction, text: correction.correction_text },
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-materialize') }),
  });
  const proposalEvent = appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-materialize', event: proposal });
  const acceptEvent = buildRoomCompanionMergeProposalDecisionEvent({
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-materialize') }),
    target: 'latest',
    decision: 'approve',
    userId: 'u-1',
  });
  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-materialize', userId: 'u-1', event: acceptEvent });

  const acceptedState = deriveRoomCompanionState({ session: sessionStore.get('chat-materialize') });
  const candidateEvent = buildRoomCompanionMaterializationCandidateEvent({
    state: acceptedState,
    proposalEventId: proposalEvent.event_id,
    userId: 'u-1',
  });
  assert.ok(candidateEvent);
  assert.equal(candidateEvent.event_type, 'merge_materialization_candidate_created');
  assert.equal(candidateEvent.payload.materialization_boundary, 'branch_overlay_shadow_only');
  assert.equal(candidateEvent.payload.canonical_write_enabled, false);
  assert.equal(candidateEvent.payload.materialized_project_write, false);
  assert.equal(candidateEvent.payload.branch_change.kind, 'branchable_room_change_v1');
  assert.equal(candidateEvent.payload.branch_change.canonical_write_enabled, false);
  assert.equal(candidateEvent.payload.merge_request.recommended_policy, 'B3_governed_partial_merge');
  assert.equal(candidateEvent.payload.loop_projection_hint.direct_loop_state_mutation, false);

  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-materialize', userId: 'u-1', event: candidateEvent });
  const materializedState = deriveRoomCompanionState({ session: sessionStore.get('chat-materialize') });
  assert.equal(materializedState.materialization_candidates.length, 1);
  assert.equal(materializedState.materialization_candidates[0].proposal_event_id, proposalEvent.event_id);
  assert.equal(materializedState.materialization_candidates[0].payload.raw_memory_retained, true);
  assert.equal(buildRoomCompanionMaterializationCandidateEvent({ state: materializedState, proposalEventId: proposalEvent.event_id }), null);

  const block = formatRoomCompanionProjectionBlock({ state: materializedState });
  assert.match(block, /MEMORY MATERIALIZATION CANDIDATES/);
  assert.match(block, /canonical_write_enabled=false/);
  const formatted = formatRoomCompanionMaterializationCandidatesForTelegram(materializedState);
  assert.match(formatted, /branch_overlay_shadow_only/);
  assert.match(formatted, /canonical_write_enabled: false/);
});

test('rejected companion merge proposals do not block a new reviewed proposal for the same correction', () => {
  const sessionStore = makeSessionStore();
  const correction = appendRoomCompanionEvent({
    chatSessionStore: sessionStore,
    chatId: 'chat-6',
    event: { event_type: 'user_correction', correction_text: '앞으로 docs-only면 runtime code는 건드리지 마', scope: 'project_candidate', promotion_status: 'proposal_recommended' },
  });
  const proposal = buildCorrectionMergeProposalEvent({
    correction: { ...correction, text: correction.correction_text },
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-6') }),
  });
  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-6', event: proposal });
  const rejectEvent = buildRoomCompanionMergeProposalDecisionEvent({
    state: deriveRoomCompanionState({ session: sessionStore.get('chat-6') }),
    decision: 'reject',
    reason: 'Too broad for project memory.',
  });
  appendRoomCompanionEvent({ chatSessionStore: sessionStore, chatId: 'chat-6', event: rejectEvent });
  const rejectedState = deriveRoomCompanionState({ session: sessionStore.get('chat-6') });
  assert.equal(rejectedState.merge_proposals[0].status, 'rejected');
  assert.match(rejectedState.merge_proposals[0].decision_reason, /Too broad/);

  const nextProposal = buildCorrectionMergeProposalEvent({
    correction: rejectedState.recent_corrections[0],
    state: rejectedState,
    force: true,
  });
  assert.ok(nextProposal);
  assert.equal(nextProposal.status, 'pending');
});

