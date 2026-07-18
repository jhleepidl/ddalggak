import fs from 'node:fs';
import path from 'node:path';
import { assertNoSymlinkComponents, cleanText, isPathInside, sha256 } from './fs_utils.js';

const INTERNAL_SEGMENTS = new Set(['.git', '.codex', '.gemini', '.orchestrator', 'node_modules']);
const PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql', '.gql', '.env.example', '.properties',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanRelativePath(value = '') {
  const text = cleanText(value).replaceAll('\\', '/');
  if (!text || text.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return '';
  if (path.isAbsolute(text)) return '';
  const normalized = path.posix.normalize(text).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => INTERNAL_SEGMENTS.has(segment))) return '';
  return segments.join('/');
}

function isPreviewable(rel = '', stat = null) {
  const base = path.basename(rel).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (PREVIEW_EXTENSIONS.has(ext)) return true;
  if (base === 'dockerfile' || base === 'makefile' || base === 'license' || base === 'readme') return true;
  if (stat && Number(stat.size || 0) === 0) return true;
  return false;
}

function approvalState(contract = {}, artifact = {}) {
  const explicit = cleanText(artifact.approval_state || artifact.approval_status || '').toLowerCase();
  if (explicit) return explicit;
  const required = asArray(contract?.approval_policy?.require_for).map((item) => cleanText(item).toLowerCase());
  const requiresPublishApproval = required.some((item) => ['artifact', 'artifacts', 'publish', 'artifact_publish', 'artifact_delivery', 'external_delivery'].includes(item));
  return requiresPublishApproval ? 'pending' : 'not_required';
}

export function roomArtifactDeliveryLimits(env = process.env) {
  return {
    max_send_bytes: Math.max(1024, Number(env.ROOM_ARTIFACT_MAX_SEND_BYTES || 49 * 1024 * 1024)),
    max_preview_bytes: Math.max(1024, Math.min(1024 * 1024, Number(env.ROOM_ARTIFACT_PREVIEW_MAX_BYTES || 64 * 1024))),
  };
}

function candidateKey(value = '') {
  return cleanText(value).replaceAll('\\', '/').toLowerCase();
}

function normalizeCandidate(value = {}, fallback = {}) {
  const row = typeof value === 'string' ? { location: value } : asObject(value);
  const location = cleanRelativePath(row.location || row.path || row.uri || row.name || fallback.location || '');
  if (!location) return null;
  return {
    artifact_id: cleanText(row.artifact_id || row.id || fallback.artifact_id || ''),
    location,
    label: cleanText(row.label || row.title || row.description || fallback.label || path.basename(location)),
    kind: cleanText(row.kind || fallback.kind || 'file').toLowerCase(),
    description: cleanText(row.description || fallback.description || ''),
    provider: cleanText(row.provider || fallback.provider || ''),
    stage_id: cleanText(row.stage_id || fallback.stage_id || ''),
    receipt_hash: cleanText(row.receipt_hash || fallback.receipt_hash || ''),
    approval_state: cleanText(row.approval_state || fallback.approval_state || ''),
  };
}

function resolveWorkspaceFile(workspaceRoot = '', rel = '') {
  const root = path.resolve(cleanText(workspaceRoot));
  const cleanRel = cleanRelativePath(rel);
  if (!cleanRel) throw Object.assign(new Error('artifact path is not a safe Room workspace-relative path'), { code: 'ROOM_ARTIFACT_PATH_INVALID' });
  const abs = path.resolve(root, ...cleanRel.split('/'));
  if (!isPathInside(root, abs)) throw Object.assign(new Error('artifact path escapes the Room workspace'), { code: 'ROOM_ARTIFACT_PATH_ESCAPE' });
  assertNoSymlinkComponents(abs, { stopAt: root });
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`artifact file does not exist: ${cleanRel}`), { code: 'ROOM_ARTIFACT_NOT_FOUND' });
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('artifact symbolic links are not deliverable'), { code: 'ROOM_ARTIFACT_SYMLINK_BLOCKED' });
  if (!stat.isFile()) throw Object.assign(new Error('artifact selection is not a regular file'), { code: 'ROOM_ARTIFACT_NOT_FILE' });
  const real = fs.realpathSync(abs);
  if (!isPathInside(root, real)) throw Object.assign(new Error('artifact real path escapes the Room workspace'), { code: 'ROOM_ARTIFACT_REALPATH_ESCAPE' });
  return { rel: cleanRel, abs: real, stat };
}

