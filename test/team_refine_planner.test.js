import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfigurationAdvanced,
  refineTeamConfiguration,
  refineTeamConfigurationAdvanced,
} from '../src/application/team_configuration.js';

test('advanced refine tries LLM planner before minor model/provider fallback', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '웹 서비스를 개발하기 위한 팀.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'web_service_team',
        agents: [
          { name: 'Product Researcher', role: 'researcher', purpose: '요구사항을 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Service Builder', role: 'builder', purpose: '구현한다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  let plannerCalls = 0;
  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: 'Service Builder의 model만 gpt-5-codex로 바꾸고 나머지 팀 구조는 그대로 유지해줘.',
    planner: async () => {
      plannerCalls += 1;
      return { ok: false, reason: 'planner unavailable in test' };
    },
  });

  assert.equal(plannerCalls, 1);
  assert.equal(refined.agents.length, baseTeam.agents.length);
  assert.equal(refined.agents.find((agent) => agent.name === 'Service Builder')?.model, 'gpt-5-codex');
  assert.equal(refined.planner_metadata?.planning_source, 'heuristic_refine_fallback_after_llm_failure');
});


test('minor refine fallback applies provider/model settings to the intended agents only', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '웹사이트 구현을 위한 팀을 만들어줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'gemini_cli', planner_model: 'gemini-3-flash-preview', planning_source: 'gemini_cli_team_planner' },
      plan: {
        team_name: 'website_team',
        agents: [
          { name: 'Workspace Builder', role: 'builder', purpose: '웹사이트를 구현한다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Implementation Reviewer', role: 'reviewer', purpose: '구현 결과를 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Delivery Synthesizer', role: 'synthesizer', purpose: '최종 전달을 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: 'Implementation Reviewer와 Delivery synthesizer는 gemini를 사용해주고, Workspace builder는 ChatGPT의 GPT-5.5를 사용해줘.',
    planner: async () => ({ ok: false, reason: 'planner unavailable in test' }),
  });

  const builder = refined.agents.find((agent) => agent.name === 'Workspace Builder');
  const reviewer = refined.agents.find((agent) => agent.name === 'Implementation Reviewer');
  const synthesizer = refined.agents.find((agent) => agent.name === 'Delivery Synthesizer');
  assert.equal(builder?.provider, 'chatgpt');
  assert.equal(builder?.model, 'gpt-5.5');
  assert.equal(reviewer?.provider, 'gemini');
  assert.equal(reviewer?.model, 'gemini-3-flash-preview');
  assert.equal(synthesizer?.provider, 'gemini');
  assert.equal(synthesizer?.model, 'gemini-3-flash-preview');
});

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


test('advanced refine preserves omitted agents on partial edits and rebuilds structure without stale blueprint corruption', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '새로운 웹 서비스를 개발하기 위한 팀.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'web_service_team',
        agents: [
          { name: 'Product Researcher', role: 'researcher', purpose: '요구사항과 근거를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Service Builder', role: 'builder', purpose: '실제 변경안과 실행 계획을 만든다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '리스크와 검증 누락을 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Delivery Synthesizer', role: 'synthesizer', purpose: '최종 답변을 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Repo Scout', role: 'researcher', purpose: '코드베이스를 탐색한다', model: 'gemini-2.5-pro', provider: 'gemini' },
        ],
      },
    }),
  });

  const refined = await refineTeamConfigurationAdvanced({
    team: baseTeam,
    instruction: 'Delivery Synthesizer는 Gemini 3.0을 사용해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4_refine',
        reasoning_summary: ['updated synthesizer model'],
      },
      plan: {
        team_name: 'web_service_team',
        agents: [
          { name: 'Product Researcher', role: 'researcher', purpose: '요구사항과 근거를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Service Builder', role: 'builder', purpose: '실제 변경안과 실행 계획을 만든다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '리스크와 검증 누락을 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Delivery Synthesizer', role: 'synthesizer', purpose: '최종 답변을 정리한다', model: 'gemini-3-flash-preview', provider: 'gemini' },
        ],
      },
    }),
  });

  assert.equal(refined.agents.length, 5);
  assert.equal(refined.agents.some((agent) => agent.name === 'Repo Scout'), true);
  const synth = refined.agents.find((agent) => agent.name === 'Delivery Synthesizer');
  assert.equal(synth?.provider, 'gemini');
  assert.equal(synth?.model, 'gemini-3-flash-preview');
  const participantIds = (refined.structure_v2?.participants || []).map((row) => row.participant_id);
  assert.equal(participantIds.includes('repo_scout'), true);
  const finalParticipant = refined.structure_v2?.topology?.final_participant_id;
  assert.equal(finalParticipant, 'delivery_synthesizer');
  const finalParticipantRow = (refined.structure_v2?.participants || []).find((row) => row.participant_id === 'delivery_synthesizer');
  assert.equal(finalParticipantRow?.model, 'gemini-3-flash-preview');
});


