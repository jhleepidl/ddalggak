import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function clean(value = '') {
  return String(value ?? '').trim();
}

function boolEnv(name, fallback = false) {
  const raw = clean(process.env[name]).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const num = Number(process.env[name]);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function safeSegment(value = '') {
  const raw = clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return raw || 'item';
}

function clipText(value = '', maxChars = 0) {
  const raw = String(value ?? '');
  const max = Number(maxChars || 0);
  if (!(max > 0)) return raw;
  if (raw.length <= max) return raw;
  const marker = '\n…(truncated; latest context preserved below)…\n';
  const available = Math.max(20, max - marker.length);
  const head = Math.max(10, Math.floor(available * 0.35));
  const tail = Math.max(10, available - head);
  return `${raw.slice(0, head)}${marker}${raw.slice(-tail)}`;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureDir(dirPath = '') {
  if (!clean(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text = '') {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text ?? ''), 'utf8');
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function redactPatterns(text = '') {
  let out = String(text ?? '');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]');
  out = out.replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)(['\"]?)[^\s'\"]+/gi, '$1$2[REDACTED]');
  out = out.replace(/(sk-[A-Za-z0-9]{16,})/g, '[REDACTED_OPENAI_KEY]');
  out = out.replace(/(AIza[0-9A-Za-z\-_]{20,})/g, '[REDACTED_GOOGLE_KEY]');
  return out;
}

let cachedEnvSecrets = null;
function envSecrets() {
  if (cachedEnvSecrets) return cachedEnvSecrets;
  const secrets = [];
  for (const [key, value] of Object.entries(process.env)) {
    const val = String(value || '');
    if (val.length < 8) continue;
    if (!/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|COOKIE|SESSION|CREDENTIAL)/i.test(key)) continue;
    secrets.push(val);
  }
  cachedEnvSecrets = Array.from(new Set(secrets)).sort((a, b) => b.length - a.length).slice(0, 200);
  return cachedEnvSecrets;
}

export function redactLlmTraceText(value = '') {
  let out = String(value ?? '');
  if (!boolEnv('LLM_TRACE_REDACT_SECRETS', true)) return out;
  for (const secret of envSecrets()) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED_ENV_SECRET]');
  }
  return redactPatterns(out);
}

export function llmTraceEnabled() {
  return boolEnv('LLM_TRACE_ENABLED', false);
}

export function resolveLlmTraceDir({ jobId = '', traceDir = '' } = {}) {
  const explicit = clean(traceDir) || clean(process.env.SELF_IMPROVE_LLM_TRACE_DIR) || clean(process.env.LLM_TRACE_DIR);
  if (explicit) return path.resolve(explicit);

  const cleanJob = safeSegment(jobId);
  if (clean(jobId)) {
    const base = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.resolve('runs');
    return path.join(base, cleanJob, 'llm_traces');
  }

  if (boolEnv('LLM_TRACE_UNSCOPED', false)) {
    const base = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.resolve('runs');
    return path.join(base, '_unscoped', 'llm_traces');
  }

  return '';
}

export function readLlmTraceIndex({ jobId = '', traceDir = '', limit = 20 } = {}) {
  const dir = resolveLlmTraceDir({ jobId, traceDir });
  if (!dir) return [];
  const indexPath = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  const rows = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const n = Number(limit || 0);
  return n > 0 ? rows.slice(Math.max(0, rows.length - n)) : rows;
}

