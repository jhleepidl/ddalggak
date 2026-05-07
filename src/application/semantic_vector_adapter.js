import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIM = 256;
const VECTOR_FILE = 'vectors.jsonl';
const VECTOR_MANIFEST_FILE = 'vector_manifest.json';

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '', { lower = false, maxLen = 16000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function nowIso() { return new Date().toISOString(); }
function safeMkdir(dir = '') { if (dir) fs.mkdirSync(dir, { recursive: true }); }
function readJsonl(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function writeJsonl(filePath = '', rows = []) {
  safeMkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function writeJson(filePath = '', value = {}) {
  safeMkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function hashString(value = '') {
  let h = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function defaultRoot(jobDir = '') {
  const base = clean(jobDir) || process.cwd();
  return path.join(base, 'local_memory', 'semantic_index');
}
export function resolveSemanticVectorPaths({ jobDir = '', indexDir = '' } = {}) {
  const root = clean(indexDir) || defaultRoot(jobDir);
  return { root, vectors: path.join(root, VECTOR_FILE), manifest: path.join(root, VECTOR_MANIFEST_FILE) };
}

export function tokenizeForEmbedding(text = '') {
  const src = clean(text, { lower: true, maxLen: 12000 });
  const tokens = [];
  const wordTokens = src.match(/[a-z0-9_]{2,}|[가-힣]{2,}/g) || [];
  for (const token of wordTokens) {
    tokens.push(token);
    if (/^[가-힣]{3,}$/.test(token)) {
      for (let i = 0; i <= token.length - 2; i += 1) tokens.push(token.slice(i, i + 2));
    }
  }
  const seen = new Set();
  return tokens.filter((token) => {
    if (!token || seen.has(token)) return false;
    seen.add(token);
    return true;
  }).slice(0, 512);
}

export function embedTextLocalHash(text = '', { dim = DEFAULT_DIM } = {}) {
  const size = Math.max(16, Math.min(4096, Math.floor(Number(dim) || DEFAULT_DIM)));
  const vector = new Array(size).fill(0);
  const tokens = tokenizeForEmbedding(text);
  for (const token of tokens) {
    const h = hashString(token);
    const idx = h % size;
    const sign = (h & 0x10000) ? -1 : 1;
    const weight = token.length >= 5 ? 1.3 : 1;
    vector[idx] += sign * weight;
  }
  let norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (!norm) norm = 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

export function cosineSimilarity(a = [], b = []) {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < len; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    an += x * x;
    bn += y * y;
  }
  if (!an || !bn) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

export function buildSemanticVectorRecord(item = {}, { dim = DEFAULT_DIM, embeddingModel = 'local_hash_v1' } = {}) {
  const row = asObject(item);
  const itemId = clean(row.item_id || row.id || row.source_id || row.sourceId, { maxLen: 240 });
  if (!itemId) return null;
  const text = [row.title, row.canonical_text_en, row.text_original, row.text].filter(Boolean).join('\n');
  const vector = embedTextLocalHash(text, { dim });
  return {
    kind: 'semantic_vector_record_v1',
    item_id: itemId,
    item_type: clean(row.item_type || row.itemType || 'memory', { lower: true, maxLen: 80 }),
    namespace: clean(row.namespace || 'thread', { lower: true, maxLen: 80 }),
    source_ref: clean(row.source_ref || row.sourceRef || '', { maxLen: 500 }),
    status: clean(row.status || 'active', { lower: true, maxLen: 40 }),
    visibility: clean(row.visibility || 'private', { lower: true, maxLen: 60 }),
    evidence_status: clean(row.evidence_status || row.evidenceStatus || '', { lower: true, maxLen: 60 }),
    canonical_projection_status: clean(row.canonical_projection_status || '', { lower: true, maxLen: 80 }),
    content_hash: clean(row.content_hash || row.contentHash || '', { maxLen: 120 }) || String(hashString(text)),
    embedding_model: embeddingModel,
    embedding_dim: vector.length,
    vector,
    indexed_at: nowIso(),
  };
}

export function rebuildSemanticVectorIndex({ jobDir = '', indexDir = '', items = [], dim = DEFAULT_DIM, embeddingModel = 'local_hash_v1' } = {}) {
  const paths = resolveSemanticVectorPaths({ jobDir, indexDir });
  const rows = asArray(items).map((item) => buildSemanticVectorRecord(item, { dim, embeddingModel })).filter(Boolean);
  writeJsonl(paths.vectors, rows);
  const manifest = {
    kind: 'semantic_vector_manifest_v1',
    updated_at: nowIso(),
    vector_backend: 'local_hash_embedding',
    embedding_model: embeddingModel,
    embedding_dim: Math.max(16, Math.min(4096, Math.floor(Number(dim) || DEFAULT_DIM))),
    vector_count: rows.length,
    policy: 'metadata filters are mandatory before using vector hits for prompt context or skill execution',
  };
  writeJson(paths.manifest, manifest);
  return { ok: true, paths, indexed_count: rows.length, manifest };
}

export function upsertSemanticVectors({ jobDir = '', indexDir = '', items = [], dim = DEFAULT_DIM, embeddingModel = 'local_hash_v1' } = {}) {
  const paths = resolveSemanticVectorPaths({ jobDir, indexDir });
  const existing = readJsonl(paths.vectors);
  const byId = new Map(existing.map((row) => [clean(row.item_id), row]));
  const records = asArray(items).map((item) => buildSemanticVectorRecord(item, { dim, embeddingModel })).filter(Boolean);
  for (const record of records) byId.set(record.item_id, record);
  const rows = [...byId.values()];
  writeJsonl(paths.vectors, rows);
  const manifest = {
    kind: 'semantic_vector_manifest_v1',
    updated_at: nowIso(),
    vector_backend: 'local_hash_embedding',
    embedding_model: embeddingModel,
    embedding_dim: Math.max(16, Math.min(4096, Math.floor(Number(dim) || DEFAULT_DIM))),
    vector_count: rows.length,
    last_upsert_count: records.length,
    policy: 'metadata filters are mandatory before using vector hits for prompt context or skill execution',
  };
  writeJson(paths.manifest, manifest);
  return { ok: true, paths, upserted_count: records.length, total_count: rows.length, manifest };
}

function matchesFilters(row = {}, filters = {}) {
  const types = new Set(asArray(filters.itemTypes || filters.item_types).map((x) => clean(x, { lower: true })).filter(Boolean));
  if (types.size && !types.has(clean(row.item_type, { lower: true }))) return false;
  if (!filters.includeInactive && clean(row.status, { lower: true }) !== 'active') return false;
  const vis = new Set(asArray(filters.visibility || filters.visibilities).map((x) => clean(x, { lower: true })).filter(Boolean));
  if (vis.size && !vis.has(clean(row.visibility, { lower: true }))) return false;
  const evidence = new Set(asArray(filters.evidenceStatuses || filters.evidence_statuses).map((x) => clean(x, { lower: true })).filter(Boolean));
  if (evidence.size && !evidence.has(clean(row.evidence_status, { lower: true }))) return false;
  return true;
}

export function searchSemanticVectors({ jobDir = '', indexDir = '', query = '', itemTypes = [], limit = 8, includeInactive = false, visibility = [], evidenceStatuses = [], minScore = 0.04 } = {}) {
  const paths = resolveSemanticVectorPaths({ jobDir, indexDir });
  const vectors = readJsonl(paths.vectors).filter((row) => matchesFilters(row, { itemTypes, includeInactive, visibility, evidenceStatuses }));
  const qvec = embedTextLocalHash(query, { dim: vectors[0]?.embedding_dim || DEFAULT_DIM });
  const scored = vectors.map((row) => ({ ...row, vector_score: Number(cosineSimilarity(qvec, row.vector).toFixed(4)) }))
    .filter((row) => row.vector_score >= Number(minScore || 0))
    .sort((a, b) => b.vector_score - a.vector_score)
    .slice(0, Math.max(1, Math.min(100, Math.floor(Number(limit) || 8))));
  return { kind: 'semantic_vector_search_result_v1', query: clean(query, { maxLen: 1000 }), item_count: scored.length, vector_backend: 'local_hash_embedding', items: scored };
}
