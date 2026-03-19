import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfigurationAdvanced,
  formatTeamProposalMessage,
} from '../src/application/team_configuration.js';

test('advanced freeform team creation respects planner-provided debate structure and planner metadata', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: '한국 주식시장 투자에 도움을 받고싶은데, 구체적으로 팀을 구성해줘. 한 Agent는 특정 Agent의 반대 의견을 내서 서로 토의하듯이 Agent team을 구성하고싶어.',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4',
        reasoning_summary: ['opposing-view requirement preserved'],
      },
      plan: {
        team_name: 'kr_market_debate_team',
        agents: [
          {
            name: 'Lead Thesis Researcher',
            role: 'researcher',
            purpose: '한국 증시 투자 thesis를 가장 강하게 구조화한다',
            model: 'gpt-5.4',
            provider: 'chatgpt',
            capabilities: ['thesis framing', 'market mapping'],
            attached_skill_ids: ['skill.kr_equity_analysis.v1'],
            generated_skill_briefs: [
              { label: '핵심 논지 구조화 프로토콜', goal: '핵심 thesis와 근거를 구조화한다', checklist: ['핵심 주장 요약'] },
            ],
          },
          {
            name: 'Counterpoint Researcher',
            role: 'researcher',
            purpose: 'Lead Thesis Researcher의 핵심 주장에 대한 반대 의견과 깨지는 조건을 제시한다',
            model: 'gpt-5.4',
            provider: 'chatgpt',
            capabilities: ['counterargument design'],
            generated_skill_briefs: [
              { label: '반대 논리 생성 프로토콜', goal: '상대 주장에 대한 가장 강한 반박을 작성한다', checklist: ['핵심 가정 식별'] },
            ],
          },
          {
            name: 'Debate Adjudicator',
            role: 'reviewer',
            purpose: '충돌하는 주장을 비교하고 판정한다',
            model: 'gpt-5.4',
            provider: 'chatgpt',
          },
          {
            name: 'Decision Synthesizer',
            role: 'synthesizer',
            purpose: '최종 행동 가능한 결론을 요약한다',
            model: 'gpt-5.4',
            provider: 'chatgpt',
          },
        ],
        interaction_spec: {
          execution_pattern: 'multi_research_adjudication',
          final_answer_owner: 'Decision Synthesizer',
          handoffs: [
            { from: 'Lead Thesis Researcher', to: 'Counterpoint Researcher', payload: 'claim_plus_supporting_evidence' },
            { from: 'Counterpoint Researcher', to: 'Debate Adjudicator', payload: 'counterargument_plus_risks' },
            { from: 'Debate Adjudicator', to: 'Decision Synthesizer', payload: 'review_summary_only' },
          ],
        },
      },
    }),
  });

  assert.equal(team.planner_metadata.planner_model, 'gpt-5.4');
  assert.equal(team.interaction_spec.execution_pattern, 'multi_research_adjudication');
  assert.ok(team.agents.some((agent) => /counter|반대/i.test(`${agent.name} ${agent.purpose}`)));
  assert.ok(team.agents.some((agent) => agent.generated_skill_briefs?.some((entry) => /프로토콜/.test(entry.label))));

  const message = formatTeamProposalMessage(team);
  assert.match(message, /설계 엔진: codex_cli · gpt-5.4/i);
  assert.match(message, /생성 skill:/);
});
