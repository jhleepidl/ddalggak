import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveActionRouteSignals } from '../src/chat/structural_runtime.js';
import { executeSupervisorActions } from '../src/chat/executor.js';

test('resolveActionRouteSignals preserves fallback signals when provided explicitly', () => {
  const signals = resolveActionRouteSignals({
    action: { type: 'run_agent', inputs: {} },
    result: { output: 'repair complete' },
    fallbackSignals: ['repair_attempted'],
  });

  assert.deepEqual(signals, ['repair_attempted']);
});

test('resolveActionRouteSignals parses QUALITY_DECISION_JSON stop signals without outgoing conditions', () => {
  const signals = resolveActionRouteSignals({
    action: { type: 'run_agent', inputs: {} },
    result: {
      output: [
        'QUALITY_DECISION_JSON',
        '```json',
        JSON.stringify({ decision: 'stop', signals: ['quality_threshold_met', 'ready_for_user'], reason: 'ready' }),
        '```',
      ].join('\n'),
    },
  });

  assert.deepEqual(signals, ['quality_threshold_met', 'ready_for_user']);
});

test('supervisor executor attaches quality stop signals emitted by reviewer-like outputs', async () => {
  const result = await executeSupervisorActions({
    chatId: 'chat-quality',
    userId: 'user-quality',
    jobId: 'job-quality',
    plan: {
      actions: [
        {
          type: 'run_agent',
          agent_id: 'reviewer',
          goal: 'Assess whether the workspace is ready',
          inputs: { slot_id: 'slot_review' },
        },
      ],
    },
    callbacks: {
      async runAgent() {
        return {
          output: [
            'Looks ready.',
            'QUALITY_DECISION_JSON',
            '```json',
            JSON.stringify({ decision: 'stop', signals: ['quality_threshold_met'], reason: 'ready for user' }),
            '```',
          ].join('\n'),
          provider: 'gemini',
          mode: 'chat',
        };
      },
    },
  });

  assert.equal(result.outputs.some((row) => Array.isArray(row.route_signals) && row.route_signals.includes('quality_threshold_met')), true);
});
