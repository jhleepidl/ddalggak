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
  assert.equal(refined.interaction_spec.execution_pattern, 'sequential_pipeline');
  assert.ok(refined.interaction_spec.handoffs.some((handoff) => /builder/i.test(handoff.from) || /builder/i.test(handoff.to)));
  assert.equal(refined.planner_metadata.planner_model, 'gpt-5.4');
});
