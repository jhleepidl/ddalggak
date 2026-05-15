import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChatGptCodexProviderOptions, resolveChatGptProviderBridge } from '../src/application/chatgpt_provider_bridge.js';

test('chatgpt provider bridge defaults to Codex CLI instead of manual paste fallback', () => {
  const bridge = resolveChatGptProviderBridge({});
  assert.equal(bridge.mode, 'codex');
  assert.equal(bridge.reason, 'default_codex_bridge');
});

test('chatgpt provider bridge allows explicit legacy manual fallback only when requested', () => {
  const bridge = resolveChatGptProviderBridge({ CHATGPT_PROVIDER_BRIDGE: 'manual', CHATGPT_MANUAL_FALLBACK_ENABLED: 'true' });
  assert.equal(bridge.mode, 'manual');
});

test('chatgpt codex bridge defaults to read-only/no-approval execution', () => {
  const opts = resolveChatGptCodexProviderOptions({}, { CHATGPT_CODEX_PROFILE: 'gpt-5.5-thinking' });
  assert.equal(opts.sandboxMode, 'read-only');
  assert.equal(opts.approvalPolicy, 'never');
  assert.equal(opts.profile, 'gpt-5.5-thinking');
});