export function buildRoomNativeArtifactIndex({
  workspaceRoot = '',
  checkpointArtifacts = [],
  receipts = [],
  contract = null,
  limit = 24,
  env = process.env,
} = {}) {
  const candidates = [];
  const receiptByLocation = new Map();
  for (const receipt of asArray(receipts)) {
    for (const item of asArray(receipt?.reported?.artifacts)) {
      const normalized = normalizeCandidate(item, {
        provider: receipt.provider,
        stage_id: receipt.stage_id,
        receipt_hash: receipt.receipt_hash,
      });
      if (!normalized) continue;
      receiptByLocation.set(candidateKey(normalized.location), normalized);
      candidates.push(normalized);
    }
  }
  for (const item of asArray(checkpointArtifacts)) {
    const normalized = normalizeCandidate(item, receiptByLocation.get(candidateKey(typeof item === 'string' ? item : item?.location || item?.path || item?.uri || '')) || {});
    if (normalized) candidates.push(normalized);
  }
  for (const requested of asArray(contract?.requested_artifacts)) {
    const normalized = normalizeCandidate(requested, { kind: 'requested_artifact' });
    if (normalized) candidates.push(normalized);
  }
  for (const receipt of asArray(receipts)) {
    for (const change of asArray(receipt?.workspace?.files_changed)) {
      if (!['added', 'modified'].includes(cleanText(change?.change).toLowerCase())) continue;
      const normalized = normalizeCandidate(change?.path || '', {
        kind: 'workspace_file',
        provider: receipt.provider,
        stage_id: receipt.stage_id,
        receipt_hash: receipt.receipt_hash,
      });
      if (normalized) candidates.push(normalized);
    }
  }

  const { max_send_bytes: maxSendBytes } = roomArtifactDeliveryLimits(env);
  const rows = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.location);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let resolved;
    try {
      resolved = resolveWorkspaceFile(workspaceRoot, candidate.location);
    } catch (error) {
      rows.push({
        ...candidate,
        artifact_id: candidate.artifact_id || `artifact-${sha256(key).slice(0, 12)}`,
        available: false,
        sendable: false,
        previewable: false,
        error_code: error?.code || 'ROOM_ARTIFACT_UNAVAILABLE',
        error: cleanText(error?.message || error),
        approval_state: approvalState(contract, candidate),
        contract_revision: contract?.contract_revision || null,
        contract_hash: contract?.contract_hash || null,
      });
      if (rows.length >= Math.max(1, Math.min(100, Number(limit) || 24))) break;
      continue;
    }
    rows.push({
      ...candidate,
      artifact_id: candidate.artifact_id || `artifact-${sha256(key).slice(0, 12)}`,
      available: true,
      sendable: Number(resolved.stat.size || 0) <= maxSendBytes,
      previewable: isPreviewable(resolved.rel, resolved.stat),
      bytes: Number(resolved.stat.size || 0),
      modified_at: new Date(resolved.stat.mtimeMs).toISOString(),
      relative_path: resolved.rel,
      absolute_path: resolved.abs,
      approval_state: approvalState(contract, candidate),
      contract_revision: contract?.contract_revision || null,
      contract_hash: contract?.contract_hash || null,
    });
    if (rows.length >= Math.max(1, Math.min(100, Number(limit) || 24))) break;
  }
  return rows;
}

export function resolveRoomNativeArtifactSelection(artifacts = [], selection = '') {
  const rows = asArray(artifacts);
  const clean = cleanText(selection);
  if (!clean) throw Object.assign(new Error('artifact selection is required'), { code: 'ROOM_ARTIFACT_SELECTION_REQUIRED' });
  if (/^\d+$/.test(clean)) {
    const row = rows[Number(clean) - 1];
    if (row) return row;
  }
  const key = candidateKey(clean);
  const row = rows.find((item) => candidateKey(item.artifact_id) === key || candidateKey(item.relative_path || item.location) === key);
  if (!row) throw Object.assign(new Error(`unknown artifact selection: ${clean}`), { code: 'ROOM_ARTIFACT_SELECTION_UNKNOWN' });
  return row;
}

export function previewRoomNativeArtifact(artifact = {}, { env = process.env } = {}) {
  if (!artifact?.available || !artifact?.absolute_path) throw Object.assign(new Error(artifact?.error || 'artifact is unavailable'), { code: artifact?.error_code || 'ROOM_ARTIFACT_UNAVAILABLE' });
  if (!artifact.previewable) throw Object.assign(new Error('this artifact type cannot be previewed as text; use /send instead'), { code: 'ROOM_ARTIFACT_PREVIEW_UNSUPPORTED' });
  const { max_preview_bytes: maxBytes } = roomArtifactDeliveryLimits(env);
  const stat = fs.statSync(artifact.absolute_path);
  const readBytes = Math.min(Number(stat.size || 0), maxBytes);
  const fd = fs.openSync(artifact.absolute_path, 'r');
  const buffer = Buffer.alloc(readBytes);
  try {
    if (readBytes > 0) fs.readSync(fd, buffer, 0, readBytes, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buffer.includes(0)) throw Object.assign(new Error('binary content cannot be previewed as text; use /send instead'), { code: 'ROOM_ARTIFACT_PREVIEW_BINARY' });
  return {
    artifact,
    text: buffer.toString('utf8'),
    truncated: Number(stat.size || 0) > readBytes,
    bytes_read: readBytes,
    total_bytes: Number(stat.size || 0),
  };
}
