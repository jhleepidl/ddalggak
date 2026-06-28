import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  recordVisualArtifactExtractionResult,
  loadVisualArtifactCapsules,
} from './visual_artifact_memory_capsule.js';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function normalizePath(value = '') { return clean(value).replace(/\\/g, '/'); }

function truthyEnv(name = '') {
  const raw = clean(process.env[name]).toLowerCase();
  return ['1', 'true', 'yes', 'on', 'auto'].includes(raw);
}


function splitArgs(raw = '') {
  const src = clean(raw);
  if (!src) return [];
  try {
    const parsed = JSON.parse(src);
    if (Array.isArray(parsed)) return parsed.map((v) => clean(v)).filter(Boolean);
  } catch {}
  return src.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) || [];
}

function buildCommandExtractorFromEnv() {
  const command = clean(process.env.DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_COMMAND);
  if (!command) return null;
  const rawArgs = splitArgs(process.env.DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_ARGS || '{image}');
  return async ({ uploadRecord = {}, prompt = '' } = {}) => {
    const imagePath = clean(uploadRecord.local_path || uploadRecord.localPath || uploadRecord.workspace_path || uploadRecord.workspacePath);
    const args = rawArgs.map((arg) => arg
      .replaceAll('{image}', imagePath)
      .replaceAll('{prompt}', prompt)
      .replaceAll('{note}', clean(uploadRecord.upload_note || uploadRecord.uploadNote)));
    const { stdout } = await execFileAsync(command, args, {
      timeout: Number(process.env.DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_TIMEOUT_MS || 15000),
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        VISUAL_ARTIFACT_PATH: imagePath,
        VISUAL_ARTIFACT_NOTE: clean(uploadRecord.upload_note || uploadRecord.uploadNote),
        VISUAL_ARTIFACT_PROMPT: prompt,
      },
    });
    return { text: clean(stdout), source: 'visual_extraction_command' };
  };
}

function uploadLooksVisual(uploadRecord = {}) {
  const row = asObject(uploadRecord);
  const text = `${row.upload_kind || row.uploadKind || row.kind || ''} ${row.filename || ''} ${row.workspace_path || row.workspacePath || ''}`;
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
    .replace(/(?:메뉴|사진|이미지|캡처)?\s*[#:_-]?\s*\d+\s*$/i, (m) => (/미에뜨|menu|메뉴/i.test(source) ? ' 메뉴' : ''))
    .replace(/\s+/g, ' ')
    .trim() || 'uploaded visual artifact';
}

export function shouldRunBoundedVisualExtraction(uploadRecord = {}, opts = {}) {
  if (!uploadLooksVisual(uploadRecord)) return false;
  if (opts.force === true) return true;
  if (truthyEnv('DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_ENABLED')) return true;
  return false;
}

export function buildVisualArtifactExtractionPrompt(uploadRecord = {}, opts = {}) {
  const row = asObject(uploadRecord);
  const workspacePath = normalizePath(row.workspace_path || row.workspacePath || row.local_path || row.localPath);
  const note = clean(row.upload_note || row.uploadNote);
  const maxItems = Number.isFinite(Number(opts.maxItems)) ? Math.max(1, Math.floor(Number(opts.maxItems))) : 80;
  return [
    'Extract contextual visual artifact memory from the uploaded image.',
    'Do not assume the image is a menu, receipt, chart, or document unless the visible content supports it.',
    'Return facts visible in the image only. Do not make recommendations or infer user preferences.',
    'Preferred JSON shape when possible:',
    '{"schema_hint":"menu|receipt|screenshot|figure|unknown", "contextual_summary":"...", "observations":[{"label":"...", "object_type":"...", "attributes":{"price":"..."}, "confidence":0.0}]}',
    'Plain text is acceptable if JSON is not possible; keep it concise and mark uncertainty explicitly.',
    '',
    `artifact_path: ${workspacePath || '(unknown)'}`,
    note ? `upload_note: ${note}` : '',
    `max_observations: ${maxItems}`,
  ].filter(Boolean).join('\n');
}

export async function runBoundedVisualArtifactExtraction({ jobDir = '', uploadRecord = {}, extractor = null, timeoutMs = 15000, source = 'bounded_visual_extraction' } = {}) {
  const row = asObject(uploadRecord);
  if (!clean(jobDir) || !shouldRunBoundedVisualExtraction(row, { force: typeof extractor === 'function' })) {
    return { status: 'skipped' };
  }
  let effectiveExtractor = extractor;
  if (typeof effectiveExtractor !== 'function') effectiveExtractor = buildCommandExtractorFromEnv();
  if (typeof effectiveExtractor !== 'function') {
    return { status: 'pending_extractor_unconfigured' };
  }
  const started = Date.now();
  const prompt = buildVisualArtifactExtractionPrompt(row);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('visual extraction timed out')), Math.max(1000, Number(timeoutMs) || 15000));
  });
  try {
    const result = await Promise.race([
      Promise.resolve(effectiveExtractor({ uploadRecord: row, prompt, jobDir })),
      timeoutPromise,
    ]);
    const payload = result && typeof result === 'object' ? result : { text: clean(result) };
    const groupLabel = clean(payload.group_label || payload.groupLabel) || inferGroupLabel(row);
    const extraction = recordVisualArtifactExtractionResult(jobDir, {
      ...payload,
      group_label: groupLabel,
      source_image_paths: [normalizePath(row.workspace_path || row.workspacePath)].filter(Boolean),
      source,
      status: clean(payload.status || 'extracted_by_bounded_extractor'),
    });
    return {
      status: extraction ? 'extracted' : 'no_items_extracted',
      duration_ms: Date.now() - started,
      extraction,
    };
  } catch (error) {
    return { status: 'failed', duration_ms: Date.now() - started, error: clean(error?.message || error || 'unknown') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function summarizeVisualArtifactExtractionState(jobDir = '') {
  const capsules = loadVisualArtifactCapsules(jobDir, { limit: 40 });
  const pending = capsules.filter((row) => !row.observations?.length && !row.extraction_text_excerpt).length;
  const extracted = capsules.filter((row) => row.observations?.length || row.extraction_text_excerpt).length;
  return {
    schema_version: 'ddalggak.visual_artifact_extraction_state/v2',
    visual_context_count: capsules.length,
    pending_extraction_count: pending,
    extracted_count: extracted,
    latest_visual_contexts: capsules.slice(-5),
  };
}
