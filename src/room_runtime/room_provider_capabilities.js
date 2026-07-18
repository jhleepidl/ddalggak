import { cleanText } from './fs_utils.js';

const BASE = {
  codex: {
    provider: 'codex',
    adapter_version: 'room_provider_adapter/v1',
    capabilities: [
      'provider_native_planning', 'workspace_read', 'workspace_write', 'command_execution',
      'validation', 'streaming_output', 'skills', 'mcp', 'structured_handoff',
    ],
    permission_modes: ['read_only', 'workspace_write'],
    native_resume: false,
  },
  antigravity: {
    provider: 'antigravity',
    adapter_version: 'room_provider_adapter/v1',
    capabilities: [
      'provider_native_planning', 'workspace_read', 'snapshot_review', 'research',
      'streaming_output', 'skills', 'mcp', 'structured_handoff',
    ],
    permission_modes: ['read_only_snapshot'],
    native_resume: false,
  },
};

export function inspectRoomProviderCapabilities(provider = '', env = process.env) {
  const id = cleanText(provider).toLowerCase();
  const base = BASE[id];
  if (!base) return { provider: id || 'unknown', available: false, capabilities: [], permission_modes: [], native_resume: false };
  const command = id === 'codex' ? cleanText(env.CODEX_CLI_COMMAND || 'codex') : cleanText(env.ANTIGRAVITY_CLI_COMMAND || 'agy');
  return {
    ...base,
    available: Boolean(command),
    command,
    model_policy: id === 'codex'
      ? cleanText(env.DDALGGAK_WORK_MODEL || env.CODEX_MODEL || '') || 'provider_default'
      : cleanText(env.ANTIGRAVITY_MODEL || '') || 'provider_default',
  };
}

export function inspectRoomProviderPortfolio(env = process.env) {
  return {
    schema_version: 'ai_rooms.provider_capability_portfolio/v1',
    providers: ['codex', 'antigravity'].map((provider) => inspectRoomProviderCapabilities(provider, env)),
    inspected_at: new Date().toISOString(),
  };
}

export function assertProviderCapabilities(provider = '', required = [], env = process.env) {
  const capability = inspectRoomProviderCapabilities(provider, env);
  const available = new Set(capability.capabilities || []);
  const missing = (Array.isArray(required) ? required : []).map((value) => cleanText(value)).filter(Boolean).filter((value) => !available.has(value));
  if (missing.length) {
    const error = new Error(`Provider ${provider} does not satisfy Room stage capabilities: ${missing.join(', ')}`);
    error.code = 'ROOM_PROVIDER_CAPABILITY_MISMATCH';
    error.provider = provider;
    error.missing_capabilities = missing;
    throw error;
  }
  return capability;
}
