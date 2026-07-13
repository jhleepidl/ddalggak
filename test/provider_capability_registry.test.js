import test from 'node:test';
import assert from 'node:assert/strict';
import { probeProviderCapability, resolveProviderCliCommand } from '../src/evaluation/provider_capability_registry.js';

test('provider capability probe records CLI version and capability surface', async () => {
  const calls = [];
  const row = await probeProviderCapability({ provider: 'codex', env: { CODEX_CLI_COMMAND: '/opt/codex' }, runner: async (command, args) => { calls.push({ command, args }); return { ok: true, exitCode: 0, stdout: 'codex-cli 9.9.9\n', stderr: '' }; } });
  assert.equal(resolveProviderCliCommand('codex', { CODEX_CLI_COMMAND: '/opt/codex' }), '/opt/codex');
  assert.equal(calls[0].command, '/opt/codex');
  assert.equal(row.cli_available, true);
  assert.equal(row.cli_version, 'codex-cli 9.9.9');
  assert.equal(row.capabilities.native_subagents, true);
  assert.equal(row.capabilities.reasoning_effort, true);
});

test('provider capability probe rejects model-catalog JSON as a CLI version', async () => {
  const row = await probeProviderCapability({
    provider: 'codex',
    runner: async () => ({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ models: [{ slug: 'gpt-5.5' }] }),
      stderr: '',
    }),
  });
  assert.equal(row.cli_available, true);
  assert.equal(row.cli_version, null);
});

test('provider capability probe recovers a version from stderr when stdout contains catalog JSON', async () => {
  const row = await probeProviderCapability({
    provider: 'codex',
    runner: async () => ({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ models: [{ slug: 'gpt-5.5' }] }),
      stderr: 'codex-cli 0.144.1\n',
    }),
  });
  assert.equal(row.cli_version, 'codex-cli 0.144.1');
});
