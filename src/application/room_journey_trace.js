import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clip(value = '', max = 240) {
  const text = clean(value);
  const n = Math.max(40, Math.floor(Number(max) || 240));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}
function hash(value = '') { return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 20); }
function safeId(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'; }
function nowIso() { return new Date().toISOString(); }

export function isRoomJourneyTraceEnabled({ session = {}, now = Date.now() } = {}) {
  const envEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.DDALGGAK_ROOM_JOURNEY_TRACE_ENABLED || '').trim().toLowerCase());
  if (envEnabled) return true;
  const enabled = session?.room_journey_trace_enabled === true || session?.roomJourneyTraceEnabled === true;
  if (!enabled) return false;
  const until = Date.parse(String(session?.room_journey_trace_until || session?.roomJourneyTraceUntil || '')) || 0;
  return !until || until > Number(now || Date.now());
}

const SECRET_RE = /(authorization|api[_-]?key|password|secret|token|credential|cookie|session[_-]?id)/i;
const RAW_TEXT_KEYS = new Set(['source_quote', 'raw_prompt', 'prompt', 'full_prompt', 'transcript', 'message', 'user_text', 'assistant_text', 'content', 'summary', 'memory_summary', 'output', 'reply', 'response', 'error']);

function sanitizeScalar(key, value) {
  if (value === null || typeof value === 'undefined') return value;
  if (SECRET_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (RAW_TEXT_KEYS.has(key)) {
      return { preview: clip(value, 180), content_hash: hash(value), char_count: value.length };
    }
    return clip(value, 600);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

export function sanitizeRoomJourneyPayload(value, { depth = 0 } = {}) {
  if (depth > 5) return '[max_depth]';
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeRoomJourneyPayload(item, { depth: depth + 1 }));
  if (!value || typeof value !== 'object') return sanitizeScalar('', value);
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = clean(rawKey).slice(0, 120);
    if (!key) continue;
    if (SECRET_RE.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (RAW_TEXT_KEYS.has(key) && typeof rawValue === 'string') {
      out[`${key}_preview`] = clip(rawValue, 180);
      out[`${key}_hash`] = hash(rawValue);
      out[`${key}_chars`] = rawValue.length;
      continue;
    }
    if (Array.isArray(rawValue) || (rawValue && typeof rawValue === 'object')) {
      out[key] = sanitizeRoomJourneyPayload(rawValue, { depth: depth + 1 });
      continue;
    }
    const scalar = sanitizeScalar(key, rawValue);
    if (typeof scalar !== 'undefined') out[key] = scalar;
  }
  return out;
}

export function roomJourneyTracePath({ chatId = '', traceRoot = '' } = {}) {
  const root = path.resolve(traceRoot || process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR || 'runs/room_journey_traces');
  return path.join(root, `${safeId(chatId)}.jsonl`);
}

export function appendRoomJourneyTrace({ chatId = '', eventType = '', payload = {}, traceRoot = '', ts = '' } = {}) {
  const type = clean(eventType).toLowerCase();
  const roomId = clean(chatId);
  if (!type || !roomId) return null;
  const row = {
    kind: 'ddalggak.room_journey_trace_event/v1',
    event_id: `rjt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
    event_type: type,
    chat_id: roomId,
    ts: clean(ts) || nowIso(),
    payload: sanitizeRoomJourneyPayload(asObject(payload)),
  };
  const file = roomJourneyTracePath({ chatId: roomId, traceRoot });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export function readRoomJourneyTrace({ chatId = '', traceRoot = '', afterTs = '', limit = 5000 } = {}) {
  const file = roomJourneyTracePath({ chatId, traceRoot });
  if (!fs.existsSync(file)) return [];
  const cutoff = Date.parse(clean(afterTs)) || 0;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/g)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (cutoff && (Date.parse(row.ts || '') || 0) < cutoff) continue;
      rows.push(row);
    } catch {}
  }
  return rows.slice(-Math.max(1, Math.min(20000, Math.floor(Number(limit) || 5000))));
}

export function traceMemoryCandidates({ chatId = '', candidates = [], source = '', traceRoot = '' } = {}) {
  return asArray(candidates).map((candidate) => appendRoomJourneyTrace({
    chatId,
    eventType: 'memory.candidate_created',
    payload: {
      candidate_id: candidate?.candidate_id,
      observation_type: candidate?.observation_type,
      status: candidate?.status || 'pending',
      memory_summary: candidate?.memory_summary,
      source_turn_id: candidate?.source_turn_id,
      source_quote: candidate?.source_quote,
      target_companion_ids: candidate?.target_companion_ids,
      review_required: candidate?.review_required !== false,
      canonical_write_enabled: candidate?.canonical_write_enabled === true,
      source,
    },
    traceRoot,
  })).filter(Boolean);
}

export function traceMemoryDecision({ chatId = '', result = {}, decision = '', userId = '', traceRoot = '' } = {}) {
  const candidate = asObject(result?.candidate);
  const item = asObject(result?.memory_item);
  const decided = appendRoomJourneyTrace({
    chatId,
    eventType: 'memory.decision',
    payload: {
      decision: clean(decision).toLowerCase(),
      status: result?.status,
      ok: result?.ok === true,
      candidate_id: candidate.candidate_id,
      memory_id: item.memory_id,
      decided_by: userId,
      review_required: candidate.review_required !== false,
    },
    traceRoot,
  });
  const committed = item.memory_id ? appendRoomJourneyTrace({
    chatId,
    eventType: 'memory.committed',
    payload: {
      memory_id: item.memory_id,
      source_candidate_id: item.source_candidate_id,
      type: item.type,
      status: item.status,
      owner_companion_ids: item.owner_companion_ids,
      summary: item.summary,
      provenance: item.provenance,
      sensitivity: item.sensitivity,
    },
    traceRoot,
  }) : null;
  return { decided, committed };
}
