import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomSelectionRouteEvent, buildRoomSelectionDecision, buildTeamSelectionDecision } from '../src/application/room_selection_routing.js';

test('room selection and team selection are separate decisions', () => {
  const room = buildRoomSelectionDecision({
    text: '아까 그 논문 아이디어에 이어서 실험 설계해줘',
    command: '/c',
    chatId: 'chat-1',
    roomProfile: { room_id: 'inbox', name: 'Inbox' },
    candidateRooms: [{ room_id: 'paper4', name: 'Room Memory Trials', confidence: 0.72, reason: 'paper idea continuation' }],
  });
  assert.equal(room.room_action, 'shadow_candidate_room');
  assert.equal(room.execution_room.room_id, 'inbox');

  const team = buildTeamSelectionDecision({
    text: '아까 그 논문 아이디어에 이어서 실험 설계해줘',
    command: '/c',
    conciergeDecision: { route: 'standard_workbench' },
    teamState: {},
    roomSelection: room,
  });
  assert.equal(team.team_action, 'build_room_first_ephemeral_team');
  assert.equal(team.room_action, 'shadow_candidate_room');
});

test('room/team selection events are logged for offline analysis', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-selection-'));
  try {
    const roomSelection = buildRoomSelectionDecision({ text: '오늘 저녁 뭐 먹을까?', roomProfile: { room_id: 'menu', name: 'Menu Room' } });
    const teamSelection = buildTeamSelectionDecision({ text: '오늘 저녁 뭐 먹을까?', conciergeDecision: { route: 'concierge_direct_answer' }, roomSelection });
    const row = appendRoomSelectionRouteEvent({ jobDir, chatId: 'chat-1', userId: 'user-1', roomSelection, teamSelection, conciergeDecision: { route: 'concierge_direct_answer', depth: 'direct_answer' } });
    assert.equal(row.event, 'room_and_team_selection');
    const logPath = path.join(jobDir, 'local_memory', 'room_selection_events.jsonl');
    assert.equal(fs.existsSync(logPath), true);
    const logged = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(logged.room_selection.execution_room.room_id, 'menu');
    assert.equal(logged.team_selection.execution_mode, 'single_model_direct_answer');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
