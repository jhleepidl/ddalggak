import http from 'node:http';
import https from 'node:https';

import { recordLlmTrace } from '../application/llm_trace_recorder.js';
import { getModelNode } from '../application/model_node_registry.js';
import { buildModelNodeUsageEvent, recordModelNodeUsage } from '../application/model_node_usage_log.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function joinUrl(base = '', suffix = '') {
  const root = clean(base).replace(/\/+$/, '');
  const tail = clean(suffix).replace(/^\/+/, '');
  return `${root}/${tail}`;
}


function requestText(url, { method = 'GET', headers = {}, body = '', signal = null, timeoutMs = 0, maxChars = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, { method, headers }, (res) => {
      const chunks = [];
      let total = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= maxChars) chunks.push(chunk);
        else if (chunks.length && !chunks[chunks.length - 1].endsWith('\n…(truncated)…\n')) chunks.push('\n…(truncated)…\n');
      });
      res.on('end', () => { cleanup(); resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, text: chunks.join('') }); });
    });
    let settled = false;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      return true;
    };
    const fail = (error) => {
      if (!cleanup()) return;
      req.destroy();
      reject(error);
    };
    const timer = Number(timeoutMs || 0) > 0 ? setTimeout(() => fail(new Error(`timeout after ${Math.floor(Number(timeoutMs))}ms`)), Math.floor(Number(timeoutMs))) : null;
    const onAbort = signal ? () => fail(signal.reason || new Error('aborted')) : null;
    if (signal) {
      if (signal.aborted) return fail(signal.reason || new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => {
      if (!settled) fail(error);
    });
    req.on('close', () => cleanup());
    if (body) req.write(body);
    req.end();
  });
}


function withTimeoutSignal(timeoutMs = 0, upstreamSignal = null) {
  const controller = new AbortController();
  let settled = false;
  let timer = null;
  let onAbort = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (upstreamSignal && onAbort) upstreamSignal.removeEventListener('abort', onAbort);
  };
  const abort = (reason) => {
    if (settled) return;
    controller.abort(reason);
    finish();
  };
  onAbort = () => abort(upstreamSignal?.reason || new Error('aborted'));
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abort(upstreamSignal.reason || new Error('aborted'));
    else upstreamSignal.addEventListener('abort', onAbort, { once: true });
  }
  const n = Number(timeoutMs || 0);
  if (Number.isFinite(n) && n > 0) timer = setTimeout(() => abort(new Error(`timeout after ${Math.floor(n)}ms`)), Math.floor(n));
  return { signal: controller.signal, finish };
}

function extractTextFromChatCompletion(json = {}) {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const first = choices[0] || {};
  const message = first.message || {};
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
  }
  if (typeof first.text === 'string') return first.text;
  return '';
}

const nodeQueues = new Map();

function nodeConcurrencyKey(node = {}) {
  return clean(node.id || node.model || 'openai_compatible').toLowerCase() || 'openai_compatible';
}

async function withNodeConcurrency(node = {}, fn) {
  const key = nodeConcurrencyKey(node);
  const max = Math.max(1, Math.floor(Number(node.limits?.max_concurrent || process.env.OPENAI_COMPATIBLE_MAX_CONCURRENT || process.env.LOCAL_MODEL_MAX_CONCURRENT || 1) || 1));
  const state = nodeQueues.get(key) || { active: 0, queue: [] };
  nodeQueues.set(key, state);
  if (state.active >= max) {
    const maxWaiters = Math.max(0, Math.floor(Number(process.env.MODEL_NODE_MAX_QUEUE_WAITERS || 16) || 16));
    if (state.queue.length >= maxWaiters) throw new Error(`[openai_compatible] model node queue full: ${key}`);
    await new Promise((resolve) => state.queue.push(resolve));
  }
  state.active += 1;
  try {
    return await fn();
  } finally {
    state.active = Math.max(0, state.active - 1);
    const next = state.queue.shift();
    if (next) next();
    if (state.active === 0 && state.queue.length === 0) nodeQueues.delete(key);
  }
}

