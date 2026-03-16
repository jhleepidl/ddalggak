import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPreviewAgentIndex,
  buildPlanPreviewLines,
} from '../src/adapters/telegram/preview_formatting.js';
import {
  formatChatAgentDisplayName,
  buildAgentDisplayIndex,
} from '../src/shared/agent_labels.js';

test('chat-facing labels never expose opaque runtime ids when a fallback human label is needed', () => {
  const label = formatChatAgentDisplayName('9c1d31a3f7b54e90', new Map());
  assert.equal(label, 'Agent');
});

test('preview index can map raw action agent ids to runtime display labels', () => {
  const actions = [{
    type: 'agent_run',
    agent: '9c1d31a3f7b54e90',
    prompt: 'collect market headlines',
    inputs: {
      runtime_instance_id: 'rt_news_01',
      role_id: 'researcher',
      display_label: 'Market News Researcher',
    },
  }];
  const agentIndex = buildPreviewAgentIndex({ actions });
  const lines = buildPlanPreviewLines(actions, { agentIndex });
  assert.deepEqual(lines, ['- Market News Researcher: collect market headlines']);
});

test('buildAgentDisplayIndex preserves direct raw-id rows with human display labels', () => {
  const index = buildAgentDisplayIndex([
    { id: '9c1d31a3f7b54e90', display_label: 'Investment Memo Synthesizer' },
  ]);
  assert.equal(formatChatAgentDisplayName('9c1d31a3f7b54e90', index), 'Investment Memo Synthesizer');
});


test('action agent raw ids are not promoted into display labels or name hints', () => {
  const actions = [{
    type: 'agent_run',
    agent: '9c1d31a3',
    prompt: 'analyze',
    inputs: {
      role_id: 'researcher',
    },
  }];
  const agentIndex = buildPreviewAgentIndex({ actions });
  const lines = buildPlanPreviewLines(actions, { agentIndex });
  assert.deepEqual(lines, ['- Researcher: analyze']);
  assert.equal(formatChatAgentDisplayName('9c1d31a3', agentIndex), 'Researcher');
});
