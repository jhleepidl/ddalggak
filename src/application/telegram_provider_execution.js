import { notifyAndConsumeGocFallback } from './telegram_status_notifications.js';
import { runOpenAICompatiblePrompt } from '../providers/openai_compatible.js';
import { getModelNode } from './model_node_registry.js';
import { formatProviderFailoverNote, resolveProviderFailoverDecision } from './provider_failover_policy.js';

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
  const cleanProvider = String(provider || '').trim().toLowerCase();
  const {
    codexImplement,
    geminiResearch,
    sendChatGPTPrompt,
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
      model: String(overrides.model || model || '').trim(),
      failover: overrides.failover || undefined,
    };
  };

  if (cleanProvider === 'codex') {
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

  if (cleanProvider === 'gemini') {
    try {
      const geminiResult = await geminiResearch(jobId, String(prompts.goal || ''), signal, {
        sectionTitle: `${agentId} notes`,
        agentId,
        roleId,
        roleMemo: String(prompts.roleMemo || prompts.role_memo || '').trim(),
        userRequest: String(prompts.userRequest || prompts.user_request || act?.inputs?.user_request || act?.inputs?.userRequest || '').trim(),
        preparedContextInfo: act?.inputs?._prompt_context_info && typeof act.inputs?._prompt_context_info === 'object'
          ? act.inputs._prompt_context_info
          : {},
        outputGuide: String(prompts.outputGuide || prompts.output_guide || act?.inputs?.output_guide || act?.inputs?.outputGuide || '').trim(),
        model,
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
    await sendChatGPTPrompt(bot, chatId, jobId, String(prompts.chatQuestion || ''));
    const output = `ChatGPT prompt generated by agent=${agentId}\nquestion=${String(prompts.chatQuestion || '')}`;
    if (typeof appendLocalLogs === 'function') appendLocalLogs(output, typeof memoryModeWithFallback === 'function' ? memoryModeWithFallback() : 'default');
    return finalize(output);
  }

  throw new Error(`Unsupported provider for agent ${agentId}: ${cleanProvider}`);
}
