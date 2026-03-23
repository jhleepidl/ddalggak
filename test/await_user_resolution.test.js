import test from 'node:test';
import assert from 'node:assert/strict';

import { executeSupervisorActions } from '../src/chat/executor.js';

test('await_user from missing context is delegated to another agent before asking the user', async () => {
  let builderCalls = 0;
  let researcherCalls = 0;
  const result = await executeSupervisorActions({
    chatId: 'chat-1',
    userId: 'user-1',
    jobId: 'job-1',
    plan: {
      actions: [
        { type: 'run_agent', agent_id: 'builder', goal: '코드 패치를 진행해줘' },
      ],
    },
    agents: [
      { id: 'builder', provider: 'codex', role: 'builder' },
      { id: 'researcher', provider: 'gemini', role: 'researcher' },
    ],
    callbacks: {
      runAgent: async ({ action, detailContext }) => {
        if (action.agent_id === 'builder') {
          builderCalls += 1;
          if (builderCalls === 1) throw new Error('need more detail about target file path');
          assert.match(String(detailContext || ''), /\[input_resolution\]/);
          assert.match(String(detailContext || ''), /src\/app\.js/);
          assert.equal(Array.isArray(action?.inputs?.resolved_inputs), true);
          assert.equal(action.inputs.resolved_inputs[0]?.resolved_by_agent_id, 'researcher');
          return { output: '패치 완료', provider: 'codex', mode: 'local_cli' };
        }
        if (action.agent_id === 'researcher') {
          researcherCalls += 1;
          assert.match(String(action.goal || ''), /RESOLUTION:/);
          assert.equal(action?.inputs?.input_request?.request_kind, 'context_resolution');
          return {
            output: [
              'RESOLUTION: AGENT_RESOLVED',
              'ANSWER: Repository context indicates the target is src/app.js',
              'CONFIDENCE: 0.81',
              'EVIDENCE: implementation_notes; workspace/src/app.js',
              'RATIONALE: Builder can continue with the concrete file path.',
            ].join('\n'),
            provider: 'gemini',
            mode: 'local_cli',
          };
        }
        throw new Error(`unexpected agent ${action.agent_id}`);
      },
    },
  });

  assert.equal(builderCalls, 2);
  assert.equal(researcherCalls, 1);
  assert.equal(result.await_user_request, null);
  assert.equal(result.results.some((row) => String(row?.note || '').includes('resolved by researcher')), true);
  assert.equal(result.outputs.some((row) => row?.mode === 'input_resolution'), true);
});

test('credential gaps still wait for the user instead of delegating to another agent', async () => {
  let researcherCalls = 0;
  const result = await executeSupervisorActions({
    chatId: 'chat-2',
    userId: 'user-2',
    jobId: 'job-2',
    plan: {
      actions: [
        { type: 'run_agent', agent_id: 'builder', goal: '비공개 API를 호출해줘' },
      ],
    },
    agents: [
      { id: 'builder', provider: 'codex', role: 'builder' },
      { id: 'researcher', provider: 'gemini', role: 'researcher' },
    ],
    callbacks: {
      runAgent: async ({ action }) => {
        if (action.agent_id === 'researcher') researcherCalls += 1;
        throw new Error('missing API key for external service');
      },
    },
  });

  assert.equal(researcherCalls, 0);
  assert.equal(result.await_user_request?.category, 'credential_gap');
  assert.equal(result.await_user_request?.request_kind, 'credential_request');
  assert.equal(result.await_user_request?.resolution_status, 'awaiting_user');
  assert.match(String(result.await_user_request?.followup_hint || ''), /credential/i);
});

