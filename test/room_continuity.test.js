import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoomContinuitySnapshot,
  createRoomBranch,
  formatRoomContinuityBrief,
  formatRoomRulesAndCorrections,
  formatRoomSourceBoundary,
} from '../src/application/room_continuity.js';

test('room continuity snapshot prioritizes durable room state over provider details', () => {
  const snapshot = buildRoomContinuitySnapshot({
    roomProfile: { current_goal: 'Complete the long-running research memo' },
    currentJobId: 'job-7',
    session: {
      runtime_rules: [{ text: 'Use the uploaded report as the source of truth.', enabled: true }],
      recent_room_turns: [
        { role: 'user', text: 'Continue from the evidence table.' },
        { role: 'assistant', text: 'The evidence table is ready.' },
      ],
    },
    companionState: {
      context_controls: { mode: 'project-only', excluded_sources: ['old_web_notes'] },
      active_companion: { memory_connections: [{ source: 'accepted_decisions' }, { source: 'uploaded_files' }] },
      recent_corrections: [{ correction_text: 'Do not treat unverified claims as facts.' }],
      merge_proposals: [{ status: 'pending', summary: 'Promote source rule' }],
    },
  });

  assert.equal(snapshot.goal, 'Complete the long-running research memo');
  assert.equal(snapshot.stage, 'active work');
  assert.equal(snapshot.next_action, 'Continue job job-7');
  assert.deepEqual(snapshot.source_policy.included_sources, ['accepted_decisions', 'uploaded_files']);
  assert.deepEqual(snapshot.source_policy.excluded_sources, ['old_web_notes']);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.corrections.length, 1);
  assert.equal(snapshot.pending.reviews, 1);
  assert.match(formatRoomContinuityBrief(snapshot), /목표: Complete the long-running research memo/);
  assert.match(formatRoomSourceBoundary(snapshot), /old_web_notes/);
  assert.match(formatRoomRulesAndCorrections(snapshot), /unverified claims/);
});

test('room branch is a non-destructive proposal stored beside the current room state', () => {
  const rows = new Map();
  const store = {
    get: (id) => rows.get(id) || {},
    upsert: (id, fn) => {
      const next = fn(rows.get(id) || {});
      rows.set(id, next);
      return next;
    },
  };
  const branch = createRoomBranch({
    sessionStore: store,
    chatId: 'chat-1',
    direction: 'Keep the current architecture, but explore a local-first alternative.',
    parentJobId: 'job-parent',
  });
  assert.equal(branch.status, 'proposed');
  assert.equal(branch.parent_job_id, 'job-parent');
  assert.equal(rows.get('chat-1').room_branches.length, 1);
  assert.match(rows.get('chat-1').room_branches[0].direction, /local-first/);
});
