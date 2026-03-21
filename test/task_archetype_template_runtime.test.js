import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFreeformTeamConfiguration,
  createFreeformTeamConfigurationAdvanced,
  formatTeamProposalMessage,
  suggestTeamConfiguration,
  validateTeamConfiguration,
} from '../src/application/team_configuration.js';

test('structured suggestion seeds implementation archetype team blueprint for code-change tasks', () => {
  const team = suggestTeamConfiguration({ taskText: '레포를 점검하고 패치를 구현한 뒤 검토해서 요약해줘' });
  assert.equal(team.task_archetype, 'implementation');
  assert.ok(Array.isArray(team.memory_plan?.surfaces));
  assert.ok(team.memory_plan.surfaces.some((surface) => surface.surface_id === 'implementation_notes'));
  assert.equal(team.runtime_execution?.providers?.codex?.sandbox_mode, 'workspace-write');
  assert.ok(team.agents.some((agent) => agent.role === 'builder'));
  const message = formatTeamProposalMessage(team);
  assert.match(message, /task archetype: implementation/i);
  assert.match(message, /good for:/i);
});

test('freeform create defaults to research archetype and preserves research memory plan', () => {
  const team = createFreeformTeamConfiguration({
    description: '시장 조사와 근거 수집 후 짧은 브리프를 만들어줘',
  });
  assert.equal(team.task_archetype, 'research');
  assert.ok(team.memory_plan?.surfaces?.some((surface) => surface.surface_id === 'evidence_ledger'));
  const validated = validateTeamConfiguration(team);
  assert.equal(validated.task_archetype, 'research');
  assert.ok(validated.memory_plan?.surfaces?.some((surface) => surface.surface_id === 'evidence_ledger'));
});

test('advanced freeform planning pivots to review_repair archetype when planner requests audit-fix flow', async () => {
  const team = await createFreeformTeamConfigurationAdvanced({
    description: '현재 구현을 감사하고 회귀를 최소 수정으로 고쳐줘',
    planner: async () => ({
      ok: true,
      planner_metadata: {
        planner_type: 'codex_cli',
        planner_model: 'gpt-5.4',
        planning_source: 'codex_gpt_5_4',
      },
      plan: {
        team_name: 'repair_team',
        task_archetype: 'review_repair',
        agents: [
          { name: 'Audit Lead', role: 'reviewer', purpose: '핵심 결함을 식별한다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Repair Planner', role: 'researcher', purpose: '최소 수정 계획을 만든다', model: 'gpt-5.4', provider: 'chatgpt' },
          { name: 'Repair Builder', role: 'builder', purpose: '수정 패치를 적용한다', model: 'gpt-5-codex', provider: 'codex' },
          { name: 'Signoff Owner', role: 'synthesizer', purpose: '잔여 리스크를 정리한다', model: 'gpt-5.4', provider: 'chatgpt' },
        ],
      },
    }),
  });
  assert.equal(team.task_archetype, 'review_repair');
  assert.ok(team.memory_plan?.surfaces?.some((surface) => surface.surface_id === 'defect_log'));
  assert.ok(team.planner_metadata?.reasoning_summary?.some((entry) => /task archetype template: review_repair/i.test(entry)));
});
