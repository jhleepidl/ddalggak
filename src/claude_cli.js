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

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseClaudeCliJsonOutput(stdout = '') {
  const raw = String(stdout || '').trim();
  if (!raw) return { parsed: false, result_text: '', is_error: false };
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { payload = JSON.parse(raw.slice(start, end + 1)); } catch { payload = null; }
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { parsed: false, result_text: raw, is_error: false };
  }
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const modelUsage = payload.modelUsage && typeof payload.modelUsage === 'object' ? payload.modelUsage : {};
  const modelFromUsage = Object.keys(modelUsage)[0] || '';
  return {
    parsed: true,
    result_text: String(payload.result ?? payload.text ?? ''),
    is_error: payload.is_error === true || String(payload.subtype || '').startsWith('error'),
    subtype: String(payload.subtype || ''),
    model: String(payload.model || modelFromUsage || ''),
    session_id: String(payload.session_id || ''),
    num_turns: num(payload.num_turns, 0),
    duration_ms: num(payload.duration_ms, 0),
    duration_api_ms: num(payload.duration_api_ms, 0),
    cost_usd: num(payload.total_cost_usd ?? payload.cost_usd, 0),
    usage: {
      input_tokens: num(usage.input_tokens, 0),
      output_tokens: num(usage.output_tokens, 0),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens, 0),
      cache_read_input_tokens: num(usage.cache_read_input_tokens, 0),
    },
  };
}

export function buildClaudeAgentTelemetryRow({ result = {}, agentId = '', roleId = '', modelRole = '', phase = '' } = {}) {
  const row = result && typeof result === 'object' ? result : {};
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  const agent = String(agentId || roleId || '').trim().toLowerCase();
  if (!agent) return null;
  return {
    kind: 'ddalggak.agent_execution_telemetry/v1',
    ts: new Date().toISOString(),
    agent,
    role_id: String(roleId || '').trim().toLowerCase() || undefined,
    model_role: String(modelRole || '').trim().toLowerCase() || undefined,
    provider: 'claude',
    model: String(row.used_model || row.model || 'claude').trim(),
    phase: String(phase || '').trim().toLowerCase() || undefined,
    input_tokens: num(usage.input_tokens, 0) + num(usage.cache_read_input_tokens, 0) + num(usage.cache_creation_input_tokens, 0),
    output_tokens: num(usage.output_tokens, 0),
    latency_ms: num(row.duration_ms, 0),
    cost_usd: num(row.cost_usd, 0),
    num_turns: num(row.num_turns, 0),
    contribution_hint: 'measured_claude_cli_usage',
    telemetry_source: 'claude_cli_json_output',
  };
}

export async function runClaudeCliPrompt({
  workspaceRoot,
  prompt,
  signal,
  cwd,
  jobId = '',
  model = '',
  effort = '',
  surface = 'claude_cli_prompt',
  agentId = '',
  roleId = '',
  timeoutMs = 0,
  traceMetadata = {},
  env = {},
} = {}) {
  const command = String(process.env.CLAUDE_CLI_COMMAND || 'claude').trim() || 'claude';
  const baseArgs = splitArgs(process.env.CLAUDE_CLI_ARGS || '');
  const requestedModel = String(model || process.env.CLAUDE_CLI_MODEL || process.env.CLAUDE_MODEL || '').trim();
  const modelArgs = requestedModel ? ['--model', requestedModel] : [];
  const requestedEffort = String(effort || process.env.CLAUDE_CLI_EFFORT || process.env.CLAUDE_CODE_EFFORT_LEVEL || '').trim().toLowerCase();
  const effortArgs = requestedEffort && requestedEffort !== 'provider_default' ? ['--effort', requestedEffort] : [];
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  const effectiveTimeoutMs = Number(timeoutMs || process.env.CLAUDE_CLI_TIMEOUT_MS || 0) > 0
    ? Number(timeoutMs || process.env.CLAUDE_CLI_TIMEOUT_MS)
    : 300000;
  const result = await withRuntimeActivity({ provider: 'claude', kind: 'provider_execution', jobId, metadata: { surface, model: requestedModel || null, workspace: workspacePath } }, async () => await runCommand(command, [...baseArgs, ...modelArgs, ...effortArgs, '-p', '--output-format', 'json'], {
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
  const parsed = parseClaudeCliJsonOutput(result.stdout || '');
  const ok = Boolean(result.ok) && !parsed.is_error;
  const answer = parsed.parsed ? parsed.result_text : String(result.stdout || '');
  const resolvedModel = parsed.model || requestedModel || '';
  const usedModel = resolvedModel || 'default';
  const enriched = {
    ...result,
    ok,
    stdout: answer,
    raw_stdout: result.stdout,
    requested_model: requestedModel || null,
    resolved_model: resolvedModel || null,
    model_resolution_source: parsed.model ? 'provider_reported' : (requestedModel ? 'explicit_request' : 'unresolved_provider_default'),
    used_model: usedModel,
    usage: parsed.usage || { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    cost_usd: parsed.cost_usd || 0,
    duration_ms: parsed.duration_ms || 0,
    duration_api_ms: parsed.duration_api_ms || 0,
    num_turns: parsed.num_turns || 0,
    session_id: parsed.session_id || '',
    parsed_json_output: parsed.parsed,
  };
  const trace = recordLlmTrace({
    jobId,
    provider: 'claude',
    surface,
    agentId,
    roleId,
    model: usedModel,
    prompt: String(prompt || ''),
    result: enriched,
    cwd: commandCwd,
    workspaceRoot: workspacePath,
    metadata: {
      ...traceMetadata,
      usage: enriched.usage,
      cost_usd: enriched.cost_usd,
      duration_ms: enriched.duration_ms,
      duration_api_ms: enriched.duration_api_ms,
      num_turns: enriched.num_turns,
      session_id: enriched.session_id,
      parsed_json_output: enriched.parsed_json_output,
      reasoning_effort: requestedEffort || null,
    },
  });
  return trace ? { ...enriched, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : enriched;
}
