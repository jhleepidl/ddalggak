import test from 'node:test';
import assert from 'node:assert/strict';

import { routeWithSupervisor } from '../src/chat/supervisor_router.js';

test('single-agent chat uses local fast route instead of LLM supervisor', async () => {
  const prev = process.env.CHAT_SUPERVISOR_LOCAL_FAST_PATH;
  process.env.CHAT_SUPERVISOR_LOCAL_FAST_PATH = '1';
  try {
    const plan = await routeWithSupervisor('오늘 저녁 뭐먹을지 추천해줘.', {
      agents: [{ id: 'research_lead', provider: 'gemini', model: 'gemini-2.5-pro' }],
      enabledAgentIds: ['research_lead'],
      currentJobId: '',
      contextSummary: '[CURRENT TASK PACKET]\n- Latest user request: "오늘 저녁 뭐먹을지 추천해줘."',
    });
    assert.match(plan.reason, /fast_local_route/);
    assert.equal(plan.actions?.[0]?.type, 'run_agent');
    assert.equal(plan.actions?.[0]?.agent_id, 'research_lead');
  } finally {
    if (prev === undefined) delete process.env.CHAT_SUPERVISOR_LOCAL_FAST_PATH;
    else process.env.CHAT_SUPERVISOR_LOCAL_FAST_PATH = prev;
  }
});