function attachTrace({ result, node, prompt, jobId = '', surface = 'openai_compatible_prompt', agentId = '', roleId = '', cwd = '', metadata = {} }) {
  const trace = recordLlmTrace({
    jobId,
    provider: node.provider || 'openai_compatible',
    surface,
    agentId,
    roleId,
    model: node.model,
    prompt,
    result,
    cwd,
    workspaceRoot: cwd,
    metadata: {
      model_node_id: node.id,
      model_node_label: node.label,
      base_url: node.base_url,
      runtime: node.runtime,
      ...asObject(metadata),
    },
  });
  return trace ? { ...result, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : result;
}

function attachUsage({ result, node, prompt, jobId = '', surface = '', agentId = '', roleId = '', cwd = '', metadata = {} }) {
  const contextInfo = asObject(metadata.context_access || metadata.contextInfo || metadata.preparedContextInfo);
  const event = buildModelNodeUsageEvent({
    node,
    provider: node.provider || 'openai_compatible',
    model: node.model,
    jobId,
    agentId,
    roleId,
    surface,
    prompt,
    result,
    contextInfo,
    traceId: result?.llm_trace_id || '',
    extra: { trace_metadata: asObject(metadata) },
  });
  const write = recordModelNodeUsage(event, { cwd, jobId });
  return { ...result, model_node_usage_path: write.path, model_node_usage_recorded: write.ok };
}

function finalizeResult({ result, node, prompt, jobId, surface, agentId, roleId, cwd, metadata }) {
  const traced = attachTrace({ result, node, prompt, jobId, surface, agentId, roleId, cwd, metadata });
  return attachUsage({ result: traced, node, prompt, jobId, surface, agentId, roleId, cwd, metadata });
}

export async function runOpenAICompatiblePrompt({
  nodeId = '',
  model = '',
  baseUrl = '',
  prompt = '',
  system = '',
  signal = null,
  timeoutMs = 0,
  temperature = 0.2,
  maxTokens = 0,
  apiKey = '',
  headers = {},
  jobId = '',
  surface = 'openai_compatible_prompt',
  agentId = '',
  roleId = '',
  cwd = process.cwd(),
  traceMetadata = {},
} = {}) {
  const configuredNode = getModelNode(nodeId || model) || {};
  const effectiveNode = {
    id: clean(configuredNode.id || nodeId || model || 'openai_compatible'),
    label: clean(configuredNode.label || nodeId || model || 'OpenAI-compatible model'),
    provider: clean(configuredNode.provider || 'openai_compatible'),
    runtime: clean(configuredNode.runtime || 'openai_compatible'),
    base_url: clean(baseUrl || configuredNode.base_url || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || process.env.OLLAMA_BASE_URL),
    model: clean(model || configuredNode.model || process.env.OPENAI_COMPATIBLE_MODEL || process.env.LOCAL_MODEL || process.env.OLLAMA_MODEL),
    location: clean(configuredNode.location || ''),
    limits: asObject(configuredNode.limits),
    permissions: asObject(configuredNode.permissions),
  };
  const promptText = clean(prompt);
  if (!promptText) return { ok: false, exitCode: -1, stdout: '', stderr: '[openai_compatible] empty prompt', durationMs: 0 };
  if (!effectiveNode.base_url) return { ok: false, exitCode: -1, stdout: '', stderr: '[openai_compatible] missing base_url for model node', durationMs: 0 };
  if (!effectiveNode.model) return { ok: false, exitCode: -1, stdout: '', stderr: '[openai_compatible] missing model for model node', durationMs: 0 };

  const startedAtMs = Date.now();
  const timeout = Number(timeoutMs || effectiveNode.limits?.timeout_ms || process.env.OPENAI_COMPATIBLE_TIMEOUT_MS || process.env.LOCAL_MODEL_TIMEOUT_MS || 90000) || 90000;
  const { signal: requestSignal, finish } = withTimeoutSignal(timeout, signal);
  try {
    const requestHeaders = {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...asObject(headers),
    };
    const token = clean(apiKey || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.LOCAL_MODEL_API_KEY || process.env.OLLAMA_API_KEY || '');
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    const messages = [];
    const systemText = clean(system);
    if (systemText) messages.push({ role: 'system', content: systemText });
    messages.push({ role: 'user', content: promptText });
    const body = {
      model: effectiveNode.model,
      messages,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
    };
    const maxOut = Number(maxTokens || effectiveNode.limits?.max_output_tokens || 0);
    if (Number.isFinite(maxOut) && maxOut > 0) body.max_tokens = Math.floor(maxOut);
    const response = await withNodeConcurrency(effectiveNode, () => requestText(joinUrl(effectiveNode.base_url, '/chat/completions'), {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: requestSignal,
      timeoutMs: timeout,
      maxChars: Number(process.env.OPENAI_COMPATIBLE_MAX_RESPONSE_CHARS || 2_000_000) || 2_000_000,
    }));
    const raw = response.text;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const stdout = parsed ? extractTextFromChatCompletion(parsed) : raw;
    const result = {
      ok: response.ok,
      exitCode: response.ok ? 0 : response.status,
      stdout: response.ok ? stdout : '',
      stderr: response.ok ? '' : `[openai_compatible] HTTP ${response.status}: ${raw.slice(0, 4000)}`,
      durationMs: Date.now() - startedAtMs,
      status: response.status,
      used_model: effectiveNode.model,
      model_node_id: effectiveNode.id,
      response_json: parsed || undefined,
    };
    return finalizeResult({ result, node: effectiveNode, prompt: promptText, jobId, surface, agentId, roleId, cwd, metadata: traceMetadata });
  } catch (error) {
    const message = signal?.aborted || requestSignal.aborted
      ? `[openai_compatible] aborted or timed out: ${String(error?.message || error)}`
      : `[openai_compatible] request failed: ${String(error?.message || error)}`;
    const result = { ok: false, exitCode: -1, stdout: '', stderr: message, durationMs: Date.now() - startedAtMs, used_model: effectiveNode.model, model_node_id: effectiveNode.id };
    return finalizeResult({ result, node: effectiveNode, prompt: promptText, jobId, surface, agentId, roleId, cwd, metadata: traceMetadata });
  } finally {
    finish();
  }
}

export async function checkOpenAICompatibleHealth(node = {}, { timeoutMs = 5000 } = {}) {
  const baseUrl = clean(node.base_url || node.baseUrl || '');
  if (!baseUrl) return { ok: false, status: 'missing_base_url', error: 'missing base_url' };
  const { signal, finish } = withTimeoutSignal(timeoutMs, null);
  try {
    const response = await requestText(joinUrl(baseUrl, '/models'), { method: 'GET', signal, timeoutMs, maxChars: 1000 });
    const text = response.text;
    return { ok: response.ok, status: response.ok ? 'ok' : 'http_error', http_status: response.status, detail: text.slice(0, 1000) };
  } catch (error) {
    return { ok: false, status: 'unreachable', error: String(error?.message || error) };
  } finally {
    finish();
  }
}
