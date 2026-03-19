import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTeamConfigurationToRuntime,
  createFreeformTeamConfiguration,
  formatTeamProposalMessage,
} from '../src/application/team_configuration.js';

test('freeform create respects opposing-view and debate style requirements', () => {
  const team = createFreeformTeamConfiguration({
    description: '한국 주식시장 투자에 도움을 받고싶은데, 구체적으로 팀을 구성해줘. 한 Agent는 특정 Agent의 반대 의견을 내서 서로 토의하듯이 Agent team을 구성하고싶어.',
  });

  const researchers = team.agents.filter((agent) => agent.role === 'researcher');
  assert.ok(researchers.length >= 2);
  assert.ok(team.agents.some((agent) => /반대|counter|bear|리스크/i.test(`${agent.name} ${agent.purpose}`)));
  assert.ok(team.agents.some((agent) => agent.role === 'reviewer'));
  assert.ok(team.agents.some((agent) => agent.role === 'synthesizer'));
  assert.equal(team.interaction_spec.execution_pattern, 'multi_research_adjudication');
  assert.ok(team.interaction_spec.handoffs.some((handoff) => handoff.payload === 'counterargument_plus_risks'));
});

test('team generator can draft inline skill briefs for nuanced freeform teams', () => {
  const team = createFreeformTeamConfiguration({
    description: '찬반 토론 형태로 투자 팀을 짜고, reviewer가 최종 판정한 뒤 synthesizer가 결론을 정리해줘.',
  });

  const generated = team.agents.flatMap((agent) => agent.generated_skill_briefs || []);
  assert.ok(generated.length >= 2);
  assert.ok(generated.some((entry) => /프로토콜|루브릭/.test(entry.label)));

  const message = formatTeamProposalMessage(team);
  assert.match(message, /생성 skill:/);

  const runtime = {};
  applyTeamConfigurationToRuntime(runtime, team);
  assert.ok(runtime.runtimeTeamSnapshot.runtime_agents.some((agent) => String(agent.assigned_goal || '').includes('추가 수행 프로토콜:')));
});
