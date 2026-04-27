import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';

export const ARTIFACT_OBSERVATIONS_FILE = 'artifact_observations.jsonl';
const OBSERVATION_CONFIDENCE_DEFAULT = 0.55;

function clean(value = '') {
  return String(value || '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJsonlAppend(filePath = '', payload = {}) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {}
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
      .filter(Boolean);
  } catch {
    return [];
  }
}

function observationPath(jobDir = '') {
  const dir = clean(jobDir);
  return dir ? path.join(dir, ARTIFACT_OBSERVATIONS_FILE) : '';
}

function uploadManifestPath(jobDir = '') {
  const dir = clean(jobDir);
  return dir ? path.join(dir, 'workspace', 'uploads', 'manifest.jsonl') : '';
}

function normalizeWorkspacePath(value = '') {
  return clean(value).replace(/\\/g, '/');
}

function trimLabelNoise(value = '') {
  return clean(value)
    .replace(/^[-–—•\s]+/, '')
    .replace(/["“”'`*]+/g, '')
    .replace(/^(?:네|아니요|아니오|죄송하지만|제가 보기에는|제가 확인한 결과|보내주신|첨부된|해당|이|그)\s*/g, '')
    .replace(/(?:사진|이미지|음식|메뉴|파일|상차림|영양성분|영양 정보|기준|으로 보입니다|로 보입니다|입니다|같습니다)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelKey(value = '') {
  return trimLabelNoise(value).toLowerCase();
}

function splitLabels(value = '') {
  let src = clean(value);
  if (!src) return [];

  // For phrases like "된장찌개가 아니라 햄버거", callers that are extracting a
  // positive label should keep only the replacement portion. The rejected part
  // is captured separately by correctionRe.
  const notIndex = src.search(/\s*아니라\s*/);
  if (notIndex >= 0) {
    src = src.slice(notIndex).replace(/^\s*아니라\s*/, '');
  }

  src = src
    .replace(/["“”'`*]+/g, '')
    .replace(/사진|이미지|음식|메뉴|파일|상차림|영양성분|영양 정보|기준|으로 보입니다|로 보입니다|입니다|같습니다/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!src) return [];

  return src
    .split(/[,/＋+]\s*|\s+(?:그리고|및|또는|or|and)\s+|\s*와\s+|\s*과\s+/i)
    .map((item) => trimLabelNoise(item).replace(/^(?:몇 가지|기본|일반적인|대략적인)\s+/, '').trim())
    .filter((item) => item.length >= 2 && item.length <= 40)
    .filter((item) => !/(?:아니라|잘못|틀렸|혼동)/.test(item))
    .filter((item) => !/^(네|아니요|아니오|제가|분석한|보내주신|첨부된|해당|일반적인|대략적인|정정|결과)$/.test(item));
}

function uniqueStrings(values = [], { max = 12, exclude = [] } = {}) {
  const seen = new Set((Array.isArray(exclude) ? exclude : []).map(labelKey).filter(Boolean));
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = trimLabelNoise(raw);
    if (!value) continue;
    const key = labelKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function observationStatusPriority(status = '') {
  const normalized = clean(status).toLowerCase();
  if (/verified_after_user_challenge|user_confirmed|human_confirmed|corrected|retraction/.test(normalized)) return 40;
  if (/verified|confirmed/.test(normalized)) return 30;
  if (/candidate_observation|candidate|agent_output/.test(normalized)) return 10;
  return 0;
}

function timestampMs(value = '') {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

function numericConfidence(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function chooseBetterObservationRow(current, candidate) {
  if (!current) return candidate;
  const currentPriority = observationStatusPriority(current.status);
  const candidatePriority = observationStatusPriority(candidate.status);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }
  const currentConfidence = numericConfidence(current.confidence, 0);
  const candidateConfidence = numericConfidence(candidate.confidence, 0);
  if (candidateConfidence !== currentConfidence) {
    return candidateConfidence > currentConfidence ? candidate : current;
  }
  return timestampMs(candidate.ts) >= timestampMs(current.ts) ? candidate : current;
}

export function loadUploadedArtifacts(jobDir = '', { limit = 12 } = {}) {
  const rows = readJsonl(uploadManifestPath(jobDir));
  const cleanLimit = Math.max(1, Math.floor(Number(limit) || 12));
  return rows.slice(-cleanLimit).map((row) => {
    const item = asObject(row);
    return {
      ts: clean(item.ts),
      kind: clean(item.kind || item.upload_kind || item.uploadKind),
      upload_kind: clean(item.upload_kind || item.uploadKind),
      filename: clean(item.filename || item.fileName),
      workspace_path: normalizeWorkspacePath(item.workspace_path || item.workspacePath),
      sha256: clean(item.sha256),
      upload_note: clean(item.upload_note || item.uploadNote),
      message_id: Number.isFinite(Number(item.message_id || item.messageId)) ? Number(item.message_id || item.messageId) : undefined,
    };
  }).filter((row) => row.workspace_path);
}

export function loadArtifactObservations(jobDir = '', { limit = 50 } = {}) {
  const cleanLimit = Math.max(1, Math.floor(Number(limit) || 50));
  return readJsonl(observationPath(jobDir)).slice(-cleanLimit).map((row) => ({ ...asObject(row), workspace_path: normalizeWorkspacePath(row?.workspace_path || row?.workspacePath) })).filter((row) => row.workspace_path);
}

export function recordUploadedArtifactContext(jobDir = '', uploadRecord = {}) {
  const row = asObject(uploadRecord);
  const workspacePath = normalizeWorkspacePath(row.workspace_path || row.workspacePath);
  if (!clean(jobDir) || !workspacePath) return null;
  const payload = {
    ts: new Date().toISOString(),
    event: 'artifact_uploaded',
    workspace_path: workspacePath,
    filename: clean(row.filename || row.fileName),
    upload_kind: clean(row.upload_kind || row.uploadKind || row.kind),
    sha256: clean(row.sha256),
    upload_note: clean(row.upload_note || row.uploadNote),
    telegram_message_id: Number.isFinite(Number(row.message_id || row.telegram_message_id || row.telegramMessageId))
      ? Number(row.message_id || row.telegram_message_id || row.telegramMessageId)
      : undefined,
  };
  safeJsonlAppend(observationPath(jobDir), payload);
  return payload;
}

function extractObservationLabels(output = '') {
  const text = clean(output);
  if (!text) return { positive: [], negative: [] };
  const positive = [];
  const negative = [];

  const correctionRe = /([^\n.。]{2,80}?)(?:이|가|은|는)?\s*아니라\s*(?:\*\*)?([^\n.。*]{2,90}?)(?:\*\*)?\s*(?:사진|이미지|음식|메뉴|으로|로|입니다|보입니다|같습니다)/ig;
  let match;
  while ((match = correctionRe.exec(text)) !== null) {
    negative.push(...splitLabels(match[1]));
    positive.push(...splitLabels(match[2]));
  }

  const menuRe = /(?:메뉴|음식|사진|이미지)(?:은|는|이|가)?\s*(?:\*\*)?([^\n.。*]{2,100}?)(?:\*\*)?\s*(?:으로|로)?\s*(?:보입니다|같습니다|입니다)/ig;
  while ((match = menuRe.exec(text)) !== null) {
    positive.push(...splitLabels(match[1]));
  }

  const photoRe = /([^\n.。]{2,80}?)\s*사진(?:으로|처럼|입니다|으로 보입니다|로 보입니다)/ig;
  while ((match = photoRe.exec(text)) !== null) {
    positive.push(...splitLabels(match[1]));
  }

  const negativeUnique = uniqueStrings(negative, { max: 8 });
  const positiveUnique = uniqueStrings(positive, { max: 8, exclude: negativeUnique });
  return {
    positive: positiveUnique,
    negative: negativeUnique,
  };
}

export function recordArtifactObservationFromAgentOutput(jobDir = '', output = '', options = {}) {
  const cleanJobDir = clean(jobDir);
  const text = clean(output);
  if (!cleanJobDir || !text) return null;
  const uploads = loadUploadedArtifacts(cleanJobDir, { limit: 8 });
  if (uploads.length === 0) return null;
  const mentioned = uploads.find((row) => row.workspace_path && text.includes(row.workspace_path));
  const latestImage = [...uploads].reverse().find((row) => /photo|image|jpg|jpeg|png|webp/i.test(`${row.upload_kind} ${row.filename} ${row.workspace_path}`));
  const artifact = mentioned || latestImage || uploads[uploads.length - 1];
  if (!artifact?.workspace_path) return null;
  if (!mentioned && !/(사진|이미지|음식|메뉴|영양|햄버거|땅콩|찌개|밥|샐러드|burger|peanut|food|image|photo)/i.test(text)) return null;

  const { positive, negative } = extractObservationLabels(text);
  if (positive.length === 0 && negative.length === 0) return null;
  const challenged = /(아니요|아니라|잘못|죄송|정정|틀렸|혼동|retract|correction)/i.test(text) || negative.length > 0;
  const payload = {
    ts: new Date().toISOString(),
    event: 'artifact_observation',
    workspace_path: artifact.workspace_path,
    filename: artifact.filename || path.basename(artifact.workspace_path),
    upload_kind: artifact.upload_kind || artifact.kind || 'artifact',
    observed_labels: positive,
    rejected_labels: negative,
    confidence: numericConfidence(options.confidence, challenged ? 0.72 : OBSERVATION_CONFIDENCE_DEFAULT),
    status: challenged ? 'verified_after_user_challenge' : 'candidate_observation',
    source: clean(options.source || 'agent_output'),
  };
  safeJsonlAppend(observationPath(cleanJobDir), payload);
  return payload;
}

function mergeObservationRowsForArtifact(rows = []) {
  const observationRows = rows.filter((row) => row.event === 'artifact_observation');
  if (observationRows.length === 0) return null;

  let best = null;
  const rejected = [];
  for (const row of observationRows) {
    rejected.push(...(Array.isArray(row.rejected_labels) ? row.rejected_labels : []));
    best = chooseBetterObservationRow(best, row);
  }
  if (!best) return null;

  const rejectedLabels = uniqueStrings(rejected, { max: 12 });
  const bestPriority = observationStatusPriority(best.status);
  const observedCandidates = [];
  for (const row of observationRows) {
    const rowPriority = observationStatusPriority(row.status);
    // Once a verified correction exists, do not let later lower-trust candidates
    // reintroduce a previous wrong label. Same-priority verified rows are merged.
    if (rowPriority === bestPriority) {
      observedCandidates.push(...(Array.isArray(row.observed_labels) ? row.observed_labels : []));
    }
  }

  return {
    ...best,
    observed_labels: uniqueStrings(observedCandidates.length ? observedCandidates : best.observed_labels, {
      max: 12,
      exclude: rejectedLabels,
    }),
    rejected_labels: rejectedLabels,
    confidence: numericConfidence(best.confidence, OBSERVATION_CONFIDENCE_DEFAULT),
    status: best.status || 'candidate_observation',
  };
}

export function latestObservationByArtifact(jobDir = '') {
  const uploads = loadUploadedArtifacts(jobDir, { limit: 12 });
  const observations = loadArtifactObservations(jobDir, { limit: 120 });
  const byPath = new Map();
  for (const row of observations) {
    if (row.event !== 'artifact_observation') continue;
    const key = normalizeWorkspacePath(row.workspace_path);
    if (!key) continue;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(row);
  }
  return uploads.map((upload) => ({ upload, observation: mergeObservationRowsForArtifact(byPath.get(upload.workspace_path) || []) }));
}

export function formatActiveArtifactContext(jobDir = '', { maxChars = 2200, limit = 5 } = {}) {
  const pairs = latestObservationByArtifact(jobDir).slice(-Math.max(1, Math.floor(Number(limit) || 5))).reverse();
  if (pairs.length === 0) return '';
  const lines = [
    '[ACTIVE ARTIFACT CONTEXT]',
    '- This block is non-optional runtime context. Prefer it over older working memory when the user says "방금", "해당 이미지", "해당 음식", or "올렸던 이미지".',
    '- Do not replace verified artifact labels with older labels from compacted memory.',
  ];
  for (const { upload, observation } of pairs) {
    lines.push(`- artifact: ${upload.workspace_path}`);
    if (upload.upload_note) lines.push(`  note: ${upload.upload_note}`);
    if (upload.sha256) lines.push(`  sha256: ${upload.sha256.slice(0, 16)}…`);
    if (observation?.observed_labels?.length) lines.push(`  verified_or_latest_labels: ${observation.observed_labels.join(', ')}`);
    if (observation?.rejected_labels?.length) lines.push(`  rejected_previous_labels: ${observation.rejected_labels.join(', ')}`);
    if (observation?.status) lines.push(`  observation_status: ${observation.status}`);
  }
  return clip(lines.join('\n'), Math.max(600, Math.floor(Number(maxChars) || 2200)), { mode: 'middle' });
}
