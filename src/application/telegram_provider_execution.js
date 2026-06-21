import { notifyAndConsumeGocFallback } from './telegram_status_notifications.js';
import { runOpenAICompatiblePrompt } from '../providers/openai_compatible.js';
import { resolveChatGptCodexProviderOptions, resolveChatGptProviderBridge } from './chatgpt_provider_bridge.js';
import { getModelNode } from './model_node_registry.js';
import { formatProviderFailoverNote, resolveProviderFailoverDecision } from './provider_failover_policy.js';
import { isTaskLoopRuntimeExecutionPolicy } from './execution_requirements.js';
import { migrateProviderAwayFromGemini, sanitizeGeminiModelForProvider } from '../provider_migration.js';

export async function runAgentProviderExecution({
  provider = '',
  agentId = '',
  agent = null,
  model = '',
  bot,
  chatId,
  jobId = '',
  notify = true,
  signal = null,
  roleId = '',
  act = null,
  providerOptions = {},
  runtimeExecutionPolicy = {},
  geminiConcurrencyKey = '',
  onGeminiRetry = null,
  onGeminiModelSwitch = null,
  onGeminiGiveUp = null,
  prompts = {},
  callbacks = {},
} = {}) {
  const providerMigration = migrateProviderAwayFromGemini(provider || 'codex', { fallback: 'codex' });
  const cleanProvider = providerMigration.provider;
  const cleanModel = sanitizeGeminiModelForProvider(model || '', cleanProvider);
  const {
    codexImplement,
    geminiResearch,
    sendChatGPTPrompt,
    codexAssist,
    appendLocalLogs,
    memoryModeWithFallback,
    takeGocFallbackReason,
  } = callbacks;

  const finalize = async (output, overrides = {}) => {
    await notifyAndConsumeGocFallback(bot, chatId, {
      notify,
      takeFallbackReason: takeGocFallbackReason,
      summarizeFallbackReason: callbacks.summarizeUserSafeGocFallbackReason,
    });
    return {
      output,
      mode: typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default',
      agent,
      provider: String(overrides.provider || cleanProvider || '').trim().toLowerCase(),
      model: String(overrides.model || cleanModel || '').trim(),
      failover: overrides.failover || undefined,
    };
  };

  if (cleanProvider === 'codex') {
    if (providerMigration.migrated_from_gemini && typeof codexAssist === 'function') {
      const migrationDecision = { from_provider: 'gemini', to_provider: 'codex', reason: 'gemini_cli_disabled', type: 'provider_failover' };
      const migrationNote = '[provider_failover] gemini CLI disabled; executing migrated role through codex assist.';
      if (typeof appendLocalLogs === 'function') appendLocalLogs(migrationNote, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
      if (notify && bot && chatId) {
        try { await bot.sendMessage(chatId, `🔁 Gemini CLI가 비활성화되어 Codex로 실행합니다. (${agentId || 'agent'})`); } catch {}
      }
      const output = await codexAssist(jobId, String(prompts.chatQuestion || prompts.goal || prompts.instruction || ''), signal, {
        runtimeExecutionPolicy,
        providerOptions: {
          ...providerOptions,
          sandboxMode: providerOptions.sandboxMode || providerOptions.sandbox_mode || process.env.CODEX_ASSIST_SANDBOX_MODE || 'read-only',
          approvalPolicy: providerOptions.approvalPolicy || providerOptions.approval_policy || process.env.CODEX_ASSIST_APPROVAL_POLICY || 'never',
          profile: providerOptions.profile || process.env.CODEX_ASSIST_PROFILE || process.env.CODEX_PROFILE || '',
        },
        chatId,
        agentId,
        roleId,
        roleMemo: String(prompts.roleMemo || prompts.role_memo || '').trim(),
        userRequest: String(prompts.userRequest || prompts.user_request || act?.inputs?.user_request || act?.inputs?.userRequest || '').trim(),
        chatRuntimeRules: String(prompts.chatRuntimeRules || prompts.chat_runtime_rules || act?.inputs?._runtime_rules_text || act?.inputs?.runtime_rules_text || '').trim(),
        outputGuide: String(prompts.outputGuide || prompts.output_guide || act?.inputs?.output_guide || act?.inputs?.outputGuide || '').trim(),
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
        failoverDecision: migrationDecision,
      });
      return finalize(output, { provider: 'codex', model: providerOptions.profile || process.env.CODEX_PROFILE || 'codex', failover: migrationDecision });
    }
    if (typeof codexImplement !== 'function') throw new Error('codex provider is selected but codexImplement callback is unavailable');
    const output = await codexImplement(jobId, String(prompts.instruction || ''), signal, {
      runtimeExecutionPolicy,
      providerOptions,
      chatId,
      agentId,
      roleId,
      preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
        ? act.inputs._prompt_context_info
        : {},
      finalSynthesis: act?.inputs?.final_synthesis === true,
    });
    return finalize(output);
  }

  if (cleanProvider === 'antigravity') {
    const { runAntigravityPrompt } = await import('../antigravity.js');
    const promptText = String(prompts.instruction || prompts.goal || prompts.chatQuestion || '');
    const result = await runAntigravityPrompt({
      workspaceRoot: providerOptions.workspaceRoot || providerOptions.workspace_root || process.cwd(),
      cwd: providerOptions.cwd || process.cwd(),
      prompt: promptText,
      signal,
      jobId,
      model: cleanModel || process.env.ANTIGRAVITY_MODEL || process.env.GOOGLE_AI_MODEL || '',
      surface: 'agent_provider_execution',
      agentId,
      roleId,
      timeoutMs: Number(providerOptions.timeoutMs || providerOptions.timeout_ms || process.env.ANTIGRAVITY_TIMEOUT_MS || 0),
      traceMetadata: { provider: cleanProvider, migrated_from_provider: providerMigration.migrated_from_gemini ? 'gemini' : undefined },
    });
    if (!result.ok) throw new Error(result.stderr || `Antigravity provider failed for agent ${agentId}`);
    const output = result.stdout || '';
    if (typeof appendLocalLogs === 'function') appendLocalLogs(output, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
    return finalize(output, { provider: 'antigravity', model: result.used_model || cleanModel || 'auto' });
  }

  if (cleanProvider === 'gemini') {
    try {
      const geminiResult = await geminiResearch(jobId, String(prompts.goal || ''), signal, {
        sectionTitle: `${agentId} notes`,
        agentId,
        roleId,
        roleMemo: String(prompts.roleMemo || prompts.role_memo || '').trim(),
        userRequest: String(prompts.userRequest || prompts.user_request || act?.inputs?.user_request || act?.inputs?.userRequest || '').trim(),
        chatRuntimeRules: String(prompts.chatRuntimeRules || prompts.chat_runtime_rules || act?.inputs?._runtime_rules_text || act?.inputs?.runtime_rules_text || '').trim(),
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs?._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
        outputGuide: String(prompts.outputGuide || prompts.output_guide || act?.inputs?.output_guide || act?.inputs?.outputGuide || '').trim(),
        model: cleanModel,
        concurrencyKey: geminiConcurrencyKey || `job:${String(jobId || '').trim()}`,
        onGeminiRetry,
        onGeminiModelSwitch,
        onGeminiGiveUp,
        runtimeExecutionPolicy,
        providerOptions,
        chatId,
      });
      const output = geminiResult && typeof geminiResult === 'object'
        ? String(geminiResult.output || '')
        : String(geminiResult || '');
      return finalize(output, {
        provider: geminiResult && typeof geminiResult === 'object' ? geminiResult.provider : 'gemini',
        model: geminiResult && typeof geminiResult === 'object' ? geminiResult.model : model,
      });
    } catch (error) {
      const decision = resolveProviderFailoverDecision({ provider: 'gemini', error, roleId, agentId });
      if (!decision.should_failover || typeof callbacks.codexAssist !== 'function') throw error;
      const note = formatProviderFailoverNote(decision);
      if (typeof appendLocalLogs === 'function') {
        appendLocalLogs(note, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
      }
      if (notify && bot && chatId) {
        try { await bot.sendMessage(chatId, `🔁 Gemini 혼잡으로 ${decision.to_provider} fallback을 사용합니다. (${agentId || 'agent'})`); } catch {}
      }
      const output = await callbacks.codexAssist(jobId, String(prompts.instruction || prompts.goal || prompts.chatQuestion || ''), signal, {
        runtimeExecutionPolicy,
        providerOptions: {
          sandboxMode: process.env.CODEX_ASSIST_SANDBOX_MODE || 'read-only',
          approvalPolicy: process.env.CODEX_ASSIST_APPROVAL_POLICY || 'never',
          profile: process.env.CODEX_ASSIST_PROFILE || process.env.CODEX_PROFILE || '',
        },
        chatId,
        agentId,
        roleId,
        roleMemo: String(prompts.roleMemo || prompts.role_memo || '').trim(),
        userRequest: String(prompts.userRequest || prompts.user_request || act?.inputs?.user_request || act?.inputs?.userRequest || '').trim(),
        chatRuntimeRules: String(prompts.chatRuntimeRules || prompts.chat_runtime_rules || act?.inputs?._runtime_rules_text || act?.inputs?.runtime_rules_text || '').trim(),
        outputGuide: String(prompts.outputGuide || prompts.output_guide || act?.inputs?.output_guide || act?.inputs?.outputGuide || '').trim(),
        failoverDecision: decision,
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
      });
      return finalize(output, {
        provider: 'codex',
        model: providerOptions?.profile || process.env.CODEX_PROFILE || 'codex',
        failover: decision,
      });
    }
  }


  if (cleanProvider === 'openai_compatible' || cleanProvider === 'ollama' || cleanProvider === 'local' || cleanProvider === 'local_model') {
    const node = getModelNode(model) || getModelNode(providerOptions.modelNodeId || providerOptions.model_node_id || '');
    const outputPrompt = String(prompts.instruction || prompts.goal || prompts.chatQuestion || '');
    const result = await runOpenAICompatiblePrompt({
      nodeId: node?.id || providerOptions.modelNodeId || providerOptions.model_node_id || '',
      model: node?.model || model,
      baseUrl: node?.base_url || providerOptions.baseUrl || providerOptions.base_url || '',
      runtime: node?.runtime || providerOptions.runtime || '',
      prompt: outputPrompt,
      system: String(prompts.roleMemo || prompts.role_memo || ''),
      signal,
      timeoutMs: Number(providerOptions.timeoutMs || providerOptions.timeout_ms || node?.limits?.timeout_ms || 0),
      temperature: providerOptions.temperature,
      maxTokens: providerOptions.maxTokens || providerOptions.max_tokens,
      apiKey: providerOptions.apiKey || providerOptions.api_key,
      headers: providerOptions.headers,
      jobId,
      surface: 'model_node_prompt',
      agentId,
      roleId,
      cwd: providerOptions.cwd || process.cwd(),
      traceMetadata: {
        provider: cleanProvider,
        model_node_id: node?.id || null,
        context_access: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
      },
    });
    if (!result.ok) {
      throw new Error(result.stderr || `OpenAI-compatible provider failed for agent ${agentId}`);
    }
    const output = result.stdout || '';
    if (typeof appendLocalLogs === 'function') appendLocalLogs(output, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
    return finalize(output);
  }

  if (cleanProvider === 'chatgpt') {
    const bridge = resolveChatGptProviderBridge();
    const promptText = String(prompts.chatQuestion || prompts.instruction || prompts.goal || '').trim();
    if (bridge.mode === 'codex') {
      if (typeof codexAssist !== 'function') {
        throw new Error('chatgpt provider is configured for Codex bridge, but codexAssist callback is unavailable');
      }
      if (notify && bot && chatId) {
        try { await bot.sendMessage(chatId, `🧠 ChatGPT 역할을 Codex CLI bridge로 실행합니다. (${agentId || 'agent'})`); } catch {}
      }
      const bridgeOptions = resolveChatGptCodexProviderOptions(providerOptions);
      const output = await codexAssist(jobId, promptText, signal, {
        runtimeExecutionPolicy,
        providerOptions: bridgeOptions,
        chatId,
        agentId,
        roleId: roleId || 'reviewer',
        roleMemo: String(prompts.roleMemo || prompts.role_memo || '').trim(),
        userRequest: String(prompts.userRequest || prompts.user_request || act?.inputs?.user_request || act?.inputs?.userRequest || '').trim(),
        chatRuntimeRules: String(prompts.chatRuntimeRules || prompts.chat_runtime_rules || act?.inputs?._runtime_rules_text || act?.inputs?.runtime_rules_text || '').trim(),
        outputGuide: String(prompts.outputGuide || prompts.output_guide || act?.inputs?.output_guide || act?.inputs?.outputGuide || '').trim(),
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
      });
      if (typeof appendLocalLogs === 'function') appendLocalLogs(output, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
      return finalize(output, {
        provider: 'codex',
        model: bridgeOptions.profile || process.env.CODEX_PROFILE || 'codex',
        failover: { from_provider: 'chatgpt', to_provider: 'codex', reason: bridge.reason },
      });
    }
    if (bridge.mode === 'manual') {
      if (isTaskLoopRuntimeExecutionPolicy(runtimeExecutionPolicy)) {
        throw new Error('legacy ChatGPT manual fallback is disabled for task-loop execution; configure CHATGPT_PROVIDER_BRIDGE=codex or use an executable model node');
      }
      await sendChatGPTPrompt(bot, chatId, jobId, promptText);
      const output = `ChatGPT manual prompt generated by agent=${agentId}
question=${promptText}`;
      if (typeof appendLocalLogs === 'function') appendLocalLogs(output, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
      return finalize(output);
    }
    throw new Error('chatgpt provider has no executable bridge. Set CHATGPT_PROVIDER_BRIDGE=codex, or explicitly enable the legacy manual fallback with CHATGPT_MANUAL_FALLBACK_ENABLED=true.');
  }

  throw new Error(`Unsupported provider for agent ${agentId}: ${cleanProvider}`);
}
