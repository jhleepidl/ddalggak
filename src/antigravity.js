import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './proc.js';
import { recordLlmTrace } from './application/llm_trace_recorder.js';
import { withRuntimeActivity } from './application/runtime_activity_registry.js';
import { prepareRoomProviderInvocation, rewriteWorkspacePathForSandbox } from './room_runtime/provider_process_boundary.js';

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

export async function runAntigravityPrompt({ workspaceRoot, prompt, signal, cwd, jobId = '', model = '', surface = 'antigravity_prompt', agentId = '', roleId = '', timeoutMs = 0, traceMetadata = {}, env = {}, onOutput = null } = {}) {
  const runtimeEnv = { ...process.env, ...(env && typeof env === 'object' ? env : {}) };
  const command = resolveAntigravityCliCommand(runtimeEnv);
  const baseArgs = splitArgs(runtimeEnv.ANTIGRAVITY_CLI_ARGS || runtimeEnv.GOOGLE_AI_CLI_ARGS || '');
  const modelArgName = String(runtimeEnv.ANTIGRAVITY_MODEL_ARG || '').trim();
  const requestedModel = String(model || runtimeEnv.ANTIGRAVITY_MODEL || runtimeEnv.GOOGLE_AI_MODEL || '').trim();
  const modelArgs = requestedModel && modelArgName ? [modelArgName, requestedModel] : [];
  const roomScoped = Boolean(String(traceMetadata?.room_id || '').trim() || String(traceMetadata?.room_run_id || '').trim());
  if (roomScoped && !String(workspaceRoot || '').trim()) {
    throw Object.assign(new Error('Room-scoped Antigravity execution requires an explicit workspaceRoot'), { code: 'ROOM_WORKSPACE_REQUIRED' });
  }
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  if (roomScoped) {
    if (commandCwd !== workspacePath) throw Object.assign(new Error(`Room-scoped Antigravity cwd must equal workspaceRoot: cwd=${commandCwd} workspace=${workspacePath}`), { code: 'ROOM_WORKSPACE_BOUNDARY' });
    const stat = fs.lstatSync(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error(`Invalid Room workspace: ${workspacePath}`), { code: 'ROOM_WORKSPACE_BOUNDARY' });
  }
  const providerArgs = [...baseArgs, ...modelArgs];
  const invocation = prepareRoomProviderInvocation({ provider: 'antigravity', command, args: providerArgs, workspacePath, roomScoped, env: runtimeEnv });
  if (!invocation.ok) throw Object.assign(new Error(invocation.error), { code: 'ROOM_WORKSPACE_BOUNDARY' });
  const executionPrompt = rewriteWorkspacePathForSandbox(String(prompt || ''), workspacePath, invocation.visibleWorkspacePath);
  const effectiveTimeoutMs = Number(timeoutMs || runtimeEnv.ANTIGRAVITY_TIMEOUT_MS || runtimeEnv.GOOGLE_AI_TIMEOUT_MS || 0) > 0
    ? Number(timeoutMs || runtimeEnv.ANTIGRAVITY_TIMEOUT_MS || runtimeEnv.GOOGLE_AI_TIMEOUT_MS)
    : 240000;
  const result = await withRuntimeActivity({ provider: 'antigravity', kind: 'provider_execution', jobId, metadata: { surface, model: requestedModel || null, workspace: workspacePath } }, async () => await runCommand(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    timeoutMs: effectiveTimeoutMs,
    input: executionPrompt,
    abortSignal: signal,
    onOutput: typeof onOutput === 'function' ? (event) => onOutput({ ...event, provider: 'antigravity', provider_attempt: 'primary' }) : null,
    env: invocation.childEnv,
    inheritEnv: invocation.inheritEnv,
  }));
  return attachAntigravityTrace({
    result,
    jobId,
    surface,
    agentId,
    roleId,
    model: requestedModel || 'auto',
    prompt: executionPrompt,
    cwd: commandCwd,
    workspaceRoot: workspacePath,
    metadata: { command, args: providerArgs, timeout_ms: effectiveTimeoutMs, room_provider_os_sandbox: invocation.osSandbox, provider_visible_workspace: invocation.visibleWorkspacePath, provider_env_inheritance: invocation.inheritEnv ? 'full' : 'allowlist', ...traceMetadata },
  });
}
