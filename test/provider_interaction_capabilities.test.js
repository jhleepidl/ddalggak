import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseBusyRunInterruptionStrategy,
  resolveProviderInteractionCapabilities,
} from '../src/application/provider_interaction_capabilities.js';

test('codex app_server is marked as steer-capable through the bridge', () => {
  const caps = resolveProviderInteractionCapabilities({ provider: 'codex', model: 'gpt-5-codex', executionChannel: 'app_server' });
  assert.equal(caps.native.web_browse, true);
  assert.equal(caps.native.request_user_input, true);
  assert.equal(caps.integration.active_turn_steering_bridge, true);
  assert.equal(caps.integration.integration_stability, 'stable');
});

test('codex local cli remains non-steerable in current bridge', () => {
  const strategy = chooseBusyRunInterruptionStrategy({
    activeRuns: [{ provider: 'codex', model: 'gpt-5-codex', execution_channel: 'local_cli' }],
    requestedMode: 'replan',
  });
  assert.equal(strategy.strategy, 'cancel_replan');
  assert.equal(strategy.reason, 'active_turn_steering_bridge_unavailable');
});
