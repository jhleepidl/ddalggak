import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentAssignmentNotice } from '../src/application/telegram_route_planning.js';

test('buildAgentAssignmentNotice summarizes queued agent tasks without LLM help', () => {
  const text = buildAgentAssignmentNotice([
    { type: 'agent_run', agent: 'researcher', goal: '관련 자료 조사 및 핵심 차이점 정리' },
    { type: 'spawn_agents', agents: [
      { type: 'agent_run', agent: 'coder', goal: '실행 가능한 데스크톱 빌드 산출물 생성' },
      { type: 'agent_run', agent: 'reviewer', goal: '결과 검증 및 리스크 점검' },
    ] },
  ], { routeReason: 'team_router' });

  assert.match(text, /🧩 작업 배정/);
  assert.match(text, /Researcher|researcher/i);
  assert.match(text, /Coder|coder/i);
  assert.match(text, /Reviewer|reviewer/i);
  assert.match(text, /실행 가능한 데스크톱 빌드 산출물 생성/);
  assert.match(text, /세부 상태는 \/status recent 또는 \/status full/);
});

test('buildAgentAssignmentNotice returns empty string when there is no agent work', () => {
  const text = buildAgentAssignmentNotice([
    { type: 'get_status', detail: 'summary' },
    { type: 'track_append', doc: 'plan', markdown: 'hello' },
  ]);
  assert.equal(text, '');
});
