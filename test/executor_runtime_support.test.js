import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAwaitUserRequestFromFailure,
  isAbortLikeError,
  makeCancelledError,
  readInterruptState,
  summarizeCommitteeCoverage,
} from '../src/chat/executor_runtime_support.js';

test('makeCancelledError creates ECANCELLED errors recognized by isAbortLikeError', () => {
  const err = makeCancelledError('stop now');
  assert.equal(err.code, 'ECANCELLED');
  assert.equal(isAbortLikeError(err), true);
  assert.equal(isAbortLikeError(new Error('request aborted by user')), true);
  assert.equal(isAbortLikeError(new Error('ordinary failure')), false);
});

test('readInterruptState normalizes cancel and replan interrupts', () => {
  const store = {
    get(chatId) {
      if (chatId === 'cancel') return { interrupt: { requested: true, mode: 'cancel', reason: 'user_stop', ts: 't1' } };
      if (chatId === 'replan') return { interrupt: { requested: true, mode: 'something-else', reason: 'route_shift', ts: 't2' } };
      return {};
    },
  };
  assert.deepEqual(readInterruptState(store, 'cancel'), { requested: true, mode: 'cancel', reason: 'user_stop', ts: 't1' });
  assert.deepEqual(readInterruptState(store, 'replan'), { requested: true, mode: 'replan', reason: 'route_shift', ts: 't2' });
  assert.equal(readInterruptState(store, 'missing'), null);
});

test('summarizeCommitteeCoverage counts responded slots from outputs', () => {
  const coverage = summarizeCommitteeCoverage({ inputs: { member_slot_ids: ['lead', 'reviewer'] } }, [
    { slot_id: 'lead', agentId: 'alpha' },
    { slot_id: 'reviewer', agentId: 'beta' },
    { slot_id: 'lead', agentId: 'alpha' },
  ]);
  assert.equal(coverage.responded_count, 2);
  assert.equal(coverage.responded_agent_count, 2);
  assert.deepEqual(coverage.responded_slot_ids.sort(), ['lead', 'reviewer']);
});

test('buildAwaitUserRequestFromFailure preserves source action metadata', () => {
  const request = buildAwaitUserRequestFromFailure(
    { category: 'missing_input', summary: 'Need target repo', user_message: 'repo 경로를 알려주세요.' },
    { label: 'builder', action: { type: 'run_agent', agent_id: 'builder' } },
  );
  assert.equal(request.category, 'missing_input');
  assert.equal(request.source_agent_id, 'builder');
  assert.equal(request.source_action_type, 'run_agent');
  assert.match(request.followup_hint, /repo 경로/);
});
