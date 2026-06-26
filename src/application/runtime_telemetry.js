import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', { maxLen = 500, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}

function nowIso() {
  return new Date().toISOString();
}

function boolEnv(value = '') {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
}

const FORBIDDEN_KEYS = new Set([
  'text', 'raw_text', 'rawtext', 'body', 'content', 'message', 'prompt', 'answer', 'response',
  'transcript', 'attachment_bytes', 'raw_prompt', 'raw_response', 'input', 'output',
]);

export function stripRuntimeTelemetryRawFields(value) {
  if (Array.isArray(value)) return value.map(stripRuntimeTelemetryRawFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = String(key || '').toLowerCase();
    if (FORBIDDEN_KEYS.has(lower)) continue;
    if (lower.includes('transcript') || lower.includes('attachment_bytes')) continue;
    out[key] = stripRuntimeTelemetryRawFields(raw);
  }
  return out;
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseOpenAiUsage(usage = {}) {
  const row = asObject(usage);
  const inputDetails = asObject(row.input_tokens_details || row.prompt_tokens_details || row.input_details);
  const outputDetails = asObject(row.output_tokens_details || row.completion_tokens_details || row.output_details);
  const inputTokens = numeric(row.input_tokens ?? row.prompt_tokens, 0);
  const outputTokens = numeric(row.output_tokens ?? row.completion_tokens, 0);
  const totalTokens = numeric(row.total_tokens, inputTokens + outputTokens);
  const cachedTokens = numeric(inputDetails.cached_tokens ?? row.cached_tokens, 0);
  const reasoningTokens = numeric(outputDetails.reasoning_tokens ?? row.reasoning_tokens, 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedTokens,
    reasoning_tokens: reasoningTokens,
    token_source: 'actual_api_response',
  };
}

export function normalizeRuntimeUsage({ provider = '', api = '', usage = {}, promptChars = 0, outputChars = 0 } = {}) {
  const providerId = clean(provider, { lower: true, maxLen: 80 });
  const apiId = clean(api, { lower: true, maxLen: 80 });
  if (providerId === 'openai' && (apiId === 'responses' || apiId === 'chat_completions' || usage.input_tokens !== undefined || usage.prompt_tokens !== undefined)) {
    return parseOpenAiUsage(usage);
  }
  const estimatedInput = Math.ceil(numeric(promptChars, 0) / 4);
  const estimatedOutput = Math.ceil(numeric(outputChars, 0) / 4);
  return {
    input_tokens: estimatedInput,
    output_tokens: estimatedOutput,
    total_tokens: estimatedInput + estimatedOutput,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    token_source: 'estimated_from_chars',
  };
}

export function estimateRuntimeCostUsd(tokens = {}, pricing = {}) {
  const price = asObject(pricing);
  const inputPerMillion = numeric(price.input_per_million_usd, 0);
  const cachedPerMillion = numeric(price.cached_input_per_million_usd, inputPerMillion);
  const outputPerMillion = numeric(price.output_per_million_usd, 0);
  if (!inputPerMillion && !cachedPerMillion && !outputPerMillion) return null;
  const cached = numeric(tokens.cached_input_tokens, 0);
  const input = Math.max(0, numeric(tokens.input_tokens, 0) - cached);
  const output = numeric(tokens.output_tokens, 0);
  const cost = (input * inputPerMillion + cached * cachedPerMillion + output * outputPerMillion) / 1_000_000;
  return Number(cost.toFixed(8));
}

export function buildRuntimeTelemetryConfig(env = process.env) {
  return {
    kind: 'runtime_telemetry_config_v1',
    enabled: boolEnv(env.RUNTIME_TELEMETRY_ENABLED || env.ROOM_MEMORY_TRIALS_DATA_COLLECTION_ENABLED),
    out_dir: env.RUNTIME_TELEMETRY_DIR || env.ROOM_MEMORY_TRIALS_DATA_DIR || path.join(process.cwd(), 'room_memory_data'),
    event_file: env.RUNTIME_TELEMETRY_FILE || 'runtime_telemetry.jsonl',
    include_raw_text: false,
  };
}

export function buildRuntimeTelemetryEvent({
  runId = '',
  threadId = '',
  roomId = '',
  turnId = '',
  provider = '',
  api = '',
  model = '',
  usage = {},
  promptChars = 0,
  outputChars = 0,
  latencyMs = 0,
  wallDurationMs = 0,
  route = null,
  context = null,
  room_memory_trials = null,
  outcome = null,
  pricing = null,
  source = 'ddalggak_runtime',
  trace = null,
  ts = nowIso(),
} = {}) {
  const tokens = normalizeRuntimeUsage({ provider, api, usage, promptChars, outputChars });
  const costEstimate = estimateRuntimeCostUsd(tokens, pricing || {});
  const routeRow = stripRuntimeTelemetryRawFields(route || {});
  return {
    kind: 'runtime_telemetry_event_v1',
    ts,
    source,
    ids: {
      run_id: clean(runId, { maxLen: 160 }),
      thread_id_hash: stableHash(threadId || roomId || 'thread'),
      room_id_hash: stableHash(roomId || threadId || 'room'),
      turn_id: clean(turnId, { maxLen: 160 }),
    },
    provider: clean(provider, { maxLen: 80, lower: true }),
    api: clean(api, { maxLen: 80, lower: true }),
    model: clean(model, { maxLen: 160 }),
    routing: {
      depth: routeRow.depth || routeRow.work_mode || '',
      execution_shape: routeRow.execution_shape || '',
      reason_codes: asArray(routeRow.reason_codes).slice(0, 20),
    },
    tokens,
    latency: {
      duration_ms: numeric(latencyMs, 0),
      wall_duration_ms: numeric(wallDurationMs || latencyMs, 0),
    },
    context: stripRuntimeTelemetryRawFields(context || {}),
    room_memory_trials: stripRuntimeTelemetryRawFields(room_memory_trials || {}),
    outcome: stripRuntimeTelemetryRawFields(outcome || {}),
    trace: stripRuntimeTelemetryRawFields(trace || {}),
    cost: costEstimate === null ? null : {
      estimated_usd: costEstimate,
      pricing_snapshot: clean(asObject(pricing).snapshot || '', { maxLen: 80 }),
      source: 'usage_times_pricing_snapshot',
    },
    privacy: {
      raw_prompt_logged: false,
      raw_response_logged: false,
      includes_raw_text: false,
      ids_are_hashed: true,
    },
  };
}

export function validateRuntimeTelemetryEvent(event = {}) {
  const encoded = JSON.stringify(event);
  for (const key of FORBIDDEN_KEYS) {
    if (encoded.includes(`"${key}"`)) return { ok: false, reason: `forbidden_key:${key}` };
  }
  const privacy = asObject(event.privacy);
  if (privacy.raw_prompt_logged === true || privacy.raw_response_logged === true || privacy.includes_raw_text === true) {
    return { ok: false, reason: 'raw_text_marked_present' };
  }
  return { ok: true };
}

export function appendRuntimeTelemetryJsonl(event = {}, { config = buildRuntimeTelemetryConfig(), enabled = null } = {}) {
  const cfg = asObject(config);
  const shouldWrite = enabled === null ? cfg.enabled === true : enabled === true;
  const validation = validateRuntimeTelemetryEvent(event);
  if (!validation.ok) return { ok: false, wrote: false, reason: validation.reason };
  if (!shouldWrite) return { ok: true, wrote: false, reason: 'disabled' };
  const outDir = path.resolve(cfg.out_dir || path.join(process.cwd(), 'room_memory_data'));
  const file = path.join(outDir, clean(cfg.event_file || 'runtime_telemetry.jsonl', { maxLen: 180 }) || 'runtime_telemetry.jsonl');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  return { ok: true, wrote: true, file };
}
