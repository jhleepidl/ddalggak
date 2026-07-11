import { runCommand } from '../proc.js';

function clean(value = '') { return String(value || '').trim(); }
function cleanKey(value = '') { return clean(value).toLowerCase(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = cleanKey(value);
  if (!text) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(text);
}

export const PROVIDER_CAPABILITY_DEFAULTS = Object.freeze({
  codex: {
    cli_command_env: 'CODEX_CLI_COMMAND',
    cli_command_default: 'codex',
    version_args: ['--version'],
    capabilities: {
      shell: true,
      workspace_edit: true,
      structured_output: true,
      mcp: true,
      skills: true,
      native_subagents: true,
      background_tasks: true,
      reasoning_effort: true,
      session_resume: true,
      streamed_events: true,
    },
  },
  claude: {
    cli_command_env: 'CLAUDE_CLI_COMMAND',
    cli_command_default: 'claude',
    version_args: ['--version'],
    capabilities: {
      shell: true,
      workspace_edit: true,
      structured_output: true,
      mcp: true,
      skills: true,
      native_subagents: true,
      background_tasks: true,
      reasoning_effort: true,
      session_resume: true,
      streamed_events: true,
    },
  },
  antigravity: {
    cli_command_env: 'ANTIGRAVITY_CLI_COMMAND',
    cli_command_default: 'agy',
    version_args: ['--version'],
    capabilities: {
      shell: true,
      workspace_edit: true,
      structured_output: false,
      mcp: true,
      skills: true,
      native_subagents: true,
      background_tasks: true,
      reasoning_effort: 'model_or_cli_config',
      session_resume: true,
      streamed_events: true,
    },
  },
});

export function normalizeProviderName(provider = '') {
  const key = cleanKey(provider);
  if (key === 'anthropic') return 'claude';
  if (key === 'openai') return 'codex';
  if (key === 'gemini' || key === 'google' || key === 'google-ai') return 'antigravity';
  return key;
}

export function resolveProviderCliCommand(provider = '', env = process.env) {
  const key = normalizeProviderName(provider);
  const profile = PROVIDER_CAPABILITY_DEFAULTS[key];
  if (!profile) return clean(provider);
  return clean(env?.[profile.cli_command_env]) || profile.cli_command_default;
}

export async function probeProviderCapability({ provider = '', model = '', reasoningEffort = '', env = process.env, timeoutMs = 10000, runner = runCommand } = {}) {
  const key = normalizeProviderName(provider);
  const defaults = asObject(PROVIDER_CAPABILITY_DEFAULTS[key]);
  const command = resolveProviderCliCommand(key, env);
  if (!key || !command) throw new Error(`Unknown provider: ${provider}`);
  const startedAt = new Date().toISOString();
  const versionResult = await runner(command, Array.isArray(defaults.version_args) ? defaults.version_args : ['--version'], {
    timeoutMs,
    env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const versionText = clean(versionResult.stdout || versionResult.stderr).split(/\r?\n/)[0] || '';
  return {
    schema_version: 'ddalggak.provider_capability_probe/v1',
    provider: key,
    model: clean(model) || null,
    reasoning_effort: clean(reasoningEffort) || null,
    cli_command: command,
    cli_available: versionResult.ok === true,
    cli_version: versionText || null,
    probe_exit_code: Number.isInteger(versionResult.exitCode) ? versionResult.exitCode : null,
    probed_at: startedAt,
    capabilities: { ...asObject(defaults.capabilities) },
  };
}

export async function probeProviderCapabilities({ providers = ['codex', 'claude', 'antigravity'], env = process.env, timeoutMs = 10000, runner = runCommand } = {}) {
  const items = [];
  for (const provider of providers) {
    try {
      items.push(await probeProviderCapability({ provider, env, timeoutMs, runner }));
    } catch (error) {
      items.push({
        schema_version: 'ddalggak.provider_capability_probe/v1',
        provider: normalizeProviderName(provider),
        cli_available: false,
        cli_version: null,
        probed_at: new Date().toISOString(),
        error: clean(error?.message || error),
        capabilities: { ...asObject(PROVIDER_CAPABILITY_DEFAULTS[normalizeProviderName(provider)]?.capabilities) },
      });
    }
  }
  return {
    schema_version: 'ddalggak.provider_capability_registry/v1',
    generated_at: new Date().toISOString(),
    items,
  };
}

export function providerCapabilityFingerprint(profile = {}) {
  const row = asObject(profile);
  return [
    clean(row.provider),
    clean(row.cli_version),
    clean(row.model),
    clean(row.reasoning_effort),
    JSON.stringify(asObject(row.capabilities)),
  ].join('|');
}