export function recordLlmTrace({
  jobId = '',
  traceDir = '',
  provider = '',
  surface = '',
  agentId = '',
  roleId = '',
  model = '',
  prompt = '',
  result = {},
  cwd = '',
  workspaceRoot = '',
  metadata = {},
} = {}) {
  if (!llmTraceEnabled()) return null;
  const dir = resolveLlmTraceDir({ jobId, traceDir });
  if (!dir) return null;

  const savePrompts = boolEnv('LLM_TRACE_SAVE_PROMPTS', true);
  const saveOutputs = boolEnv('LLM_TRACE_SAVE_OUTPUTS', true);
  const saveStderr = boolEnv('LLM_TRACE_SAVE_STDERR', true);
  const maxPromptChars = intEnv('LLM_TRACE_MAX_PROMPT_CHARS', 300000, { min: 1000, max: 5000000 });
  const maxOutputChars = intEnv('LLM_TRACE_MAX_OUTPUT_CHARS', 300000, { min: 1000, max: 5000000 });
  const maxStderrChars = intEnv('LLM_TRACE_MAX_STDERR_CHARS', 150000, { min: 1000, max: 5000000 });

  const ts = new Date().toISOString();
  const traceId = `${Date.now()}_${safeSegment(provider || 'llm')}_${crypto.randomBytes(4).toString('hex')}`;
  const traceRoot = path.join(dir, traceId);
  ensureDir(traceRoot);

  const promptText = String(prompt ?? '');
  const stdoutText = String(result?.stdout ?? result?.text ?? '');
  const stderrText = String(result?.stderr ?? '');
  const redactedPrompt = clipText(redactLlmTraceText(promptText), maxPromptChars);
  const redactedStdout = clipText(redactLlmTraceText(stdoutText), maxOutputChars);
  const redactedStderr = clipText(redactLlmTraceText(stderrText), maxStderrChars);

  const promptPath = path.join(traceRoot, 'prompt.txt');
  const stdoutPath = path.join(traceRoot, 'stdout.txt');
  const stderrPath = path.join(traceRoot, 'stderr.txt');
  if (savePrompts) writeText(promptPath, redactedPrompt);
  if (saveOutputs) writeText(stdoutPath, redactedStdout);
  if (saveStderr) writeText(stderrPath, redactedStderr);

  const request = {
    trace_id: traceId,
    ts,
    job_id: clean(jobId) || null,
    provider: clean(provider) || 'unknown',
    surface: clean(surface) || null,
    agent_id: clean(agentId) || null,
    role_id: clean(roleId) || null,
    model: clean(model) || null,
    cwd: clean(cwd) || null,
    workspace_root: clean(workspaceRoot) || null,
    prompt_saved: savePrompts,
    prompt_path: savePrompts ? promptPath : null,
    prompt_chars: promptText.length,
    prompt_stored_chars: savePrompts ? redactedPrompt.length : 0,
    metadata: asObject(metadata),
  };
  const response = {
    trace_id: traceId,
    ts,
    ok: result?.ok === true,
    exit_code: Number.isInteger(result?.exitCode) ? result.exitCode : (Number.isInteger(result?.exit_code) ? result.exit_code : null),
    signal: clean(result?.signal) || null,
    duration_ms: Number.isFinite(Number(result?.durationMs ?? result?.duration_ms)) ? Number(result?.durationMs ?? result?.duration_ms) : null,
    used_model: clean(result?.used_model || result?.model || model) || null,
    retry_count: Number.isFinite(Number(result?.retry_count)) ? Number(result.retry_count) : null,
    error_type: clean(result?.error_type) || null,
    stdout_saved: saveOutputs,
    stdout_path: saveOutputs ? stdoutPath : null,
    stdout_chars: stdoutText.length,
    stdout_stored_chars: saveOutputs ? redactedStdout.length : 0,
    stderr_saved: saveStderr,
    stderr_path: saveStderr ? stderrPath : null,
    stderr_chars: stderrText.length,
    stderr_stored_chars: saveStderr ? redactedStderr.length : 0,
  };
  writeJson(path.join(traceRoot, 'request.json'), request);
  writeJson(path.join(traceRoot, 'response.json'), response);

  const indexEntry = {
    trace_id: traceId,
    ts,
    job_id: clean(jobId) || null,
    provider: clean(provider) || 'unknown',
    model: response.used_model || request.model,
    surface: request.surface,
    agent_id: request.agent_id,
    role_id: request.role_id,
    ok: response.ok,
    exit_code: response.exit_code,
    duration_ms: response.duration_ms,
    prompt_chars: request.prompt_chars,
    stdout_chars: response.stdout_chars,
    stderr_chars: response.stderr_chars,
    prompt_path: savePrompts ? path.relative(dir, promptPath) : null,
    stdout_path: saveOutputs ? path.relative(dir, stdoutPath) : null,
    stderr_path: saveStderr ? path.relative(dir, stderrPath) : null,
    request_path: path.relative(dir, path.join(traceRoot, 'request.json')),
    response_path: path.relative(dir, path.join(traceRoot, 'response.json')),
  };
  appendJsonl(path.join(dir, 'index.jsonl'), indexEntry);
  return { trace_id: traceId, trace_dir: dir, trace_root: traceRoot, index_entry: indexEntry };
}

export function summarizeLlmTraceIndex({ jobId = '', traceDir = '', limit = 12 } = {}) {
  const entries = readLlmTraceIndex({ jobId, traceDir, limit: 0 });
  const recent = entries.slice(Math.max(0, entries.length - Number(limit || 12)));
  const byProvider = {};
  let ok = 0;
  let failed = 0;
  for (const entry of entries) {
    const provider = clean(entry.provider) || 'unknown';
    byProvider[provider] = Number(byProvider[provider] || 0) + 1;
    if (entry.ok === true) ok += 1;
    else failed += 1;
  }
  return {
    trace_dir: resolveLlmTraceDir({ jobId, traceDir }) || null,
    total_traces: entries.length,
    ok_traces: ok,
    failed_traces: failed,
    by_provider: byProvider,
    recent,
  };
}
