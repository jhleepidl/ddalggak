import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRoomConciergeModelPolicy,
  shouldEnableConciergeFastPathForPolicy,
} from '../src/application/room_concierge_model_policy.js';

test('auto model policy prefers configured antigravity for casual direct ask', () => {
  const policy = resolveRoomConciergeModelPolicy({
    decision: { route: 'concierge_direct_answer' },
    env: { ANTIGRAVITY_CLI_COMMAND: 'antigravity', ANTIGRAVITY_MODEL: 'free-fast' },
  });
  assert.equal(policy.provider, 'antigravity');
  assert.equal(policy.model, 'free-fast');
  assert.equal(shouldEnableConciergeFastPathForPolicy(policy), true);
});

test('auto model policy does not silently fall back to codex for casual ask', () => {
  const policy = resolveRoomConciergeModelPolicy({
    decision: { route: 'concierge_direct_answer' },
    env: {},
  });
  assert.equal(policy.provider, '');
  assert.equal(shouldEnableConciergeFastPathForPolicy(policy), false);
});

test('codex fallback requires explicit allow switch', () => {
  const policy = resolveRoomConciergeModelPolicy({
    decision: { route: 'concierge_direct_answer' },
    env: { DDALGGAK_ASK_ALLOW_CODEX_FALLBACK: 'true' },
  });
  assert.equal(policy.provider, 'codex');
});


test('model policy accepts simplified fast provider env', () => {
  const policy = resolveRoomConciergeModelPolicy({
    decision: { route: 'concierge_direct_answer' },
    env: { DDALGGAK_FAST_PROVIDER: 'openai_compatible', DDALGGAK_FAST_MODEL: 'llama-fast', DDALGGAK_LOCAL_BASE_URL: 'http://localhost:11434/v1' },
  });
  assert.equal(policy.provider, 'openai_compatible');
  assert.equal(policy.model, 'llama-fast');
});

test('model policy accepts simplified search provider env', () => {
  const policy = resolveRoomConciergeModelPolicy({
    decision: { route: 'concierge_search_answer' },
    env: { DDALGGAK_SEARCH_PROVIDER: 'antigravity', DDALGGAK_SEARCH_MODEL: 'ag-fast' },
  });
  assert.equal(policy.provider, 'antigravity');
  assert.equal(policy.model, 'ag-fast');
});
