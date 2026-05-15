function clean(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function truthyEnv(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(cleanLower(value));
}

function falsyEnv(value = '') {
  return ['0', 'false', 'no', 'off'].includes(cleanLower(value));
}

export function resolveChatGptProviderBridge(env = process.env) {
  const explicit = cleanLower(env.CHATGPT_PROVIDER_BRIDGE || env.CHATGPT_PROVIDER_MODE || '');
  const manualEnabled = truthyEnv(env.CHATGPT_MANUAL_FALLBACK_ENABLED || '');
  const codexDisabled = falsyEnv(env.CHATGPT_CODEX_BRIDGE_ENABLED || env.CODEX_CHATGPT_BRIDGE_ENABLED || '');
  if (explicit) {
    if (['manual', 'paste', 'copy_paste', 'copy-paste', 'legacy'].includes(explicit)) {
      return { mode: manualEnabled || explicit === 'manual' || explicit === 'legacy' ? 'manual' : 'disabled', reason: 'manual_bridge_requested' };
    }
    if (['off', 'none', 'disabled', 'disable'].includes(explicit)) {
      return { mode: manualEnabled ? 'manual' : 'disabled', reason: 'chatgpt_bridge_disabled' };
    }
    if (['codex', 'codex_cli', 'codex-cli'].includes(explicit)) {
      return codexDisabled ? { mode: manualEnabled ? 'manual' : 'disabled', reason: 'codex_bridge_disabled' } : { mode: 'codex', reason: 'explicit_codex_bridge' };
    }
  }
  if (!codexDisabled) return { mode: 'codex', reason: 'default_codex_bridge' };
  if (manualEnabled) return { mode: 'manual', reason: 'manual_fallback_enabled' };
  return { mode: 'disabled', reason: 'no_chatgpt_execution_bridge' };
}

export function resolveChatGptCodexProviderOptions(baseOptions = {}, env = process.env) {
  const cleanBase = baseOptions && typeof baseOptions === 'object' ? baseOptions : {};
  return {
    ...cleanBase,
    sandboxMode: clean(cleanBase.sandboxMode || cleanBase.sandbox_mode || env.CHATGPT_CODEX_SANDBOX_MODE || env.CODEX_ASSIST_SANDBOX_MODE || 'read-only') || 'read-only',
    approvalPolicy: clean(cleanBase.approvalPolicy || cleanBase.approval_policy || env.CHATGPT_CODEX_APPROVAL_POLICY || env.CODEX_ASSIST_APPROVAL_POLICY || 'never') || 'never',
    profile: clean(cleanBase.profile || env.CHATGPT_CODEX_PROFILE || env.CODEX_PROFILE || ''),
  };
}

export function isChatGptManualFallbackEnabled(env = process.env) {
  const bridge = resolveChatGptProviderBridge(env);
  return bridge.mode === 'manual';
}

export function chatGptBridgeHelpText(env = process.env) {
  const bridge = resolveChatGptProviderBridge(env);
  if (bridge.mode === 'codex') {
    return 'chatgpt provider requests are executed through Codex CLI using the configured Codex/ChatGPT account.';
  }
  if (bridge.mode === 'manual') {
    return 'chatgpt provider requests use the legacy manual copy/paste fallback.';
  }
  return 'chatgpt provider requests are disabled until CHATGPT_PROVIDER_BRIDGE=codex or CHATGPT_MANUAL_FALLBACK_ENABLED=true is configured.';
}