test('advanced refine preserves full roster for model-only edits even when planner collapses to a single agent and stale structure is present', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '롤 클라이언트 보조 프로그램 개발을 위한 팀을 구성해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'arena_augment_team',
        agents: [
          { name: 'Game Integration Researcher', role: 'researcher', purpose: '외부 제약과 데이터 근거를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Companion App Builder', role: 'builder', purpose: '실제 변경안과 실행 계획을 만든다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Implementation Reviewer', role: 'reviewer', purpose: '결과의 약점과 리스크를 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Delivery Synthesizer', role: 'synthesizer', purpose: '최종 답변을 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Repo Scout', role: 'researcher', purpose: '코드베이스를 탐색한다', model: 'gemini-2.5-pro', provider: 'gemini' },
        ],
        interaction_spec: {
          execution_pattern: 'builder_reviewer_loop',
          final_answer_owner: 'Delivery Synthesizer',
          handoffs: [
            { from: 'Game Integration Researcher', to: 'Companion App Builder', payload: 'repo_map_and_constraints' },
            { from: 'Companion App Builder', to: 'Implementation Reviewer', payload: 'draft_plus_change_summary' },
            { from: 'Implementation Reviewer', to: 'Delivery Synthesizer', payload: 'review_summary_only' },
          ],
        },
      },
    }),
  });

  const staleStoredTeam = {
    ...baseTeam,
    primary_schema: 'team_blueprint_v1',
    structure_v2: {
      metadata: { team_name: 'arena_augment_team', composition_mode: 'freeform', proposal_mode: 'create', status: 'suggested' },
      intent: { task_brief: baseTeam.task_brief, task_archetype: 'implementation' },
      participants: [
        { participant_id: 'game_integration_researcher', kind: 'agent', label: 'Game Integration Researcher', role: 'researcher', purpose: '외부 제약과 데이터 근거를 조사한다', provider: 'gemini', model: 'gemini-2.5-pro' },
      ],
      topology: { pattern: 'workflow', execution_pattern: 'builder_reviewer_loop', final_participant_id: 'game_integration_researcher', nodes: [], edges: [] },
      control_policy: { final_answer_owner_participant_id: 'game_integration_researcher' },
      memory_plan: baseTeam.memory_plan,
    },
  };

  const refined = await refineTeamConfigurationAdvanced({
    team: staleStoredTeam,
    instruction: 'Delivery Synthesizer의 경우 Gemini 3.0을 사용해줘.',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4_refine',
        reasoning_summary: ['existing implementation team structure preserved'],
      },
      plan: {
        team_name: 'arena_augment_team',
        agents: [
          { name: 'Game Integration Researcher', role: 'researcher', purpose: '리그 오브 레전드 클라이언트 보조 프로그램 구현에 필요한 외부 제약, 데이터 근거, 통합 리스크를 조사한다.', model: 'gemini-2.5-pro', provider: 'gemini' },
        ],
        interaction_spec: {
          execution_pattern: 'builder_reviewer_loop',
          final_answer_owner: 'Game Integration Researcher',
        },
      },
    }),
  });

  assert.equal(refined.agents.length, staleStoredTeam.agents.length);
  assert.deepEqual(refined.agents.map((agent) => agent.name), staleStoredTeam.agents.map((agent) => agent.name));
  assert.deepEqual(refined.agents.map((agent) => agent.name), [
    'Game Integration Researcher',
    'Companion App Builder',
    'Implementation Reviewer',
    'Delivery Synthesizer',
    'Repo Scout',
  ]);
  assert.equal(refined.agents.find((agent) => agent.name === 'Game Integration Researcher')?.role, 'researcher');
  const synth = refined.agents.find((agent) => agent.name === 'Delivery Synthesizer');
  assert.equal(synth?.provider, 'gemini');
  assert.equal(synth?.model, 'gemini-3-flash-preview');
  assert.equal(refined.interaction_spec.final_answer_owner, 'Delivery Synthesizer');
});

test('heuristic refine preserves full roster for model-only agent edits', async () => {
  const baseTeam = await createFreeformTeamConfigurationAdvanced({
    description: '웹 서비스를 개발하기 위한 팀.',
    planner: async () => ({
      ok: true,
      planner_metadata: { planner_type: 'codex_cli', planner_model: 'gpt-5.4', planning_source: 'codex_gpt_5_4' },
      plan: {
        team_name: 'web_service_team',
        agents: [
          { name: 'Product Researcher', role: 'researcher', purpose: '요구사항과 근거를 조사한다', model: 'gemini-2.5-pro', provider: 'gemini' },
          { name: 'Service Builder', role: 'builder', purpose: '실제 변경안과 실행 계획을 만든다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Quality Reviewer', role: 'reviewer', purpose: '리스크와 검증 누락을 검토한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Delivery Synthesizer', role: 'synthesizer', purpose: '최종 답변을 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });

  const refined = refineTeamConfiguration(baseTeam, 'Delivery Synthesizer는 Gemini 3.0을 사용해줘.');
  assert.equal(refined.agents.length, baseTeam.agents.length);
  assert.equal(refined.interaction_spec.final_answer_owner, 'Delivery Synthesizer');
  assert.equal(refined.agents.find((agent) => agent.name === 'Delivery Synthesizer')?.model, 'gemini-3-flash-preview');
  assert.equal(refined.agents.find((agent) => agent.name === 'Delivery Synthesizer')?.provider, 'gemini');
});
