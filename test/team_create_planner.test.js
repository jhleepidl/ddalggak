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


test('advanced freeform team creation injects builder coverage for web-service build requests even when planner omits it', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: '웹 서비스 개발을 위한 팀을 만들어줘. 백엔드 API와 프론트엔드 구현이 필요해.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'web_service_team',
        agents: [
          { name: 'Product Researcher', role: 'researcher', purpose: '요구사항과 사용자 시나리오를 정리한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '품질과 리스크를 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'sequential_pipeline',
          final_answer_owner: 'Quality Reviewer',
          handoffs: [
            { from: 'Product Researcher', to: 'Quality Reviewer', payload: 'summary_plus_key_evidence' },
          ],
        },
      },
    }),
  });

  assert.ok(team.agents.some((agent) => agent.role === 'builder'));
  assert.equal(team.interaction_spec.execution_pattern, 'builder_reviewer_loop');
  const builderAgent = team.agents.find((agent) => agent.role === 'builder');
  assert.ok(builderAgent);
  assert.ok(team.interaction_spec.handoffs.some((handoff) => handoff.from === builderAgent.name || handoff.to === builderAgent.name));
});


test('advanced freeform team creation preserves provider/tool metadata and repairs publish contract for declared final owner', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: '코드베이스를 조사하고 최종 요약을 정리하는 팀을 만들어줘',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'repo_scout_team',
        agents: [
          {
            name: 'Repo Scout',
            role: 'researcher',
            purpose: '코드베이스를 탐색하고 핵심 근거를 정리한다',
            model: 'gemini-2.5-pro',
            provider: 'gemini',
            required_tool_ids: ['workspace_fs'],
            optional_tool_ids: ['ripgrep'],
          },
        ],
        interaction_spec: {
          execution_pattern: 'single_specialist',
          final_answer_owner: 'Repo Scout',
          handoffs: [],
        },
      },
    }),
  });

  const participant = team.structure_v2.participants.find((row) => row.participant_id === 'repo_scout');
  assert.equal(participant?.provider, 'gemini');
  assert.deepEqual(participant?.required_tool_ids, ['workspace_fs']);
  assert.deepEqual(participant?.optional_tool_ids, ['ripgrep']);
  assert.ok(team.interaction_spec.final_answer_owner);
  const finalOwner = team.agents.find((agent) => agent.name === team.interaction_spec.final_answer_owner);
  assert.ok(finalOwner);
  const finalSurface = team.memory_plan.surfaces.find((surface) => String(surface.surface_id || '').toLowerCase() === 'final_answer' || (surface.semantic_slots || []).includes('final_answer'));
  assert.ok(finalSurface);
  assert.ok((finalSurface.target_roles || []).includes(finalOwner.role));
  const artifactSurface = team.memory_plan.surfaces.find((surface) => String(surface.surface_id || '').toLowerCase() === 'artifact_index' || (surface.semantic_slots || []).includes('artifact_index'));
  assert.ok(artifactSurface);
  assert.ok((artifactSurface.target_roles || []).some((roleId) => ['builder', 'synthesizer', 'reviewer', 'researcher'].includes(roleId)));
});
