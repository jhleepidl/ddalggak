import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfigurationAdvanced,
  refineTeamConfigurationAdvanced,
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

test('advanced freeform team creation reconciles planner handoffs that target pruned agents', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: '상반된 투자 의견을 비교하고 reviewer가 판정한 뒤 최종 요약을 작성해줘',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4',
      },
      plan: {
        team_name: 'debate_team_with_builder_handoff',
        agents: [
          { name: 'Core Bull Researcher', role: 'researcher', purpose: '강세 논리 전개', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Contrarian Bear Researcher', role: 'researcher', purpose: '약세 논리 전개', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Assignment Builder', role: 'builder', purpose: '과제 산출물 작성', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Debate Reviewer', role: 'reviewer', purpose: '논리 비교와 판정', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Decision Synthesizer', role: 'synthesizer', purpose: '최종 요약', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'multi_research_adjudication',
          final_answer_owner: 'Decision Synthesizer',
          handoffs: [
            { from: 'Core Bull Researcher', to: 'Assignment Builder', payload: 'summary_plus_key_evidence' },
            { from: 'Assignment Builder', to: 'Debate Reviewer', payload: 'draft_plus_change_summary' },
            { from: 'Debate Reviewer', to: 'Decision Synthesizer', payload: 'review_summary_only' },
          ],
        },
      },
    }),
  });

  assert.equal(team.agents.some((agent) => agent.name === 'Assignment Builder'), false);
  assert.equal(team.interaction_spec.handoffs.some((handoff) => handoff.to === 'Assignment Builder' || handoff.from === 'Assignment Builder'), false);
  assert.equal(team.interaction_spec.handoffs.some((handoff) => handoff.to === 'Decision Synthesizer'), true);
});


test('advanced team refinement uses planner output to revise lineup and interaction spec', async () => {
  const baseTeam = {
    team_name: 'kr_market_team',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    task_brief: '한국 주식시장 투자 판단을 돕는 팀',
    agents: [
      { agent_id: 'market_mapper', name: '시장 지도 조사관', role: 'researcher', model: 'gemini-2.5-pro', purpose: '시장 구조와 섹터를 정리한다' },
      { agent_id: 'idea_researcher', name: '투자 아이디어 조사관', role: 'researcher', model: 'gemini-2.5-pro', purpose: '유망 아이디어를 찾는다' },
      { agent_id: 'decision_writer', name: '투자 결론 정리자', role: 'synthesizer', model: 'gpt-5.4', purpose: '최종 답변을 정리한다' },
    ],
    interaction_spec: {
      execution_pattern: 'parallel_research_then_review_then_synthesize',
      final_answer_owner: '투자 결론 정리자',
      handoffs: [
        { from: '시장 지도 조사관', to: '투자 결론 정리자', payload: 'summary_plus_key_evidence' },
        { from: '투자 아이디어 조사관', to: '투자 결론 정리자', payload: 'summary_plus_key_evidence' },
      ],
    },
  };
  const refined = await refineTeamConfigurationAdvanced(baseTeam, '한 agent는 반대 의견을 내고, reviewer가 둘의 주장을 판정하게 바꿔줘', {
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4_refine',
        reasoning_summary: ['added counterpoint and reviewer handoff'],
      },
      plan: {
        team_name: 'kr_market_debate_refined',
        agents: [
          { name: 'KR Bull Researcher', role: 'researcher', purpose: '상승 시나리오와 근거를 구성한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'KR Bear Researcher', role: 'researcher', purpose: '반대 의견과 하락 리스크를 구성한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Debate Reviewer', role: 'reviewer', purpose: '찬반 양측을 비교 판정한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Decision Synthesizer', role: 'synthesizer', purpose: '판정 결과를 최종 결론으로 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'multi_research_adjudication',
          final_answer_owner: 'Decision Synthesizer',
          handoffs: [
            { from: 'KR Bull Researcher', to: 'KR Bear Researcher', payload: 'claim_plus_supporting_evidence' },
            { from: 'KR Bull Researcher', to: 'Debate Reviewer', payload: 'summary_plus_key_evidence' },
            { from: 'KR Bear Researcher', to: 'Debate Reviewer', payload: 'counterargument_plus_risks' },
            { from: 'Debate Reviewer', to: 'Decision Synthesizer', payload: 'review_summary_only' },
          ],
        },
      },
    }),
  });

  assert.equal(refined.proposal_mode, 'refine');
  assert.equal(refined.planner_metadata.planner_model, 'gpt-5.4');
  assert.equal(refined.interaction_spec.execution_pattern, 'multi_research_adjudication');
  assert.ok(refined.agents.some((agent) => /Bear|반대/i.test(`${agent.name} ${agent.purpose}`)));
  assert.ok(refined.agents.some((agent) => agent.role === 'reviewer'));
  assert.equal(refined.interaction_spec.final_answer_owner, 'Decision Synthesizer');
});

test('advanced team refinement falls back to heuristic refine when planner fails', async () => {
  const baseTeam = {
    team_name: 'base_team',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    task_brief: '기본 조사 팀',
    agents: [
      { agent_id: 'researcher_1', name: 'Researcher', role: 'researcher', model: 'gemini-2.5-pro', purpose: '조사한다' },
    ],
  };
  const refined = await refineTeamConfigurationAdvanced(baseTeam, 'builder 추가', {
    planner: async () => ({ ok: false, reason: 'planner_unavailable_for_test' }),
  });

  assert.equal(refined.proposal_mode, 'refine');
  assert.equal(refined.planner_metadata.planning_source, 'heuristic_refine_fallback');
  assert.ok(refined.agents.some((agent) => agent.role === 'builder'));
});
