function clean(value = '') {
  return String(value || '').trim();
}

function cleanKey(value = '') {
  return clean(value).toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function resolveProviderInteractionCapabilities({ provider = '', model = '', executionChannel = '' } = {}) {
  const providerKey = cleanKey(provider);
  const modelKey = cleanKey(model);
  const channelKey = cleanKey(executionChannel);

  const native = {
    web_browse: false,
    request_user_input: false,
    steer_active_turn: false,
    session_resume: false,
    streamed_events: false,
  };

  const integration = {
    mid_run_user_input_bridge: false,
    active_turn_steering_bridge: false,
    session_resume_bridge: false,
    streamed_event_bridge: false,
    integration_stability: 'none',
  };

  if (providerKey === 'codex' || modelKey.includes('codex')) {
    native.web_browse = true;
    native.request_user_input = true;
    native.steer_active_turn = true;
    native.session_resume = true;
    native.streamed_events = true;
    integration.integration_stability = channelKey === 'app_server' ? 'stable' : 'planned';
    if (channelKey === 'app_server') {
      integration.mid_run_user_input_bridge = true;
      integration.active_turn_steering_bridge = true;
      integration.session_resume_bridge = true;
      integration.streamed_event_bridge = true;
    }
  } else if (providerKey === 'gemini' || modelKey.startsWith('gemini')) {
    native.request_user_input = true;
    native.session_resume = true;
    native.streamed_events = true;
    integration.integration_stability = 'experimental';
    if (channelKey === 'acp' || channelKey === 'stream_json') {
      integration.streamed_event_bridge = true;
    }
  } else if (providerKey === 'chatgpt') {
    integration.integration_stability = 'none';
  }

  return {
    provider: providerKey || undefined,
    model: clean(model) || undefined,
    execution_channel: channelKey || undefined,
    native,
    integration,
  };
}

export function summarizeProviderInteractionCapabilities(input = {}) {
  const caps = resolveProviderInteractionCapabilities(input);
  return {
    provider: caps.provider,
    model: caps.model,
    execution_channel: caps.execution_channel,
    native: {
      web_browse: caps.native.web_browse === true,
      request_user_input: caps.native.request_user_input === true,
      steer_active_turn: caps.native.steer_active_turn === true,
      session_resume: caps.native.session_resume === true,
      streamed_events: caps.native.streamed_events === true,
    },
    integration: {
      mid_run_user_input_bridge: caps.integration.mid_run_user_input_bridge === true,
      active_turn_steering_bridge: caps.integration.active_turn_steering_bridge === true,
      session_resume_bridge: caps.integration.session_resume_bridge === true,
      streamed_event_bridge: caps.integration.streamed_event_bridge === true,
      integration_stability: caps.integration.integration_stability || 'none',
    },
  };
}

function collectActiveRuns(raw = []) {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map((row) => {
      const entry = asObject(row);
      const provider = cleanKey(entry.provider);
      if (!provider) return null;
      const model = clean(entry.model);
      const executionChannel = clean(entry.execution_channel || entry.executionChannel);
      const capabilities = entry.interaction_capabilities && typeof entry.interaction_capabilities === 'object'
        ? entry.interaction_capabilities
        : summarizeProviderInteractionCapabilities({ provider, model, executionChannel });
      return {
        agent_id: cleanKey(entry.agent_id || entry.agentId || entry.id),
        provider,
        model,
        execution_channel: executionChannel || undefined,
        interaction_capabilities: capabilities,
      };
    })
    .filter(Boolean);
}

export function chooseBusyRunInterruptionStrategy({ activeRuns = [], pendingApproval = null, pendingUserRequest = null, requestedMode = 'replan' } = {}) {
  const mode = cleanKey(requestedMode) === 'cancel' ? 'cancel' : 'replan';
  const runs = collectActiveRuns(activeRuns);
  if (mode === 'cancel') {
    return {
      strategy: 'cancel_run',
      mode,
      bridge_supported: false,
      reason: 'explicit_cancel',
      active_runs: runs,
    };
  }
  if (pendingApproval) {
    return {
      strategy: 'cancel_replan',
      mode,
      bridge_supported: false,
      reason: 'pending_approval_blocks_steering',
      active_runs: runs,
    };
  }
  const steerable = runs.length > 0
    && runs.every((row) => row?.interaction_capabilities?.integration?.active_turn_steering_bridge === true);
  if (steerable) {
    return {
      strategy: 'steer_in_place',
      mode,
      bridge_supported: true,
      reason: pendingUserRequest ? 'provider_followup_reply' : 'provider_supports_active_turn_steering',
      active_runs: runs,
    };
  }
  return {
    strategy: 'cancel_replan',
    mode,
    bridge_supported: false,
    reason: runs.length === 0
      ? 'no_active_provider_metadata'
      : 'active_turn_steering_bridge_unavailable',
    active_runs: runs,
  };
}
