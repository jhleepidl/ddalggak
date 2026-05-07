import fs from 'node:fs';
import path from 'node:path';
import {
  applyCanonicalProjection,
  buildLocalCanonicalProjection,
  processCanonicalProjectionQueue,
  readCanonicalProjectionState,
  resolveCanonicalProjectionPaths,
} from './canonical_projection.js';
import { refreshSemanticIndexCanonicalProjections } from './semantic_index.js';

function clean(value = '', { maxLen = 12000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function safeMkdir(dir = '') { if (dir) fs.mkdirSync(dir, { recursive: true }); }
function appendJsonl(filePath = '', row = {}) { safeMkdir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }

export function buildCanonicalProjectionWorkerPrompt(projections = []) {
  const rows = asArray(projections).map((row, idx) => ({
    n: idx + 1,
    projection_id: row.projection_id,
    object_type: row.object_type,
    original_language: row.source_original_language,
    text_original: clean(row.source_original_text, { maxLen: 1200 }),
  }));
  return [
    'You are a canonical projection worker for a local-first long-running agent runtime.',
    'Convert each source item into a concise English canonical projection for internal routing, policy matching, and semantic indexing.',
    'Do not overwrite or paraphrase away safety-critical constraints. Preserve approval boundaries, stop conditions, negations, dates, names, and domain terms.',
    'Return JSON only with shape: {"projections":[{"projection_id":"...","canonical_text_en":"...","confidence":0.0-1.0}]}',
    JSON.stringify({ items: rows }, null, 2),
  ].join('\n');
}

function parseProjectorResponse(response = null) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (typeof response === 'object') return asArray(response.projections || response.items || response.results);
  const text = String(response || '').trim();
  if (!text) return [];
  const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(jsonText);
    return parseProjectorResponse(parsed);
  } catch {
    return [];
  }
}

export async function runCanonicalProjectionWorker({
  jobDir = '',
  projectionDir = '',
  limit = 20,
  projector = null,
  actor = 'canonical_projection_worker',
  refreshSemanticIndex = true,
  allowLocalRetry = true,
} = {}) {
  const paths = resolveCanonicalProjectionPaths({ jobDir, projectionDir });
  const pendingState = readCanonicalProjectionState({ jobDir, projectionDir, statuses: ['pending_model_projection'] });
  const pending = asArray(pendingState.projections).slice(0, Math.max(1, Math.floor(Number(limit) || 20)));
  if (pending.length === 0) {
    return { ok: true, worker: 'canonical_projection_worker_v1', processed_count: 0, ready_count: 0, skipped_count: 0, refreshed_index: null, paths };
  }

  const prompt = buildCanonicalProjectionWorkerPrompt(pending);
  let results = [];
  if (typeof projector === 'function') {
    const maybe = projector.length >= 2 ? await projector(pending, { prompt, actor }) : await projector({ projections: pending, prompt, actor });
    results = parseProjectorResponse(maybe);
  }

  const byId = new Map(results.map((row) => [clean(row.projection_id || row.projectionId), row]).filter(([id]) => id));
  let ready = 0;
  let skipped = 0;
  const processed = [];
  for (const row of pending) {
    const provided = asObject(byId.get(clean(row.projection_id)));
    let canonical = clean(provided.canonical_text_en || provided.canonicalTextEn || provided.text || '');
    let method = clean(provided.projection_method || provided.method || (canonical ? 'model_projection' : ''));
    let confidence = Number(provided.confidence ?? provided.projection_confidence);
    if (!canonical && allowLocalRetry) {
      const local = buildLocalCanonicalProjection({ text: row.source_original_text, originalLanguage: row.source_original_language, objectType: row.object_type, title: row.title });
      canonical = clean(local.canonical_text_en || '');
      method = clean(local.projection_method || 'local_projection_retry');
      confidence = Number(local.confidence || local.projection_confidence || 0);
    }
    if (!canonical) {
      skipped += 1;
      processed.push({ projection_id: row.projection_id, ok: false, status: 'pending_model_projection' });
      continue;
    }
    const applied = applyCanonicalProjection({ jobDir, projectionDir, projectionId: row.projection_id, canonicalTextEn: canonical, actor, method: method || 'model_projection', confidence: Number.isFinite(confidence) ? confidence : 0.85 });
    ready += applied.ok ? 1 : 0;
    processed.push({ projection_id: row.projection_id, ok: true, status: 'ready', method: applied.projection.projection_method });
  }

  appendJsonl(paths.events, { ts: nowIso(), kind: 'canonical_projection_worker_run', actor, pending_count: pending.length, ready_count: ready, skipped_count: skipped });
  const refreshed = refreshSemanticIndex ? refreshSemanticIndexCanonicalProjections({ jobDir }) : null;
  return { ok: true, worker: 'canonical_projection_worker_v1', processed_count: processed.length, ready_count: ready, skipped_count: skipped, processed, prompt, refreshed_index: refreshed, paths };
}

export function runLocalCanonicalProjectionQueue(args = {}) {
  const result = processCanonicalProjectionQueue(args);
  const refreshed = args.refreshSemanticIndex === false ? null : refreshSemanticIndexCanonicalProjections({ jobDir: args.jobDir || '', projectionDir: '', rebuildVectors: true });
  return { ...result, refreshed_index: refreshed };
}
