import fs from 'node:fs';
import path from 'node:path';
import { detectTextLanguage, normalizeLanguageMetadata, normalizeLocale } from './language_policy.js';

export const CANONICAL_PROJECTION_QUEUE_FILE = 'canonical_projection_queue.jsonl';
export const CANONICAL_PROJECTION_STATE_FILE = 'canonical_projection_state.json';
export const CANONICAL_PROJECTION_EVENTS_FILE = 'canonical_projection_events.jsonl';

function clean(value = '', { maxLen = 12000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function safeMkdir(dir = '') { if (dir) fs.mkdirSync(dir, { recursive: true }); }
function appendJsonl(filePath = '', row = {}) { safeMkdir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function readJson(filePath = '', fallback = null) { try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(filePath = '', value = {}) { safeMkdir(path.dirname(filePath)); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function hash(value = '') { let h = 0; const text = String(value || ''); for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }
function localMemoryDir(jobDir = '') { return path.join(String(jobDir || '').trim(), 'local_memory'); }
export function resolveCanonicalProjectionPaths({ jobDir = '', projectionDir = '' } = {}) {
  const root = clean(projectionDir) || path.join(localMemoryDir(jobDir), 'canonical_projection');
  return {
    root,
    queue: path.join(root, CANONICAL_PROJECTION_QUEUE_FILE),
    state: path.join(root, CANONICAL_PROJECTION_STATE_FILE),
    events: path.join(root, CANONICAL_PROJECTION_EVENTS_FILE),
  };
}
function projectionIdFor({ objectType = 'memory', sourceRef = '', sourceId = '', text = '' } = {}) {
  const type = clean(objectType, { lower: true, maxLen: 80 }) || 'memory';
  const ref = clean(sourceRef || sourceId, { maxLen: 500 }) || hash(text);
  return `projection_${type}_${hash(`${type}\n${ref}\n${clean(text, { maxLen: 2000 })}`)}`;
}

const KO_PATTERNS = [
  { re: /(한국어|한글).*?(간결|짧|요약).*?(답|응답|대답|작성)|간결.*?(한국어|한글).*?(답|응답|대답|작성)/i, text: 'Respond concisely in Korean.' },
  { re: /(영어).*?(간결|짧|요약).*?(답|응답|대답|작성)|간결.*?(영어).*?(답|응답|대답|작성)/i, text: 'Respond concisely in English.' },
  { re: /(계속|지속|반복|loop|루프).*?(점검|검토|개선)/i, text: 'Run a bounded continuous review-and-improvement loop.' },
  { re: /(매|각).*?(개선|iteration|반복).*?(review|리뷰|검토|검증)/i, text: 'Review each implementation iteration.' },
  { re: /(큰\s*변경|위험|리스크|삭제|배포|마이그레이션).*?(승인|허가)|승인.*?(큰\s*변경|위험|리스크|삭제|배포|마이그레이션)/i, text: 'Require approval before large, risky, destructive, deployment, or migration changes.' },
  { re: /(중단\s*조건|stop\s*condition|완성.*?중단|충분히.*?완성)/i, text: 'Evaluate explicit stop conditions before ending the loop.' },
  { re: /(국내\s*주식|한국\s*주식|주식투자|종목).*?(뉴스|가격|시세|추천|포트폴리오)/i, text: 'Build or analyze a Korean stock investment product using news impact analysis, price lookup, recommendations, and portfolio management.' },
  { re: /(최신\s*뉴스|뉴스).*?(영향|분석).*?(주식|종목|가격|시세)|뉴스.*?(주식|종목|가격|시세).*?(영향|분석|미치)/i, text: 'Analyze recent news for its impact on stocks, affected assets, and prices.' },
  { re: /(메모리|memory).*?(vector|벡터|인덱스|index|조회|저장)/i, text: 'Use semantic/vector indexing for memory storage and retrieval projections.' },
  { re: /(skill|스킬).*?(vector|벡터|인덱스|index|조회|검색|discovery)/i, text: 'Use semantic/vector indexing for skill discovery and ranking.' },
  { re: /(role|역할|agent|에이전트).*?(vector|벡터|인덱스|index|조회|검색|team|팀)/i, text: 'Use structured role and team contracts with semantic indexing for discovery.' },
  { re: /(원문|그대로).*?(보존|유지).*?(영어|canonical|projection|정규화)/i, text: 'Preserve original user text and add a separate English canonical projection.' },
];

function extractEnglishTerms(text = '') {
  const src = clean(text, { maxLen: 4000 });
  const terms = [];
  if (/(memory|메모리)/i.test(src)) terms.push('memory');
  if (/(skill|스킬)/i.test(src)) terms.push('skill');
  if (/(role|역할)/i.test(src)) terms.push('role');
  if (/(team|팀|agent|에이전트)/i.test(src)) terms.push('agent team');
  if (/(vector|벡터|embedding|임베딩|semantic|시맨틱)/i.test(src)) terms.push('semantic/vector indexing');
  if (/(review|리뷰|검토|검증)/i.test(src)) terms.push('review');
  if (/(loop|루프|반복|계속|지속)/i.test(src)) terms.push('loop');
  if (/(승인|approval|approve)/i.test(src)) terms.push('approval gate');
  if (/(주식|종목|stock|portfolio|포트폴리오|뉴스|news|가격|시세)/i.test(src)) terms.push('financial news and stock analysis');
  return [...new Set(terms)];
}

export function buildLocalCanonicalProjection({ text = '', originalLanguage = '', canonicalTextEn = '', objectType = 'memory', title = '' } = {}) {
  const original = clean(text || title, { maxLen: 12000 });
  const language = normalizeLocale(originalLanguage || detectTextLanguage(original, 'ko'));
  const existing = clean(canonicalTextEn, { maxLen: 12000 });
  if (!original && !existing) {
    return { ok: false, status: 'empty', canonical_text_en: '', canonical_projection_status: 'empty', projection_method: 'none', confidence: 0, original_language: language };
  }
  if (existing) {
    return { ok: true, status: 'ready', canonical_text_en: existing, canonical_projection_status: 'ready', projection_method: 'provided', confidence: 1, original_language: language };
  }
  if (language === 'en') {
    return { ok: true, status: 'ready', canonical_text_en: original, canonical_projection_status: 'ready', projection_method: 'source_is_english', confidence: 1, original_language: 'en' };
  }
  const hits = [];
  for (const pattern of KO_PATTERNS) {
    if (pattern.re.test(original)) hits.push(pattern.text);
  }
  const terms = extractEnglishTerms(original);
  if (hits.length > 0) {
    const termSentence = terms.length ? ` Key concepts: ${terms.join(', ')}.` : '';
    return {
      ok: true,
      status: 'ready',
      canonical_text_en: [...new Set(hits)].join(' ') + termSentence,
      canonical_projection_status: 'ready',
      projection_method: 'local_seed_glossary',
      confidence: Math.min(0.88, 0.55 + hits.length * 0.08 + terms.length * 0.02),
      original_language: language,
    };
  }
  if (terms.length >= 2) {
    return {
      ok: true,
      status: 'ready',
      canonical_text_en: `User-provided ${clean(objectType, { lower: true, maxLen: 80 }) || 'runtime'} item about ${terms.join(', ')}.`,
      canonical_projection_status: 'ready',
      projection_method: 'local_keyword_summary',
      confidence: 0.5,
      original_language: language,
    };
  }
  return {
    ok: false,
    status: 'pending_model_projection',
    canonical_text_en: '',
    canonical_projection_status: 'pending_model_projection',
    projection_method: 'requires_model_or_human_projection',
    confidence: 0,
    original_language: language,
  };
}

export function buildCanonicalProjectionRequest(input = {}) {
  const row = asObject(input);
  const language = normalizeLanguageMetadata({
    text: row.source_original_text || row.original_text || row.text || row.summary || row.description || row.title || '',
    displayText: row.display_text || row.displayText || row.summary || row.description || row.title || '',
    locale: row.source_original_language || row.original_language || row.locale || row.user_surface_locale || '',
    canonicalTextEn: row.canonical_text_en || row.canonical_summary_en || row.canonicalTextEn || '',
    source: 'canonical_projection',
  });
  const projection = buildLocalCanonicalProjection({
    text: language.source_original_text,
    originalLanguage: language.original_language,
    canonicalTextEn: language.canonical_text_en,
    objectType: row.object_type || row.objectType || row.item_type || row.proposal_kind || row.kind || 'memory',
    title: row.title || '',
  });
  const objectType = clean(row.object_type || row.objectType || row.item_type || row.proposal_kind || row.kind || 'memory', { lower: true, maxLen: 80 }) || 'memory';
  const projectionId = clean(row.projection_id || row.projectionId) || projectionIdFor({ objectType, sourceRef: row.source_ref || row.sourceRef || row.source_id || row.sourceId || '', sourceId: row.source_id || row.sourceId || row.item_id || row.proposal_id || '', text: language.source_original_text });
  return {
    kind: 'canonical_projection_request_v1',
    projection_id: projectionId,
    object_type: objectType,
    source_ref: clean(row.source_ref || row.sourceRef || row.source_id || row.sourceId || '', { maxLen: 500 }),
    source_id: clean(row.source_id || row.sourceId || row.item_id || row.proposal_id || '', { maxLen: 240 }),
    title: clean(row.title || '', { maxLen: 240 }),
    source_original_text: language.source_original_text,
    source_original_language: language.source_original_language,
    display_text: language.display_text,
    canonical_language: 'en',
    canonical_text_en: projection.canonical_text_en,
    canonical_projection_status: projection.canonical_projection_status,
    projection_method: projection.projection_method,
    projection_confidence: projection.confidence,
    status: projection.ok ? 'ready' : projection.status,
    projector: projection.projection_method,
    metadata: asObject(row.metadata),
    created_at: clean(row.created_at || '') || nowIso(),
    updated_at: nowIso(),
  };
}

function readState(paths) {
  const state = readJson(paths.state, null);
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    state.projections = asObject(state.projections);
    return state;
  }
  return { kind: 'canonical_projection_state_v1', schema_version: 1, updated_at: nowIso(), projections: {} };
}
function writeState(paths, state) {
  const row = asObject(state);
  row.kind = row.kind || 'canonical_projection_state_v1';
  row.schema_version = row.schema_version || 1;
  row.updated_at = nowIso();
  row.projections = asObject(row.projections);
  writeJson(paths.state, row);
  return row;
}

export function upsertCanonicalProjectionRequest({ jobDir = '', projectionDir = '', item = {}, actor = 'runtime', enqueuePending = true } = {}) {
  const paths = resolveCanonicalProjectionPaths({ jobDir, projectionDir });
  safeMkdir(paths.root);
  const request = buildCanonicalProjectionRequest(item);
  const state = readState(paths);
  const existing = asObject(state.projections[request.projection_id]);
  const next = { ...existing, ...request, created_at: existing.created_at || request.created_at, updated_at: nowIso(), actor: clean(actor, { maxLen: 80 }) || 'runtime' };
  state.projections[request.projection_id] = next;
  writeState(paths, state);
  appendJsonl(paths.events, { ts: nowIso(), kind: 'canonical_projection_upserted', actor: next.actor, projection_id: next.projection_id, object_type: next.object_type, status: next.status, method: next.projection_method });
  if (enqueuePending && next.status !== 'ready') appendJsonl(paths.queue, next);
  return { ok: true, projection: next, paths };
}

export function readCanonicalProjectionState({ jobDir = '', projectionDir = '', statuses = [] } = {}) {
  const paths = resolveCanonicalProjectionPaths({ jobDir, projectionDir });
  const state = readState(paths);
  const statusSet = new Set(asArray(statuses).map((s) => clean(s, { lower: true })).filter(Boolean));
  const projections = Object.values(state.projections).filter((p) => !statusSet.size || statusSet.has(clean(p.status, { lower: true })));
  return { ...state, projections, paths };
}

export function applyCanonicalProjection({ jobDir = '', projectionDir = '', projectionId = '', canonicalTextEn = '', actor = 'runtime', method = 'model_projection', confidence = 0.9 } = {}) {
  const paths = resolveCanonicalProjectionPaths({ jobDir, projectionDir });
  const id = clean(projectionId);
  const canonical = clean(canonicalTextEn, { maxLen: 12000 });
  if (!id) throw new Error('projectionId is required');
  if (!canonical) throw new Error('canonicalTextEn is required');
  const state = readState(paths);
  const current = asObject(state.projections[id]);
  if (!current.projection_id) throw new Error(`canonical projection not found: ${id}`);
  const next = {
    ...current,
    canonical_text_en: canonical,
    canonical_projection_status: 'ready',
    status: 'ready',
    projection_method: clean(method, { maxLen: 80 }) || 'model_projection',
    projection_confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0.9,
    projected_by: clean(actor, { maxLen: 80 }) || 'runtime',
    updated_at: nowIso(),
  };
  state.projections[id] = next;
  writeState(paths, state);
  appendJsonl(paths.events, { ts: nowIso(), kind: 'canonical_projection_applied', actor: next.projected_by, projection_id: id, method: next.projection_method });
  return { ok: true, projection: next };
}

export function processCanonicalProjectionQueue({ jobDir = '', projectionDir = '', projector = null, limit = 50, actor = 'runtime_projection_worker' } = {}) {
  const paths = resolveCanonicalProjectionPaths({ jobDir, projectionDir });
  const state = readState(paths);
  const rows = Object.values(state.projections).filter((p) => clean(p.status, { lower: true }) !== 'ready').slice(0, Math.max(1, Number(limit || 50)));
  const processed = [];
  for (const row of rows) {
    let result = null;
    if (typeof projector === 'function') result = projector(row);
    if (!result) result = buildLocalCanonicalProjection({ text: row.source_original_text, originalLanguage: row.source_original_language, objectType: row.object_type, title: row.title });
    const canonical = clean(result?.canonical_text_en || result?.canonicalTextEn || '', { maxLen: 12000 });
    if (!canonical) {
      const next = { ...row, status: 'pending_model_projection', canonical_projection_status: 'pending_model_projection', updated_at: nowIso() };
      state.projections[row.projection_id] = next;
      processed.push({ projection_id: row.projection_id, status: next.status, ok: false });
      continue;
    }
    const next = {
      ...row,
      canonical_text_en: canonical,
      canonical_projection_status: 'ready',
      status: 'ready',
      projection_method: clean(result?.projection_method || result?.method || 'model_projection', { maxLen: 80 }),
      projection_confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0.85,
      projected_by: clean(actor, { maxLen: 80 }),
      updated_at: nowIso(),
    };
    state.projections[row.projection_id] = next;
    appendJsonl(paths.events, { ts: nowIso(), kind: 'canonical_projection_processed', actor, projection_id: next.projection_id, method: next.projection_method });
    processed.push({ projection_id: next.projection_id, status: next.status, ok: true });
  }
  writeState(paths, state);
  return { ok: true, processed_count: processed.length, ready_count: processed.filter((p) => p.ok).length, processed, paths };
}
