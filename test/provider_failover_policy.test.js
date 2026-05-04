import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyProviderFailure, resolveProviderFailoverDecision } from '../src/application/provider_failover_policy.js';

test('classifyProviderFailure detects Gemini model capacity exhaustion', () => {
  const failure = classifyProviderFailure({
    provider: 'gemini',
    error: new Error('No capacity available for model gemini-3-flash-preview\nMODEL_CAPACITY_EXHAUSTED\nstatus 429'),
  });
  assert.equal(failure.category, 'provider_capacity');
  assert.equal(failure.safe_to_failover, true);
});

test('resolveProviderFailoverDecision maps Gemini capacity to Codex', () => {
  const decision = resolveProviderFailoverDecision({
    provider: 'gemini',
    error: new Error('[gemini] capacity circuit open; retry after 40000ms'),
    roleId: 'researcher',
  });
  assert.equal(decision.should_failover, true);
  assert.equal(decision.to_provider, 'codex');
});

test('resolveProviderFailoverDecision does not fail over credential gaps', () => {
  const decision = resolveProviderFailoverDecision({
    provider: 'gemini',
    error: new Error('credential login required'),
  });
  assert.equal(decision.should_failover, false);
  assert.equal(decision.failure.category, 'credential_gap');
});
