import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 600) {
  const text = clean(value);
  const n = Math.max(80, Math.floor(Number(max) || 600));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function ensureDir(dir = '') {
  if (!dir) return '';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localMemoryDir(jobDir = '') {
  const root = clean(jobDir);
  return root ? ensureDir(path.join(root, 'local_memory')) : '';
}

function observationLogPath(jobDir = '') {
  const dir = localMemoryDir(jobDir);
  return dir ? path.join(dir, 'room_semantic_observations.jsonl') : '';
}

function appendJsonl(filePath = '', row = {}) {
  if (!filePath || !row || typeof row !== 'object') return false;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return true;
}

function readJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function hash(value = '') {
  const key = String(value || '');
  let out = 0;
  for (let i = 0; i < key.length; i += 1) out = ((out << 5) - out + key.charCodeAt(i)) | 0;
  return Math.abs(out).toString(36);
}

export function normalizeRoomSemanticObservation(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const text = clip(row.text || row.summary || row.value || row.content || row.label || '', 600);
  if (!text) return null;
  const sourceTurnId = clean(row.source_turn_id || row.sourceTurnId || row.turn_id || row.turnId || '');
  const type = clean(row.type || row.kind || 'context_observation');
  return {
    observation_id: clean(row.observation_id || row.observationId) || `room_semobs_${hash(`${type}\n${text}\n${sourceTurnId}`)}`,
    ts: clean(row.ts || row.created_at || row.createdAt) || new Date().toISOString(),
    type,
    text,
    confidence: clean(row.confidence || '') || undefined,
    source: clean(row.source || 'room_semantic_observation_log'),
    source_turn_id: sourceTurnId || undefined,
    source_role: clean(row.source_role || row.sourceRole || '') || undefined,
    extractor: clean(row.extractor || row.model || row.provider || '') || undefined,
  };
}

export function appendRoomSemanticObservation({ jobDir = '', observation = {} } = {}) {
  const normalized = normalizeRoomSemanticObservation(observation);
  const filePath = observationLogPath(jobDir);
  if (!normalized || !filePath) return null;
  appendJsonl(filePath, normalized);
  return normalized;
}

export function appendRoomSemanticObservations({ jobDir = '', observations = [] } = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  return rows.map((observation) => appendRoomSemanticObservation({ jobDir, observation })).filter(Boolean);
}

export function readRoomSemanticObservations({ jobDir = '', limit = 24 } = {}) {
  const maxRows = Math.max(1, Math.floor(Number(limit) || 24));
  const filePath = observationLogPath(jobDir);
  const rows = readJsonl(filePath).map(normalizeRoomSemanticObservation).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.observation_id)) continue;
    seen.add(row.observation_id);
    out.push(row);
  }
  return out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).slice(-maxRows);
}
