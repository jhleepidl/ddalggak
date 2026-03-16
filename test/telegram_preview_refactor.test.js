import test from 'node:test';
import assert from 'node:assert/strict';

import { toolInputPreviewFromAction } from '../src/adapters/telegram/tool_preview.js';
import {
  buildPreviewAgentIndex,
  buildPlanPreviewLines,
  formatChatActionLabel,
} from '../src/adapters/telegram/preview_formatting.js';
import { interpretTask } from '../src/control_plane/task_interpreter.js';

test('tool preview helper uses runtime-aware labels for parallel children', () => {
  const preview = toolInputPreviewFromAction({
    type: 'spawn_parallel',
    agents: [
      { agent: 'researcher', prompt: 'collect filings', inputs: { display_label: 'Filing Researcher', role_id: 'researcher' } },
      { agent: 'reviewer', prompt: 'check risks', inputs: { display_label: 'Risk Reviewer', role_id: 'reviewer' } },
    ],
  });

  assert.match(preview, /children=Filing Researcher, Risk Reviewer/);
});

test('preview formatting prefers runtime display labels over generic role ids', () => {
  const actions = [{
    type: 'agent_run',
    agent: 'researcher',
    prompt: 'Collect market headlines',
    inputs: {
      runtime_instance_id: 'rt_news_01',
      role_id: 'researcher',
      display_label: 'Market News Researcher',
    },
  }];
  const agentIndex = buildPreviewAgentIndex({ actions });
  const lines = buildPlanPreviewLines(actions, { agentIndex });
  const label = formatChatActionLabel(actions[0], { agentIndex });

  assert.deepEqual(lines, ['- Market News Researcher: Collect market headlines']);
  assert.equal(label, 'run_agent:Market News Researcher');
});

test('task interpreter keeps plain finance recommendation requests out of builder flow', () => {
  const interpreted = interpretTask({
    goal: '내일 한국 주식 뭐 살까? 투자 포인트와 리스크를 정리해줘',
  });

  assert.notEqual(interpreted.task_type, 'code_change');
  assert.equal(interpreted.candidate_capability_slots.some((slot) => slot.role_id === 'builder'), false);
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === 'researcher'));
});
