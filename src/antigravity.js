import path from 'node:path';
import { runCommand } from './proc.js';
import { recordLlmTrace } from './application/llm_trace_recorder.js';
import { withRuntimeActivity } from './application/runtime_activity_registry.js';

function splitArgs(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  const out = [];
  let cur = '';
  let quote = '';
  let esc = false;
  for (const ch of text) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function attachAntigravityTrace({ result, jobId, surface, agentId, roleId, model, prompt, cwd, workspaceRoot, metadata }) {
  const trace = recordLlmTrace({
    jobId,
    provider: 'antigravity',
    surface,
    agentId,
    roleId,
    model,
    prompt,
    result,
    cwd,
    workspaceRoot,
    metadata,
  });
  const requestedModel = String(model || '').trim();
  const resolvedModel = requestedModel && requestedModel !== 'auto' ? requestedModel : '';
  const withModel = {
    ...(result && typeof result === 'object' ? result : {}),
    requested_model: requestedModel && requestedModel !== 'auto' ? requestedModel : null,
    resolved_model: resolvedModel || null,
    model_resolution_source: resolvedModel ? 'explicit_request' : 'unresolved_provider_default',
    used_model: resolvedModel || 'default',
  };
  return trace ? { ...withModel, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : withModel;
}

export function resolveAntigravityCliCommand(env = process.env) {
  return String(env?.ANTIGRAVITY_CLI_COMMAND || env?.GOOGLE_AI_CLI_COMMAND || 'agy').trim() || 'agy';
}

export async function runAntigravityPrompt({ workspaceRoot, prompt, signal, cwd, jobId = '', model = '', surface = 'antigravity_prompt', agentId = '', roleId = '', timeoutMs = 0, traceMetadata = {}, env = {} } = {}) {
  const command = resolveAntigravityCliCommand(process.env);
  const baseArgs = splitArgs(process.env.ANTIGRAVITY_CLI_ARGS || process.env.GOOGLE_AI_CLI_ARGS || '');
  const modelArgName = String(process.env.ANTIGRAVITY_MODEL_ARG || '').trim();
  const requestedModel = String(model || process.env.ANTIGRAVITY_MODEL || process.env.GOOGLE_AI_MODEL || '').trim();
  const modelArgs = requestedModel && modelArgName ? [modelArgName, requestedModel] : [];
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  const effectiveTimeoutMs = Number(timeoutMs || process.env.ANTIGRAVITY_TIMEOUT_MS || process.env.GOOGLE_AI_TIMEOUT_MS || 0) > 0
    ? Number(timeoutMs || process.env.ANTIGRAVITY_TIMEOUT_MS || process.env.GOOGLE_AI_TIMEOUT_MS)
    : 240000;
  const result = await withRuntimeActivity({ provider: 'antigravity', kind: 'provider_execution', jobId, metadata: { surface, model: requestedModel || null, workspace: workspacePath } }, async () => await runCommand(command, [...baseArgs, ...modelArgs], {
    cwd: commandCwd,
    timeoutMs: effectiveTimeoutMs,
    input: String(prompt || ''),
    abortSignal: signal,
    env: {
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...env,
    },
  }));
  return attachAntigravityTrace({
    result,
    jobId,
    surface,
    agentId,
    roleId,
    model: requestedModel || 'auto',
    prompt: String(prompt || ''),
    cwd: commandCwd,
    workspaceRoot: workspacePath,
    metadata: { command, args: [...baseArgs, ...modelArgs], timeout_ms: effectiveTimeoutMs, ...traceMetadata },
  });
}
