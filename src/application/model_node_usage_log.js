import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function usageLogPath({ cwd = process.cwd(), jobId = '' } = {}) {
  const explicit = clean(process.env.MODEL_NODE_USAGE_LOG || process.env.DDALGGAK_MODEL_NODE_USAGE_LOG);
  if (explicit) return path.resolve(explicit);
  const root = path.resolve(cwd || process.cwd(), 'runs');
  if (jobId) return path.join(root, String(jobId), 'model_node_usage.jsonl');
  return path.join(root, 'model_node_usage.jsonl');
}

function extractTokenUsage(result = {}) {
  const usage = asObject(result?.usage || result?.response_json?.usage || result?.responseJson?.usage);
  const json = asObject(result?.response_json || result?.responseJson);
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? json.prompt_eval_count ?? json.promptEvalCount);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? json.eval_count ?? json.evalCount);
  const total = Number(usage.total_tokens);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : undefined,
    completion_tokens: Number.isFinite(completion) ? completion : undefined,
    total_tokens: Number.isFinite(total) ? total : (Number.isFinite(prompt) || Number.isFinite(completion) ? (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0) : undefined),
    source: usage && Object.keys(usage).length ? 'usage' : (Number.isFinite(prompt) || Number.isFinite(completion) ? 'ollama_eval_counts' : 'unavailable'),
  };
}

function summarizePermissions(permissions = {}) {
  const p = asObject(permissions);
  return {
    memory_read: clean(p.memory_read || p.memoryRead || 'scoped_context_only'),
    memory_write: clean(p.memory_write || p.memoryWrite || 'write_intent_only'),
    workspace_read: p.workspace_read === true || p.workspaceRead === true,
    workspace_write: p.workspace_write === true || p.workspaceWrite === true,
  };
}

export function buildModelNodeUsageEvent({
  node = {},
  provider = '',
  model = '',
  jobId = '',
  agentId = '',
  roleId = '',
  surface = 'model_node_prompt',
  prompt = '',
  result = {},
  contextInfo = {},
  traceId = '',
  extra = {},
} = {}) {
  const promptText = String(prompt || '');
  const context = asObject(contextInfo);
  const outputText = String(result?.stdout || '');
  return {
    event_type: 'model_node_call',
    schema_version: 1,
    timestamp: new Date().toISOString(),
    job_id: clean(jobId),
    agent_id: clean(agentId),
    role_id: clean(roleId),
    surface: clean(surface) || 'model_node_prompt',
    provider: clean(provider || node.provider || 'openai_compatible'),
    model: clean(model || node.model || result?.used_model || ''),
    model_node: {
      id: clean(node.id || result?.model_node_id || ''),
      label: clean(node.label || ''),
      runtime: clean(node.runtime || ''),
      location: clean(node.location || ''),
      permissions: summarizePermissions(node.permissions),
    },
    context_access: {
      projection_id: clean(context.projection_id || context.projectionId || context.context_projection_id || ''),
      snapshot_id: clean(context.snapshot_id || context.snapshotId || ''),
      read_set_count: Array.isArray(context.read_set || context.readSet) ? (context.read_set || context.readSet).length : undefined,
      protected_set_count: Array.isArray(context.protected_set || context.protectedSet) ? (context.protected_set || context.protectedSet).length : undefined,
      memory_mode: clean(context.memory_mode || context.memoryMode || ''),
      note: clean(context.note || ''),
    },
    prompt_chars: promptText.length,
    output_chars: outputText.length,
    token_usage: extractTokenUsage(result),
    ok: result?.ok === true,
    exit_code: Number.isFinite(Number(result?.exitCode)) ? Number(result.exitCode) : undefined,
    status: result?.status || undefined,
    duration_ms: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : undefined,
    trace_id: clean(traceId || result?.llm_trace_id || ''),
    ...asObject(extra),
  };
}

export function recordModelNodeUsage(event = {}, { cwd = process.cwd(), jobId = '' } = {}) {
  const pathName = usageLogPath({ cwd, jobId: jobId || event.job_id });
  try {
    fs.mkdirSync(path.dirname(pathName), { recursive: true });
    fs.appendFileSync(pathName, `${JSON.stringify(event)}\n`, 'utf8');
    return { ok: true, path: pathName };
  } catch (error) {
    return { ok: false, path: pathName, error: String(error?.message || error) };
  }
}

export function readRecentModelNodeUsage({ cwd = process.cwd(), jobId = '', limit = 20 } = {}) {
  const pathName = usageLogPath({ cwd, jobId });
  if (!fs.existsSync(pathName)) return [];
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
  const rows = fs.readFileSync(pathName, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  return rows.map((line) => {
    try { return JSON.parse(line); } catch { return { event_type: 'parse_error', raw: line }; }
  });
}
