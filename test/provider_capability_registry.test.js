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
