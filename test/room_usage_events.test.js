import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendRoomUsageEvent,
  buildRoomUsageEvent,
  summarizeRoomUsage,
} from '../src/application/room_usage_events.js';

test('room usage events are sanitized JSONL records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-events-'));
  const event = buildRoomUsageEvent({
    chatId: 'chat/1',
    userId: 'user',
    eventType: 'room_applied',
    command: '/room apply',
    goal: 'research room',
    profile: {
      kind: 'agent_room_profile_v1',
      name: 'Research Room',
      domain_label: 'research_paper',
      default_depth: 'team',
      default_agents: ['idea_expander'],
      memory_schema: { object_types: ['claims'] },
    },
  });
  const file = appendRoomUsageEvent(event, { rootDir: root });
  assert.ok(fs.existsSync(file));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].room.domain_label, 'research_paper');
  const summary = summarizeRoomUsage(rows);
  assert.equal(summary.task_count, 1);
  assert.equal(summary.distinct_domains, 1);
});

test('room usage summary exposes continuity signals without claiming semantic success', () => {
  const summary = summarizeRoomUsage([
    { event_type: 'room_continuation_requested', room: { domain_label: 'research' } },
    { event_type: 'room_continuation_completed', room: { domain_label: 'research' } },
    { event_type: 'room_continuity_brief_view', room: { domain_label: 'research' } },
    { event_type: 'room_source_boundary_view', room: { domain_label: 'research' } },
    { event_type: 'room_rules_view', room: { domain_label: 'research' } },
    { event_type: 'room_branch_proposed', room: { domain_label: 'research' } },
  ]);
  assert.equal(summary.continuity.continuation_attempt_count, 1);
  assert.equal(summary.continuity.continuation_completion_count, 1);
  assert.equal(summary.continuity.continuation_completion_rate, 1);
  assert.equal(summary.continuity.branch_proposal_count, 1);
});
