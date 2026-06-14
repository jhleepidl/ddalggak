import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWorkModeToWorkflowContract,
  formatWorkModeCommandSummary,
  parseTaskWorkModeCommand,
} from '../src/application/task_work_mode_command.js';
import { buildTeamWorkflowContract } from '../src/application/team_workflow_contract.js';

test('parseTaskWorkModeCommand parses shortcut command with loop override', () => {
  const parsed = parseTaskWorkModeCommand('project --loops 3 repo patch 구현하고 테스트해줘', { defaultSubcommand: 'project' });
  assert.equal(parsed.work_mode.work_mode, 'project_task');
  assert.equal(parsed.work_mode.loop_budget, 3);
  assert.equal(parsed.goal, 'repo patch 구현하고 테스트해줘');
  assert.match(formatWorkModeCommandSummary(parsed.work_mode, parsed.cycle_policy), /mode=project_task/);
});

test('parseTaskWorkModeCommand parses explicit mode command', () => {
  const parsed = parseTaskWorkModeCommand('start --mode research_campaign --loops staged survey paper 만들어줘', { defaultSubcommand: 'start' });
  assert.equal(parsed.work_mode.work_mode, 'research_campaign');
  assert.equal(parsed.work_mode.loop_budget, 'staged');
  assert.equal(parsed.work_mode.review_policy, 'stage_gate');
  assert.equal(parsed.goal, 'survey paper 만들어줘');
});

test('applyWorkModeToWorkflowContract turns research into staged checkpoint contract', () => {
  const parsed = parseTaskWorkModeCommand('research agent team selection survey', { defaultSubcommand: 'research' });
  const base = buildTeamWorkflowContract({ goal: parsed.goal, signals: {} });
  const contract = applyWorkModeToWorkflowContract(base, parsed.work_mode, parsed.cycle_policy);
  assert.equal(contract.workflow_kind, 'staged_research_campaign');
  assert.equal(contract.work_mode.work_mode, 'research_campaign');
  assert.equal(contract.approval_boundary, true);
  assert.ok(contract.stop_conditions.includes('user_checkpoint'));
});

test('parseTaskWorkModeCommand exposes three user-facing depths', () => {
  const instant = parseTaskWorkModeCommand('instant 빠르게 답해줘', { defaultSubcommand: 'instant' });
  assert.equal(instant.work_mode.work_depth, 'instant');
  assert.equal(instant.work_mode.work_mode, 'quick_answer');
  assert.equal(instant.goal, '빠르게 답해줘');

  const team = parseTaskWorkModeCommand('team 여러 관점으로 검토해줘', { defaultSubcommand: 'team' });
  assert.equal(team.work_mode.work_depth, 'team');
  assert.equal(team.work_mode.work_mode, 'team_review');

  const loop = parseTaskWorkModeCommand('loop --loops 3 repo 수정하고 테스트해줘', { defaultSubcommand: 'loop' });
  assert.equal(loop.work_mode.work_depth, 'loop');
  assert.equal(loop.work_mode.work_mode, 'project_task');
  assert.equal(loop.work_mode.loop_budget, 3);
});
