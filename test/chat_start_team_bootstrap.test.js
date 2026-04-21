import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatStartTeamConfiguration, isChatStartTeamConfiguration } from '../src/application/team_configuration.js';


test('buildChatStartTeamConfiguration starts code tasks as a single builder-owned team', () => {
  const team = buildChatStartTeamConfiguration({ taskText: '이 저장소에서 failing test를 고치고 패치를 만들어줘.' });
  assert.equal(Array.isArray(team.agents), true);
  assert.equal(team.agents.length, 1);
  assert.equal(team.agents[0].role, 'builder');
  assert.equal(team.interaction_spec.final_answer_owner, team.agents[0].name);
  assert.equal(isChatStartTeamConfiguration(team), true);
});


test('buildChatStartTeamConfiguration starts research tasks as a single-agent chat starter', () => {
  const team = buildChatStartTeamConfiguration({ taskText: '이 프로젝트 구조를 분석해서 핵심 모듈을 요약해줘.' });
  assert.equal(team.agents.length, 1);
  assert.equal(isChatStartTeamConfiguration(team), true);
  assert.match(String(team.planner_metadata?.planning_source || ''), /chat_single_bootstrap/);
});
