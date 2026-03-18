import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfiguration,
  suggestTeamConfiguration,
  validateTeamConfiguration,
} from '../src/application/team_configuration.js';

test('structured suggest uses structured composition mode', () => {
  const team = suggestTeamConfiguration({ taskText: '삼성전자 실적과 뉴스 분석' });
  assert.equal(team.composition_mode, 'structured');
  assert.equal(team.proposal_mode, 'suggest');
  assert.ok(Array.isArray(team.agents));
  assert.ok(team.agents.length >= 1);
});

test('freeform create uses freeform composition mode and custom agents', () => {
  const team = createFreeformTeamConfiguration({ description: '낙관론 분석가와 비관론 분석가를 두고 reviewer가 비교한 뒤 synthesizer가 최종 메모를 작성해줘' });
  assert.equal(team.composition_mode, 'freeform');
  assert.equal(team.proposal_mode, 'create');
  assert.ok(team.agents.some((agent) => /bull analyst/i.test(agent.name)));
  assert.ok(team.agents.some((agent) => /bear analyst/i.test(agent.name)));
  assert.equal(team.interaction_spec.execution_pattern, 'parallel_research_then_review_then_synthesize');
});

test('validateTeamConfiguration accepts composition metadata in template', () => {
  const validated = validateTeamConfiguration({
    team_name: 'custom_team',
    mode: 'scoped_context',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    task_brief: '자유 생성 팀',
    agents: [
      { agent_id: 'bull_analyst', name: 'Bull Analyst', role: 'researcher', model: 'Gemini 2.5', purpose: '강세 논리 정리' },
      { agent_id: 'reviewer_1', name: 'Reviewer', role: 'reviewer', model: 'gpt-5.4', purpose: '검토' },
    ],
    interaction_spec: {
      execution_pattern: 'sequential_pipeline',
      final_answer_owner: 'Reviewer',
      handoffs: [{ from: 'Bull Analyst', to: 'Reviewer', payload: 'summary_only' }],
    },
  });
  assert.equal(validated.composition_mode, 'freeform');
  assert.equal(validated.agents[0].model, 'gemini-2.5-pro');
});
