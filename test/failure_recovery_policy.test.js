import test from 'node:test';
import assert from 'node:assert/strict';

import { executeSupervisorActions } from '../src/chat/executor.js';
import { classifyExecutionFailure, resolveProviderActionRisk } from '../src/application/failure_recovery_policy.js';

class MemorySessionStore {
  constructor() { this.map = new Map(); }
  get(chatId) { return this.map.get(String(chatId)) || null; }
  upsert(chatId, patch) {
    const key = String(chatId);
    const current = this.map.get(key) || {};
    const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
    this.map.set(key, next);
    return next;
  }
}

test('classifyExecutionFailure detects credential and transient failures', () => {
  const credential = classifyExecutionFailure({
    error: new Error('OPENAI_API_KEY not set for provider'),
    action: { type: 'run_agent', agent_id: 'builder', goal: 'patch notebook' },
    provider: 'codex',
  });
  assert.equal(credential.category, 'credential_gap');
  assert.equal(credential.recovery_strategy, 'await_user');

  const transient = classifyExecutionFailure({
    error: new Error('429 rate limit exceeded; try again later'),
    action: { type: 'run_agent', agent_id: 'researcher', goal: 'search docs' },
    provider: 'gemini',
  });
  assert.equal(transient.category, 'transient_infra');
  assert.equal(transient.recovery_strategy, 'retry_once');
});


test('classifyExecutionFailure treats aborted runs as user interruption instead of unknown failure', () => {
  const interrupted = classifyExecutionFailure({
    error: new Error('Codex interrupted\n[aborted]'),
    action: { type: 'run_agent', agent_id: 'builder', goal: 'patch notebook' },
    provider: 'codex',
  });
  assert.equal(interrupted.category, 'user_interrupted');
  assert.equal(interrupted.recovery_strategy, 'stop');
  assert.match(String(interrupted.summary || ''), /중단|재계획/);
});

test('resolveProviderActionRisk keeps normal codex work at L2 and critical work at L3', () => {
  assert.equal(resolveProviderActionRisk({
    action: { type: 'run_agent', goal: 'implement notebook cleanup' },
    provider: 'codex',
    fallback: 'L2',
  }), 'L2');

  assert.equal(resolveProviderActionRisk({
    action: { type: 'run_agent', goal: 'deploy to production and rotate API key' },
    provider: 'codex',
    fallback: 'L2',
  }), 'L3');
});

test('executeSupervisorActions turns credential gaps into await_user state', async () => {
  const sessionStore = new MemorySessionStore();
  const execution = await executeSupervisorActions({
    chatId: 'chat_failure_user',
    userId: 'user_failure_user',
    jobId: 'job_failure_user',
    plan: {
      actions: [
        { type: 'run_agent', agent_id: 'builder', goal: 'patch notebook', risk: 'L1' },
        { type: 'summarize', hint: 'done', risk: 'L0' },
      ],
    },
    agents: [{ id: 'builder', provider: 'codex' }],
    sessionStore,
    callbacks: {
      runAgent: async () => {
        throw new Error('OPENAI_API_KEY not set for provider');
      },
    },
  });

  assert.equal(execution.await_user_request?.category, 'credential_gap');
  assert.match(String(execution.await_user_request?.followup_hint || ''), /credential/i);
  assert.equal(sessionStore.get('chat_failure_user')?.state, 'awaiting_user');
  assert.equal(Array.isArray(execution.remaining_actions), true);
  assert.equal(execution.remaining_actions.length, 1);
});

test('executeSupervisorActions uses scout recovery before retrying implementation failures', async () => {
  const seen = [];
  const execution = await executeSupervisorActions({
    chatId: 'chat_failure_recovery',
    userId: 'user_failure_recovery',
    jobId: 'job_failure_recovery',
    plan: {
      runtime_team_snapshot: {
        runtime_execution: {
          continuous_improvement: { enabled: true, max_turns: 4 },
        },
      },
      actions: [
        { type: 'run_agent', agent_id: 'builder', goal: 'fix the failing tests', risk: 'L1' },
      ],
    },
    agents: [
      { id: 'builder', provider: 'codex', role: 'builder' },
      { id: 'researcher', provider: 'gemini', role: 'researcher' },
    ],
    callbacks: {
      runAgent: async ({ action, detailContext }) => {
        const agentId = String(action?.agent_id || '').trim().toLowerCase();
        seen.push({ agentId, detailContext: String(detailContext || '') });
        if (agentId === 'builder' && !String(detailContext || '').includes('[failure_recovery]')) {
          throw new Error('tests failed: module not found');
        }
        if (agentId === 'researcher') {
          return { provider: 'gemini', mode: 'agent_run', output: 'probable_cause: missing import\nfix_strategy: restore import\nretry_patch: add the missing import first' };
        }
        return { provider: agentId === 'builder' ? 'codex' : 'gemini', mode: 'agent_run', output: 'patched successfully' };
      },
    },
  });

  const recoveryNote = execution.results.find((row) => String(row?.label || '').includes('recovery'));
  const finalOk = execution.results.find((row) => row.status === 'ok' && String(row?.note || '').includes('recovered='));
  assert.ok(recoveryNote);
  assert.ok(finalOk);
  assert.equal(seen[0].agentId, 'builder');
  assert.equal(seen[1].agentId, 'researcher');
  assert.equal(seen[2].agentId, 'builder');
  assert.match(String(seen[2].detailContext || ''), /failure_recovery/);
});


test('publish contract failures are classified as policy_blocked awaiting user action', () => {
  const failure = classifyExecutionFailure({ error: new Error('publish contract blocked: final synthesis는 final_answer surface가 선언된 agent만 수행할 수 있습니다') });
  assert.equal(failure.category, 'policy_blocked');
  assert.equal(failure.recovery_strategy, 'await_user');
  assert.match(failure.summary, /publish contract/);
});
