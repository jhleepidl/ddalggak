import fs from 'node:fs';
import path from 'node:path';
import { normalizeLanguageMetadata } from './language_policy.js';
import { buildCanonicalProjectionRequest, readCanonicalProjectionState, upsertCanonicalProjectionRequest } from './canonical_projection.js';
import { rebuildSemanticVectorIndex, searchSemanticVectors, upsertSemanticVectors } from './semantic_vector_adapter.js';

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '', { lower = false, maxLen = 2000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function nowIso() { return new Date().toISOString(); }
function safeMkdir(dir = '') { if (dir) fs.mkdirSync(dir, { recursive: true }); }
function readJsonl(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendJsonl(filePath = '', row = {}) {
  safeMkdir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function writeJsonl(filePath = '', rows = []) {
  safeMkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function readJson(filePath = '', fallback = null) {
  try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback; } catch { return fallback; }
}
function tokenSet(text = '') {
  return new Set((clean(text, { lower: true, maxLen: 4000 }).match(/[a-z0-9가-힣_]{2,}/g) || []).slice(0, 200));
}
function jaccard(a = new Set(), b = new Set()) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / Math.max(1, a.size + b.size - inter);
}
function defaultRoot(jobDir = '') {
  const base = clean(jobDir) || process.cwd();
  return path.join(base, 'local_memory', 'semantic_index');
}
export function resolveSemanticIndexPaths({ jobDir = '', indexDir = '' } = {}) {
  const root = clean(indexDir) || defaultRoot(jobDir);
  return {
    root,
    items: path.join(root, 'items.jsonl'),
    manifest: path.join(root, 'index_manifest.json'),
    vectors: path.join(root, 'vectors.jsonl'),
    vector_manifest: path.join(root, 'vector_manifest.json'),
  };
}
export function buildSemanticIndexItem({ itemType = 'memory', namespace = 'thread', sourceRef = '', sourceId = '', text = '', title = '', metadata = {}, status = 'active', evidenceStatus = '', visibility = 'private', originalLanguage = '', canonicalTextEn = '', displayText = '' } = {}) {
  const id = clean(sourceId) || `${clean(itemType, { lower: true })}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const language = normalizeLanguageMetadata({ text, displayText: displayText || text || title, locale: originalLanguage, canonicalTextEn, source: 'semantic_index' });
  const projection = buildCanonicalProjectionRequest({
    object_type: itemType,
    source_ref: sourceRef,
    source_id: id,
    title,
    source_original_text: language.source_original_text,
    source_original_language: language.source_original_language,
    display_text: language.display_text,
    canonical_text_en: language.canonical_text_en,
    metadata,
  });
  const canonicalText = projection.canonical_text_en || language.canonical_text_en;
  const searchableText = [language.source_original_text, canonicalText, title].filter(Boolean).join('\n');
  return {
    kind: 'semantic_index_item_v1',
    item_id: id,
    item_type: clean(itemType, { lower: true, maxLen: 80 }) || 'memory',
    namespace: clean(namespace, { lower: true, maxLen: 80 }) || 'thread',
    source_ref: clean(sourceRef, { maxLen: 500 }),
    title: clean(title, { maxLen: 240 }),
    text: clean(searchableText, { maxLen: 16000 }),
    text_original: language.source_original_text,
    original_language: language.original_language,
    canonical_language: language.canonical_language,
    canonical_text_en: canonicalText,
    canonical_projection_status: projection.canonical_projection_status || language.canonical_projection_status,
    canonical_projection_id: projection.projection_id,
    projection_method: projection.projection_method,
    display_text: language.display_text,
    metadata: { ...asObject(metadata), canonical_projection_id: projection.projection_id, projection_method: projection.projection_method },
    status: clean(status, { lower: true, maxLen: 40 }) || 'active',
    evidence_status: clean(evidenceStatus, { lower: true, maxLen: 60 }) || undefined,
    visibility: clean(visibility, { lower: true, maxLen: 60 }) || 'private',
    created_at: nowIso(),
    embedding_status: 'pending',
    embedding_ref: null,
  };
}
export function addSemanticIndexItems({ jobDir = '', indexDir = '', items = [], queueCanonicalProjection = true, updateVectorIndex = true } = {}) {
  const paths = resolveSemanticIndexPaths({ jobDir, indexDir });
  safeMkdir(paths.root);
  const normalized = asArray(items).map((item) => item?.kind === 'semantic_index_item_v1' ? item : buildSemanticIndexItem(item)).filter((item) => clean(item.text || item.title || item.source_ref));
  if (queueCanonicalProjection && clean(jobDir)) {
    for (const item of normalized) {
      upsertCanonicalProjectionRequest({
        jobDir,
        item: {
          object_type: item.item_type,
          source_ref: item.source_ref,
          source_id: item.item_id,
          title: item.title,
          source_original_text: item.text_original,
          source_original_language: item.original_language,
          display_text: item.display_text,
          canonical_text_en: item.canonical_text_en,
          metadata: item.metadata,
        },
        actor: 'semantic_index',
      });
    }
  }
  for (const item of normalized) appendJsonl(paths.items, item);
  if (updateVectorIndex) upsertSemanticVectors({ jobDir, indexDir, items: normalized });
  const manifest = {
    kind: 'semantic_index_manifest_v1',
    updated_at: nowIso(),
    item_count_delta: normalized.length,
    storage: 'jsonl_sidecar',
    vector_backend: updateVectorIndex ? 'local_hash_embedding' : 'pending_embedding_adapter',
    supported_item_types: ['memory', 'skill', 'role', 'team_blueprint', 'watch_iteration', 'review_finding'],
    language_policy: 'preserve_original_text; index original plus English canonical projection when available',
    canonical_projection_pipeline: 'canonical_projection_queue_v1',
    vector_manifest: 'vector_manifest.json',
    policy: 'canonical_store_plus_vector_index; never use vector hits without metadata/status/evidence filters',
  };
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { paths, added_count: normalized.length, manifest };
}
export function searchSemanticIndex({ jobDir = '', indexDir = '', query = '', itemTypes = [], limit = 8, includeInactive = false, useVector = true, visibility = [], evidenceStatuses = [], minScore = 0.04 } = {}) {
  const paths = resolveSemanticIndexPaths({ jobDir, indexDir });
  const qTokens = tokenSet(query);
  const typeSet = new Set(asArray(itemTypes).map((x) => clean(x, { lower: true })).filter(Boolean));
  const visSet = new Set(asArray(visibility).map((x) => clean(x, { lower: true })).filter(Boolean));
  const evidenceSet = new Set(asArray(evidenceStatuses).map((x) => clean(x, { lower: true })).filter(Boolean));
  const allRows = readJsonl(paths.items).filter((row) => {
    if (!includeInactive && clean(row.status, { lower: true }) !== 'active') return false;
    if (typeSet.size && !typeSet.has(clean(row.item_type, { lower: true }))) return false;
    if (visSet.size && !visSet.has(clean(row.visibility, { lower: true }))) return false;
    if (evidenceSet.size && !evidenceSet.has(clean(row.evidence_status, { lower: true }))) return false;
    return true;
  });
  const vectorHits = useVector ? searchSemanticVectors({ jobDir, indexDir, query, itemTypes, limit: Math.max(Number(limit || 8) * 3, 12), includeInactive, visibility, evidenceStatuses, minScore }) : { items: [] };
  const vectorScores = new Map((vectorHits.items || []).map((row) => [clean(row.item_id), Number(row.vector_score || 0)]));
  const rows = allRows.map((row) => {
    const lexical = jaccard(qTokens, tokenSet([row.title, row.text, row.canonical_text_en, row.source_ref].join(' ')));
    const vector = vectorScores.get(clean(row.item_id)) || 0;
    const score = Math.max(lexical, vector * 0.92) + (lexical > 0 && vector > 0 ? 0.04 : 0);
    return { ...row, lexical_semantic_score: Number(lexical.toFixed(4)), vector_score: Number(vector.toFixed(4)), semantic_score: Number(score.toFixed(4)), retrieval_backend: vector > lexical ? 'local_vector' : 'lexical' };
  }).filter((row) => row.semantic_score > 0 || !clean(query)).sort((a, b) => b.semantic_score - a.semantic_score).slice(0, Math.max(1, Number(limit || 8)));
  return { kind: 'semantic_index_search_result_v1', query: clean(query), item_count: rows.length, vector_backend: useVector ? 'local_hash_embedding' : 'disabled', items: rows };
}

export function refreshSemanticIndexCanonicalProjections({ jobDir = '', indexDir = '', rebuildVectors = true } = {}) {
  const paths = resolveSemanticIndexPaths({ jobDir, indexDir });
  const rows = readJsonl(paths.items);
  if (rows.length === 0 || !clean(jobDir)) return { ok: true, updated_count: 0, item_count: rows.length, paths };
  const state = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  const byProjectionId = new Map(asArray(state.projections).map((row) => [clean(row.projection_id), row]));
  let updated = 0;
  const nextRows = rows.map((row) => {
    const projection = byProjectionId.get(clean(row.canonical_projection_id));
    if (!projection || !clean(projection.canonical_text_en)) return row;
    if (clean(row.canonical_text_en) === clean(projection.canonical_text_en) && row.canonical_projection_status === 'ready') return row;
    updated += 1;
    const text = [row.text_original, projection.canonical_text_en, row.title].filter(Boolean).join('\n');
    return {
      ...row,
      canonical_text_en: projection.canonical_text_en,
      canonical_projection_status: 'ready',
      projection_method: projection.projection_method || row.projection_method,
      metadata: { ...asObject(row.metadata), projection_method: projection.projection_method || row.projection_method },
      text: clean(text, { maxLen: 16000 }),
      updated_at: nowIso(),
      embedding_status: rebuildVectors ? 'ready' : row.embedding_status,
    };
  });
  if (updated > 0) {
    writeJsonl(paths.items, nextRows);
    if (rebuildVectors) rebuildSemanticVectorIndex({ jobDir, indexDir, items: nextRows });
    const manifest = readJson(paths.manifest, {});
    fs.writeFileSync(paths.manifest, `${JSON.stringify({ ...asObject(manifest), updated_at: nowIso(), canonical_projection_refresh: { updated_count: updated }, vector_backend: rebuildVectors ? 'local_hash_embedding' : manifest.vector_backend }, null, 2)}\n`, 'utf8');
  }
  return { ok: true, updated_count: updated, item_count: nextRows.length, paths };
}
