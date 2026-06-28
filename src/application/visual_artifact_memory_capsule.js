import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function normalizePath(value = '') { return clean(value).replace(/\\/g, '/'); }
function capsulePath(jobDir = '') { return path.join(clean(jobDir), 'visual_artifact_context.jsonl'); }
function legacyCapsulePath(jobDir = '') { return path.join(clean(jobDir), 'visual_artifact_capsules.jsonl'); }
function safeAppend(filePath = '', row = {}) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function readJsonl(filePath = '', { limit = 200 } = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const rows = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return rows.slice(-Math.max(1, Math.floor(Number(limit) || 200)));
  } catch {
    return [];
  }
}
function unique(values = [], { max = 64 } = {}) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const v = clean(value);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
function clip(value = '', max = 1000, { mode = 'end' } = {}) {
  const s = clean(value);
  if (s.length <= max) return s;
  if (mode === 'middle') {
    const head = Math.floor((max - 1) / 2);
    const tail = Math.max(0, max - head - 1);
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  }
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function loadUploadedArtifactsFromManifest(jobDir = '', { limit = 24 } = {}) {
  const rows = readJsonl(path.join(clean(jobDir), 'workspace', 'uploads', 'manifest.jsonl'), { limit });
  return rows.map((row) => ({
    ...asObject(row),
    workspace_path: normalizePath(row.workspace_path || row.workspacePath),
    upload_kind: clean(row.upload_kind || row.uploadKind || row.kind),
    filename: clean(row.filename || row.fileName),
    upload_note: clean(row.upload_note || row.uploadNote),
  })).filter((row) => row.workspace_path);
}

function looksVisual(uploadRecord = {}) {
  const text = `${uploadRecord?.upload_kind || uploadRecord?.uploadKind || uploadRecord?.kind || ''} ${uploadRecord?.filename || ''} ${uploadRecord?.workspace_path || uploadRecord?.workspacePath || ''}`;
  return /photo|image|jpg|jpeg|png|webp|gif/i.test(text);
}

function inferGroupLabel(uploadRecord = {}) {
  const row = asObject(uploadRecord);
  const note = clean(row.upload_note || row.uploadNote);
  const filename = clean(row.filename || path.basename(clean(row.workspace_path || row.workspacePath)));
  const source = note || filename || 'uploaded visual artifact';
  return source
    .replace(/\.(jpg|jpeg|png|webp|gif)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(photo|image|screenshot|document|file)\b/ig, ' ')
    .replace(/\s*[#:_-]?\s*\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || 'uploaded visual artifact';
}

function inferContextHint(uploadRecord = {}) {
  const text = `${uploadRecord?.upload_note || ''} ${uploadRecord?.filename || ''} ${uploadRecord?.workspace_path || ''}`.toLowerCase();
  if (/menu|메뉴|식당|음식|drink|wine|와인|beer|주류/.test(text)) return 'possible_menu_or_drink_list';
  if (/receipt|영수증|invoice|bill/.test(text)) return 'possible_receipt_or_bill';
  if (/chart|diagram|그래프|도표|figure/.test(text)) return 'possible_figure_or_diagram';
  if (/screenshot|캡처|스크린샷/.test(text)) return 'possible_screenshot';
  return 'unknown_visual_artifact';
}

function stableId(label = '') {
  return `visual:${clean(label).toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'artifact'}`;
}

function normalizeObservation(value = {}) {
  if (typeof value === 'string') {
    const label = clean(value);
    return label ? { label, source: 'extractor_text' } : null;
  }
  const row = asObject(value);
  const label = clean(row.label || row.name || row.text || row.value || row.item);
  if (!label) return null;
  const out = {
    label,
    object_type: clean(row.object_type || row.objectType || row.type || row.category) || undefined,
    attributes: asObject(row.attributes),
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
    source: clean(row.source || 'bounded_visual_extraction'),
  };
  if (row.price != null && clean(row.price)) out.attributes = { ...out.attributes, price: clean(row.price) };
  return out;
}

function normalizeExtractionPayload(row = {}) {
  const src = asObject(row);
  const text = clean(src.text || src.ocr_text || src.ocrText || src.extracted_text || src.extractedText || src.summary);
  const observations = [
    ...asArray(src.observations),
    ...asArray(src.structured_observations || src.structuredObservations),
    ...asArray(src.candidate_facts || src.candidateFacts),
  ].map(normalizeObservation).filter(Boolean);

  // Backward-compatible adapter: if an external extractor deliberately returns menu/drink fields,
  // keep them as generic observations instead of forcing every image into a menu schema.
  for (const item of asArray(src.menu_items || src.menuItems)) {
    const obs = normalizeObservation({ label: item, object_type: 'food_item', source: 'extractor_menu_items' });
    if (obs) observations.push(obs);
  }
  for (const item of asArray(src.drink_items || src.drinkItems)) {
    const obs = normalizeObservation({ label: item, object_type: 'drink_item', source: 'extractor_drink_items' });
    if (obs) observations.push(obs);
  }
  for (const item of asArray(src.items || src.extracted_items || src.extractedItems)) {
    const obs = normalizeObservation(item);
    if (obs) observations.push(obs);
  }

  const seen = new Set();
  const deduped = [];
  for (const obs of observations) {
    const key = `${clean(obs.object_type).toLowerCase()}::${clean(obs.label).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(obs);
    if (deduped.length >= 80) break;
  }

  return {
    text,
    observations: deduped,
    contextual_summary: clean(src.contextual_summary || src.contextualSummary || src.summary) || undefined,
    schema_hint: clean(src.schema_hint || src.schemaHint || src.domain || src.schema_kind || src.schemaKind) || undefined,
  };
}

export function parseVisualArtifactItemsFromText(text = '') {
  // Kept for backwards compatibility with older tests/callers. It now returns generic
  // candidate facts instead of treating menu rows as the canonical visual memory schema.
  const lines = clean(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 80);
  const observations = lines.map((line) => normalizeObservation({ label: line, source: 'text_line' })).filter(Boolean);
  return {
    items: observations,
    extracted_items: observations.map((row) => row.label),
    observations,
    menu_items: [],
    drink_items: [],
    dessert_items: [],
  };
}

export function recordVisualArtifactExtractionResult(jobDir = '', extraction = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const row = asObject(extraction);
  const payload = normalizeExtractionPayload(row);
  if (!payload.text && payload.observations.length === 0 && !payload.contextual_summary) return null;

  const uploads = loadUploadedArtifactsFromManifest(cleanJobDir, { limit: 24 }).filter(looksVisual);
  const latest = uploads[uploads.length - 1] || {};
  const groupLabel = clean(row.group_label || row.groupLabel) || (latest ? inferGroupLabel(latest) : 'uploaded visual artifact');
  const capsuleId = clean(row.capsule_id || row.capsuleId) || stableId(groupLabel);
  const sourceImagePaths = unique(asArray(row.source_image_paths || row.sourceImagePaths).map(normalizePath).concat(
    uploads.filter((u) => inferGroupLabel(u) === groupLabel).map((u) => normalizePath(u.workspace_path))
  ), { max: 24 });
  const event = {
    ts: new Date().toISOString(),
    event: 'visual_artifact_context_extraction',
    schema_version: 'ddalggak.visual_artifact_context/v2',
    capsule_id: capsuleId,
    context_id: capsuleId,
    group_label: groupLabel,
    schema_hint: payload.schema_hint || inferContextHint(latest),
    status: clean(row.status || (payload.observations.length ? 'extracted_context' : 'extracted_unstructured')),
    source: clean(row.source || 'bounded_visual_extraction'),
    source_image_paths: sourceImagePaths,
    observations: payload.observations,
    candidate_facts: payload.observations.map((obs) => obs.label),
    contextual_summary: payload.contextual_summary,
    extraction_text_excerpt: payload.text ? clip(payload.text, 1200, { mode: 'middle' }) : undefined,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
  };
  safeAppend(capsulePath(cleanJobDir), event);
  return event;
}

export function recordVisualArtifactCapsuleUpload(jobDir = '', uploadRecord = {}) {
  const cleanJobDir = clean(jobDir);
  const row = asObject(uploadRecord);
  const workspacePath = normalizePath(row.workspace_path || row.workspacePath);
  if (!cleanJobDir || !workspacePath || !looksVisual(row)) return null;
  const groupLabel = inferGroupLabel(row);
  const payload = {
    ts: new Date().toISOString(),
    event: 'visual_artifact_context_upload',
    schema_version: 'ddalggak.visual_artifact_context/v2',
    capsule_id: stableId(groupLabel),
    context_id: stableId(groupLabel),
    group_label: groupLabel,
    schema_hint: inferContextHint(row),
    workspace_path: workspacePath,
    filename: clean(row.filename || row.fileName || path.basename(workspacePath)),
    upload_note: clean(row.upload_note || row.uploadNote),
    sha256: clean(row.sha256),
    status: 'available_uninterpreted',
    source: 'telegram_upload',
  };
  safeAppend(capsulePath(cleanJobDir), payload);
  return payload;
}

export function recordVisualArtifactCapsuleFromAgentOutput(jobDir = '', output = '', options = {}) {
  // Agent recommendations are not evidence that came from the image. To avoid overfitting
  // visual memory to one task (for example, turning every image into menu_items), do not
  // mine ordinary assistant prose into persistent visual memory unless the caller explicitly
  // opts in after a verified extraction step.
  if (options?.allow_agent_derived_visual_memory !== true) return null;
  const cleanJobDir = clean(jobDir);
  const text = clean(output);
  if (!cleanJobDir || !text) return null;
  const uploads = loadUploadedArtifactsFromManifest(cleanJobDir, { limit: 12 }).filter(looksVisual);
  if (!uploads.length) return null;
  const latest = uploads[uploads.length - 1];
  return recordVisualArtifactExtractionResult(cleanJobDir, {
    group_label: inferGroupLabel(latest),
    text,
    source_image_paths: uploads.filter((row) => inferGroupLabel(row) === inferGroupLabel(latest)).map((row) => normalizePath(row.workspace_path)),
    status: clean(options.status || 'agent_derived_unverified'),
    source: clean(options.source || 'agent_output_explicit_opt_in'),
  });
}

export function loadVisualArtifactCapsules(jobDir = '', { limit = 80 } = {}) {
  const rows = [
    ...readJsonl(legacyCapsulePath(jobDir), { limit }),
    ...readJsonl(capsulePath(jobDir), { limit }),
  ];
  const byId = new Map();
  for (const raw of rows) {
    const row = asObject(raw);
    const id = clean(row.context_id || row.contextId || row.capsule_id || row.capsuleId || row.group_label || row.groupLabel);
    if (!id) continue;
    const existing = byId.get(id) || {
      capsule_id: id,
      context_id: id,
      group_label: clean(row.group_label || row.groupLabel) || id,
      schema_hint: clean(row.schema_hint || row.schemaHint || row.domain) || 'unknown_visual_artifact',
      source_image_paths: [],
      observations: [],
      candidate_facts: [],
      upload_notes: [],
      status: 'available_uninterpreted',
      updated_at: '',
    };
    existing.group_label = clean(row.group_label || row.groupLabel) || existing.group_label;
    existing.schema_hint = clean(row.schema_hint || row.schemaHint || row.domain) || existing.schema_hint;
    existing.status = clean(row.status) || existing.status;
    existing.updated_at = clean(row.ts) || existing.updated_at;
    if (row.workspace_path || row.workspacePath) existing.source_image_paths.push(normalizePath(row.workspace_path || row.workspacePath));
    if (Array.isArray(row.source_image_paths)) existing.source_image_paths.push(...row.source_image_paths.map(normalizePath));
    if (row.upload_note || row.uploadNote) existing.upload_notes.push(clean(row.upload_note || row.uploadNote));
    const observations = [
      ...asArray(row.observations),
      ...asArray(row.structured_observations || row.structuredObservations),
      ...asArray(row.item_rows || row.itemRows),
      ...asArray(row.extracted_items || row.extractedItems).map((label) => ({ label, source: 'legacy_extracted_items' })),
      ...asArray(row.menu_items || row.menuItems).map((label) => ({ label, object_type: 'food_item', source: 'legacy_menu_items' })),
      ...asArray(row.drink_items || row.drinkItems).map((label) => ({ label, object_type: 'drink_item', source: 'legacy_drink_items' })),
    ].map(normalizeObservation).filter(Boolean);
    existing.observations.push(...observations);
    existing.candidate_facts.push(...asArray(row.candidate_facts || row.candidateFacts).map(clean));
    existing.candidate_facts.push(...observations.map((obs) => obs.label));
    if (row.extraction_text_excerpt || row.extractionTextExcerpt) existing.extraction_text_excerpt = clean(row.extraction_text_excerpt || row.extractionTextExcerpt);
    if (row.contextual_summary || row.contextualSummary) existing.contextual_summary = clean(row.contextual_summary || row.contextualSummary);
    byId.set(id, existing);
  }
  return [...byId.values()].map((entry) => {
    const byObs = new Map();
    for (const obs of entry.observations) {
      const key = `${clean(obs.object_type).toLowerCase()}::${clean(obs.label).toLowerCase()}`;
      if (!key || byObs.has(key)) continue;
      byObs.set(key, obs);
    }
    return {
      ...entry,
      source_image_paths: unique(entry.source_image_paths, { max: 24 }),
      observations: [...byObs.values()].slice(0, 80),
      candidate_facts: unique(entry.candidate_facts, { max: 80 }),
      upload_notes: unique(entry.upload_notes, { max: 12 }),
    };
  });
}

export function formatVisualArtifactCapsuleContext(jobDir = '', { maxChars = 1400, limit = 4 } = {}) {
  const entries = loadVisualArtifactCapsules(jobDir).slice(-Math.max(1, Math.floor(Number(limit) || 4))).reverse();
  if (!entries.length) return '';
  const lines = [
    '[VISUAL ARTIFACT CONTEXT]',
    '- Use this block only when the user refers to uploaded images/photos/screenshots/files, previous uploads, or asks to use visual material.',
    '- Treat upload metadata as evidence that the image exists, not as proof of item-level contents.',
    '- If observations are empty, do not say no image was provided; say the image exists but visual extraction/OCR is needed before item-level claims.',
  ];
  for (const entry of entries) {
    lines.push(`- visual_context: ${entry.group_label}`);
    lines.push(`  schema_hint: ${entry.schema_hint || 'unknown_visual_artifact'}`);
    lines.push(`  status: ${entry.status || 'available_uninterpreted'}`);
    if (entry.source_image_paths?.length) lines.push(`  source_images: ${entry.source_image_paths.join(', ')}`);
    if (entry.upload_notes?.length) lines.push(`  upload_notes: ${entry.upload_notes.join(' / ')}`);
    if (entry.contextual_summary) lines.push(`  summary: ${entry.contextual_summary}`);
    if (entry.observations?.length) {
      const obs = entry.observations.slice(0, 16).map((row) => {
        const type = row.object_type ? `[${row.object_type}] ` : '';
        const attrs = row.attributes && Object.keys(row.attributes).length ? ` ${JSON.stringify(row.attributes)}` : '';
        return `${type}${row.label}${attrs}`;
      });
      lines.push(`  observations: ${obs.join('; ')}`);
    }
    if (entry.extraction_text_excerpt && !entry.observations?.length) lines.push(`  extraction_text_excerpt: ${entry.extraction_text_excerpt}`);
  }
  return clip(lines.join('\n'), Math.max(600, Math.floor(Number(maxChars) || 1400)), { mode: 'middle' });
}
