import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreModelNodeForTask, selectModelNodeForTask } from '../src/application/model_node_selector.js';

test('model node selector prefers local free private node for sensitive review work', () => {
  const nodes = [
    {
      id: 'external_fast',
      provider: 'openai_compatible',
      model: 'cheap-small',
      enabled: true,
      capabilities: { chat: true, code: true },
      permissions: { workspace_read: true, workspace_write: false },
      cost_profile: { tier: 'cheap' },
      latency_profile: { tier: 'fast' },
      quality_profile: { tier: 'standard' },
      privacy_profile: { tier: 'external_api', data_boundary: 'external_provider', sends_context_off_device: true },
      role_bias: ['reviewer'],
    },
    {
      id: 'local_private',
      provider: 'openai_compatible',
      model: 'gemma3:12b',
      enabled: true,
      capabilities: { chat: true, code: true },
      permissions: { workspace_read: true, workspace_write: false },
      cost_profile: { tier: 'free' },
      latency_profile: { tier: 'medium' },
      quality_profile: { tier: 'standard' },
      privacy_profile: { tier: 'local_private', data_boundary: 'local_device', sends_context_off_device: false },
      role_bias: ['reviewer', 'local_private_reasoning'],
    },
  ];
  const selection = selectModelNodeForTask({ nodes, roleId: 'reviewer', taskText: '민감한 내부 코드 변경을 로컬에서 review해줘', privacyRequired: true });
  assert.equal(selection.selected.id, 'local_private');
  assert.match(selection.fit.reasons.join(','), /privacy_fit/);
});

test('model node selector marks missing required capabilities', () => {
  const fit = scoreModelNodeForTask({
    id: 'draft_only',
    provider: 'openai_compatible',
    model: 'small',
    enabled: true,
    capabilities: { chat: true, code: false },
    permissions: { workspace_read: false, workspace_write: false },
    cost_profile: { tier: 'cheap' },
    latency_profile: { tier: 'fast' },
    quality_profile: { tier: 'draft' },
    privacy_profile: { tier: 'external_api', sends_context_off_device: true },
  }, { roleId: 'builder', needsCode: true, workspaceWriteRequired: true });
  assert.equal(fit.executable, false);
  assert.deepEqual(fit.missing_capabilities.sort(), ['code', 'workspace_write']);
});

test('model node selector accepts trusted remote Ollama for private context', () => {
  const nodes = [
    {
      id: 'public_api',
      provider: 'openai_compatible',
      model: 'cheap-small',
      enabled: true,
      capabilities: { chat: true, code: true },
      permissions: { workspace_read: true, workspace_write: false },
      cost_profile: { tier: 'cheap' },
      latency_profile: { tier: 'fast' },
      quality_profile: { tier: 'standard' },
      privacy_profile: { tier: 'external_api', data_boundary: 'external_provider', sends_context_off_device: true },
      role_bias: ['reviewer'],
    },
    {
      id: 'remote_ollama',
      provider: 'openai_compatible',
      runtime: 'ollama',
      model: 'qwen2.5-coder:32b',
      enabled: true,
      capabilities: { chat: true, code: true },
      permissions: { workspace_read: true, workspace_write: false },
      cost_profile: { tier: 'free' },
      latency_profile: { tier: 'slow' },
      quality_profile: { tier: 'strong' },
      privacy_profile: { tier: 'trusted_private', data_boundary: 'user_controlled_remote', sends_context_off_device: true, allow_private_context: true },
      role_bias: ['reviewer', 'local_private_reasoning'],
    },
  ];
  const selection = selectModelNodeForTask({ nodes, roleId: 'reviewer', taskText: '민감한 프로젝트 메모리를 검토해줘', privacyRequired: true });
  assert.equal(selection.selected.id, 'remote_ollama');
  assert.match(selection.fit.reasons.join(','), /privacy_fit/);
});
