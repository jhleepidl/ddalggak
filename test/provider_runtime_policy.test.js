import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureGeminiWorkspaceConfig } from '../src/gemini.js';
import { resolveProviderRuntimeOptions } from '../src/application/provider_runtime_policy.js';


test('resolveProviderRuntimeOptions merges codex sandbox/approval/add_dirs and mcp config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-policy-codex-'));
  try {
    const resolved = resolveProviderRuntimeOptions({
      runtimeExecutionPolicy: {
        approval_matrix: { codex_exec: 'ask', verification: 'allow' },
        providers: {
          codex: {
            sandbox_mode: 'danger-full-access',
            approval_policy: 'on-request',
            profile: 'repo-maintainer',
            add_dirs: ['uploads', '../shared'],
            config_overrides: { model_provider: 'openai' },
            mcp_servers: {
              repo_docs: {
                command: 'npx',
                args: ['-y', '@acme/repo-docs-mcp'],
              },
            },
          },
        },
      },
      provider: 'codex',
      workspaceRoot: root,
    });
    assert.equal(resolved.sandboxMode, 'danger-full-access');
    assert.equal(resolved.approvalPolicy, 'on-request');
    assert.equal(resolved.profile, 'repo-maintainer');
    assert.equal(Array.isArray(resolved.addDirs), true);
    assert.equal(resolved.addDirs.includes(path.resolve(root, 'uploads')), true);
    assert.equal(resolved.configOverrides.model_provider, 'openai');
    assert.equal(resolved.configOverrides.mcp_servers.repo_docs.command, 'npx');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('ensureGeminiWorkspaceConfig writes policy patch including mcp settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-policy-gemini-'));
  try {
    const result = ensureGeminiWorkspaceConfig(root, {
      overwritePolicy: 'merge',
      patchSettings: {
        mcpServers: {
          workspace_docs: {
            command: 'node',
            args: ['mcp-server.js'],
          },
        },
        output: { format: 'json' },
      },
    });
    assert.equal(fs.existsSync(result.settingsPath), true);
    const parsed = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    assert.equal(parsed.output.format, 'json');
    assert.equal(parsed.mcpServers.workspace_docs.command, 'node');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProviderRuntimeOptions exposes reasoning effort and harness variant for all CLI providers', () => {
  const policy = {
    providers: {
      codex: { reasoning_effort: 'high', harness_variant_id: 'code_executor.codex.default.high.v1' },
      claude: { effort: 'medium', harness_variant_id: 'code_executor.claude.default.medium.v1' },
      antigravity: { reasoning_effort: 'provider_default', harness_variant_id: 'code_executor.antigravity.default.v1' },
    },
  };
  const codex = resolveProviderRuntimeOptions({ runtimeExecutionPolicy: policy, provider: 'codex' });
  const claude = resolveProviderRuntimeOptions({ runtimeExecutionPolicy: policy, provider: 'claude' });
  const antigravity = resolveProviderRuntimeOptions({ runtimeExecutionPolicy: policy, provider: 'antigravity' });
  assert.equal(codex.reasoningEffort, 'high');
  assert.equal(codex.harnessVariantId, 'code_executor.codex.default.high.v1');
  assert.equal(claude.reasoningEffort, 'medium');
  assert.equal(claude.harnessVariantId, 'code_executor.claude.default.medium.v1');
  assert.equal(antigravity.harnessVariantId, 'code_executor.antigravity.default.v1');
});
