import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoomTurnRoute } from '../src/application/room_turn_router.js';
import { buildRoomPackage } from '../src/application/room_package.js';
import { buildRoomFirstRuntimeSelection } from '../src/application/ai_room_runtime_selection.js';

test('room router keeps simple specialized-room turns in ask depth', () => {
  const pkg = buildRoomPackage({ goal: '식사 추천과 기록을 자주 하는 방', chatId: 'meal-room' });
  const route = buildRoomTurnRoute({
    taskText: '오늘 저녁 뭐 먹지?',
    explicitMode: 'ask',
    roomPackage: pkg,
    chatId: 'meal-room',
  });

  assert.equal(route.depth, 'ask');
  assert.equal(route.execution_shape, 'single_agent');
  assert.equal(route.room_router.role, 'turn_router');
  assert.equal(route.tool_policy.allow_external_tools, false);
});

test('room router escalates richer requests to team task', () => {
  const pkg = buildRoomPackage({ goal: '식사 추천과 기록을 자주 하는 방', chatId: 'meal-room' });
  const route = buildRoomTurnRoute({
    taskText: '최근 식사 기록과 근처 식당을 같이 보고 오늘 메뉴 추천해줘',
    roomPackage: pkg,
    chatId: 'meal-room',
  });

  assert.equal(route.depth, 'team_task');
  assert.equal(route.execution_shape, 'bounded_team');
  assert.equal(route.tool_policy.allow_external_tools, true);
  assert.equal(route.memory_policy.read, 'structured_projection');
});

test('room-first runtime selection exposes room router metadata', () => {
  const pkg = buildRoomPackage({ goal: '팬픽 설정과 캐릭터 검토를 자주 하는 방', chatId: 'creative-room' });
  const selection = buildRoomFirstRuntimeSelection({
    taskText: '캐릭터별 정보 간단히 정리해줘',
    workMode: 'ask',
    roomPackage: pkg,
    chatId: 'creative-room',
  });

  assert.equal(selection.room_turn_route.depth, 'ask');
  assert.equal(selection.room_router.role, 'turn_router');
  assert.match(selection.room_turn_route.summary_lines.join(' '), /Room Router|Room Concierge/i);
});
