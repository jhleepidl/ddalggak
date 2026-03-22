import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfigurationAdvanced,
  refineTeamConfigurationAdvanced,
} from '../src/application/team_configuration.js';

test('advanced freeform team creation filters irrelevant domain skills from planner output', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: 'Context Engineering 수업의 과제 및 프로젝트 생성 및 편집을 위한 team을 구성해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4',
      },
      plan: {
        team_name: 'coursework_studio',
        agents: [
          {
            name: 'Curriculum Researcher',
            role: 'researcher',
            purpose: 'Course goals, assignment patterns, and grading criteria를 조사한다',
            model: 'gemini-2.5-pro',
            provider: 'gemini',
            attached_skill_ids: ['skill.kr_equity_analysis.v1', 'skill.claim_evidence_audit.v1'],
          },
          {
            name: 'Final Synthesizer',
            role: 'synthesizer',
            purpose: '여러 초안과 검토 의견을 합쳐 최종 coursework package를 정리한다',
            model: 'gpt-5.4',
            provider: 'chatgpt',
            attached_skill_ids: ['skill.kr_equity_analysis.v1', 'skill.telegram_briefing.v1'],
          },
        ],
      },
    }),
  });

  const researcher = team.agents.find((agent) => agent.name === 'Curriculum Researcher');
  const synthesizer = team.agents.find((agent) => agent.name === 'Final Synthesizer');
  assert.ok(researcher);
  assert.ok(synthesizer);
  assert.equal(researcher.attached_skill_ids.includes('skill.kr_equity_analysis.v1'), false);
  assert.equal(synthesizer.attached_skill_ids.includes('skill.kr_equity_analysis.v1'), false);
});

test('advanced refine uses planner output to add coder/builder and update interaction', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: 'Context Engineering 수업의 과제 및 프로젝트 생성 및 편집을 위한 team을 구성해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'coursework_studio',
        agents: [
          { name: 'Curriculum Researcher', role: 'researcher', purpose: '과제 유형과 평가 기준을 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Pedagogy Reviewer', role: 'reviewer', purpose: '난이도와 평가 기준을 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Final Synthesizer', role: 'synthesizer', purpose: '최종 coursework package를 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'parallel_research_then_review_then_synthesize',
          final_answer_owner: 'Final Synthesizer',
          handoffs: [
            { from: 'Curriculum Researcher', to: 'Pedagogy Reviewer', payload: 'summary_plus_key_evidence' },
            { from: 'Pedagogy Reviewer', to: 'Final Synthesizer', payload: 'review_summary_only' },
          ],
        },
      },
    }),
  });

  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: 'ipython notebook으로 실습 및 과제를 진행하고 싶어. 그러니 Coder Agent도 추가해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4_refine',
        reasoning_summary: ['notebook builder added'],
      },
      plan: {
        team_name: 'context_engineering_notebook_studio',
        agents: [
          { name: 'Curriculum Researcher', role: 'researcher', purpose: '과제 유형과 notebook-friendly reference를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Notebook Builder', role: 'builder', purpose: 'IPython/Jupyter notebook 실습과 과제 초안을 구현한다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Pedagogy Reviewer', role: 'reviewer', purpose: '실행 흐름, 난이도, rubric을 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Final Synthesizer', role: 'synthesizer', purpose: '최종 notebook coursework package를 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'sequential_pipeline',
          final_answer_owner: 'Final Synthesizer',
          handoffs: [
            { from: 'Curriculum Researcher', to: 'Notebook Builder', payload: 'summary_plus_key_evidence' },
            { from: 'Notebook Builder', to: 'Pedagogy Reviewer', payload: 'draft_plus_change_summary' },
            { from: 'Pedagogy Reviewer', to: 'Final Synthesizer', payload: 'review_summary_only' },
          ],
          policies: {
            reviewer_visibility: 'summaries_plus_selected_evidence',
            synthesizer_visibility: 'upstream_outputs_only',
          },
        },
      },
    }),
  });

  assert.ok(refined.agents.some((agent) => agent.role === 'builder'));
  assert.ok(refined.agents.some((agent) => /notebook/i.test(`${agent.name} ${agent.purpose}`)));
  assert.equal(refined.interaction_spec.execution_pattern, 'builder_reviewer_loop');
  assert.ok(refined.interaction_spec.handoffs.some((handoff) => /builder/i.test(handoff.from) || /builder/i.test(handoff.to)));
  assert.equal(refined.planner_metadata.planner_model, 'gpt-5.4');
});


test('advanced refine removes omitted agents when instruction explicitly asks for removal', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '과제용 조사 팀을 구성해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'coursework_team',
        agents: [
          { name: 'Lead Researcher', role: 'researcher', purpose: '자료를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Pedagogy Reviewer', role: 'reviewer', purpose: '검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Final Synthesizer', role: 'synthesizer', purpose: '정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: 'reviewer는 제거하고 researcher와 synthesizer만 유지해줘',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4_refine',
      },
      plan: {
        team_name: 'lean_coursework_team',
        agents: [
          { name: 'Lead Researcher', role: 'researcher', purpose: '자료를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Final Synthesizer', role: 'synthesizer', purpose: '정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  assert.equal(refined.agents.some((agent) => agent.name === 'Pedagogy Reviewer'), false);
});


test('advanced refine restores builder coverage for web-service refinement even when planner returns research-heavy roster', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '서비스 요구사항을 분석하는 팀을 구성해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'service_analysis_team',
        agents: [
          { name: 'Lead Researcher', role: 'researcher', purpose: '요구사항을 정리한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '리스크를 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: '이제 실제 웹 서비스 개발 팀으로 바꿔줘. 백엔드 API와 프론트엔드 구현이 필요해.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4_refine' },
      plan: {
        team_name: 'service_build_team',
        agents: [
          { name: 'Lead Researcher', role: 'researcher', purpose: '요구사항을 정리한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '리스크를 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
        interaction_spec: {
          execution_pattern: 'sequential_pipeline',
          final_answer_owner: 'Quality Reviewer',
          handoffs: [
            { from: 'Lead Researcher', to: 'Quality Reviewer', payload: 'summary_plus_key_evidence' },
          ],
        },
      },
    }),
  });

  assert.ok(refined.agents.some((agent) => agent.role === 'builder'));
  assert.equal(refined.interaction_spec.execution_pattern, 'builder_reviewer_loop');
});
