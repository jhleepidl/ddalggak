import fs from 'node:fs';
import path from 'node:path';

import { normalizeKnowledgeBaseProfile } from '../knowledge_base/profile.js';

const PROFILE_FILE = 'knowledge_base_profile.json';
const DEFAULT_ROOT_DOC = 'core_memory.md';
const START_MARKER = '<!-- ddalggak:tracking-files:view v1 -->';
const END_MARKER = '<!-- /ddalggak:tracking-files:view -->';

function clean(value = '', { lower = false } = {}) {
  const out = String(value || '').trim();
  return lower ? out.toLowerCase() : out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeRead(filePath = '') {
  try { return filePath && fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : ''; } catch { return ''; }
}

function safeJsonParse(text = '') {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

function sharedDir(jobDir = '') {
  return path.join(jobDir, 'shared');
}

function profilePath(jobDir = '') {
  return path.join(sharedDir(jobDir), PROFILE_FILE);
}

function loadProfile(jobDir = '') {
  const parsed = safeJsonParse(safeRead(profilePath(jobDir)));
  return parsed ? normalizeKnowledgeBaseProfile(parsed) : null;
}

function toRelativePath(jobDir = '', filePath = '') {
  const raw = clean(filePath);
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return raw.replace(/\\/g, '/');
  try {
    const rel = path.relative(jobDir, raw).replace(/\\/g, '/');
    return rel && !rel.startsWith('..') ? rel : raw.replace(/\\/g, '/');
  } catch {
    return raw.replace(/\\/g, '/');
  }
}

function fileNameToSharedPath(name = '') {
  const fileName = clean(name);
  if (!fileName) return '';
  if (fileName.includes('/') || fileName.includes('\\')) return fileName.replace(/\\/g, '/');
  return `shared/${fileName}`;
}

function rowKey(row = {}) {
  return clean(row.path || row.file_name || row.name, { lower: true });
}

function upsertRow(rowsByPath, row = {}) {
  const key = rowKey(row);
  if (!key) return;
  const existing = rowsByPath.get(key) || {};
  const next = {
    ...existing,
    ...row,
    semantic_slots: [...new Set([...asArray(existing.semantic_slots), ...asArray(row.semantic_slots)].map((entry) => clean(entry)).filter(Boolean))],
    surface_ids: [...new Set([...asArray(existing.surface_ids), ...asArray(row.surface_ids)].map((entry) => clean(entry)).filter(Boolean))],
    kinds: [...new Set([...asArray(existing.kinds), ...asArray(row.kinds)].map((entry) => clean(entry)).filter(Boolean))],
    stewards: [...new Set([...asArray(existing.stewards), ...asArray(row.stewards)].map((entry) => clean(entry)).filter(Boolean))],
    statuses: [...new Set([...asArray(existing.statuses), clean(row.status)].filter(Boolean))],
  };
  if (!next.description) next.description = existing.description || row.description || row.purpose || row.lens || '';
  rowsByPath.set(key, next);
}

function collectProfileRows({ jobDir = '', profile = null } = {}) {
  const rows = new Map();
  const normalized = profile || loadProfile(jobDir);
  for (const doc of asArray(normalized?.docs)) {
    const fileName = clean(doc.file_name);
    if (!fileName) continue;
    upsertRow(rows, {
      path: fileNameToSharedPath(fileName),
      file_name: fileName,
      description: clean(doc.purpose || doc.title || 'Knowledge base surface.'),
      semantic_slots: [doc.doc_id].filter(Boolean),
      surface_ids: [doc.surface_id || doc.surfaceId].filter(Boolean),
      kinds: ['profile_doc'],
      stewards: asArray(doc.target_roles || doc.targetRoles),
      status: 'profile',
    });
  }
  return rows;
}

function surfaceStatus(jobDir = '', relativePath = '') {
  if (!relativePath) return '';
  try {
    const fullPath = path.isAbsolute(relativePath) ? relativePath : path.join(jobDir, relativePath);
    return fs.existsSync(fullPath) ? 'active' : 'planned';
  } catch {
    return 'planned';
  }
}

function collectTopologyRows({ jobDir = '', topology = null } = {}) {
  const rows = new Map();
  for (const surface of asArray(topology?.surfaces)) {
    const id = clean(surface.id || surface.surface_id || surface.surfaceId);
    const relativePath = toRelativePath(jobDir, surface.path || surface.file_path || surface.filePath || '');
    if (!relativePath) continue;
    upsertRow(rows, {
      path: relativePath,
      file_name: relativePath.split('/').pop(),
      description: clean(surface.lens || surface.description || surface.kind || id || 'Memory surface.'),
      semantic_slots: [],
      surface_ids: [id].filter(Boolean),
      kinds: [surface.kind].filter(Boolean),
      stewards: asArray(surface.steward || surface.stewards),
      status: surfaceStatus(jobDir, relativePath),
      write_mode: clean(surface.write_mode || surface.writeMode),
    });
  }
  return rows;
}

function mergeRows(...maps) {
  const out = new Map();
  for (const rows of maps) {
    for (const row of rows.values()) upsertRow(out, row);
  }
  return Array.from(out.values()).sort((a, b) => {
    const aPath = clean(a.path);
    const bPath = clean(b.path);
    const aCore = /(^|\/)core_memory\.md$/i.test(aPath) ? 0 : 1;
    const bCore = /(^|\/)core_memory\.md$/i.test(bPath) ? 0 : 1;
    if (aCore !== bCore) return aCore - bCore;
    const aShared = aPath.startsWith('shared/') ? 0 : 1;
    const bShared = bPath.startsWith('shared/') ? 0 : 1;
    if (aShared !== bShared) return aShared - bShared;
    return aPath.localeCompare(bPath);
  });
}

function renderRow(row = {}) {
  const pathLabel = clean(row.path).replace(/^shared\//, '');
  const description = clean(row.description) || 'Memory surface.';
  const extras = [];
  if (asArray(row.semantic_slots).length > 1) extras.push(`semantic slots: ${row.semantic_slots.join(', ')}`);
  else if (asArray(row.semantic_slots).length === 1 && !asArray(row.surface_ids).includes(row.semantic_slots[0])) extras.push(`semantic slot: ${row.semantic_slots[0]}`);
  if (asArray(row.surface_ids).length > 0) extras.push(`surfaces: ${row.surface_ids.join(', ')}`);
  if (asArray(row.kinds).length > 0 && !asArray(row.kinds).includes('profile_doc')) extras.push(`kind: ${row.kinds.join(', ')}`);
  if (asArray(row.stewards).length > 0) extras.push(`stewards: ${row.stewards.join(', ')}`);
  if (clean(row.write_mode)) extras.push(`write: ${row.write_mode}`);
  const statuses = asArray(row.statuses).filter((entry) => entry && entry !== 'profile');
  if (statuses.length > 0) extras.push(`status: ${statuses.join('/')}`);
  return `- ${pathLabel}: ${description}${extras.length ? ` (${extras.join('; ')})` : ''}`;
}

export function buildTrackingFilesView({ jobDir = '', topology = null, profile = null } = {}) {
  const normalizedProfile = profile || loadProfile(jobDir);
  const rows = mergeRows(
    collectProfileRows({ jobDir, profile: normalizedProfile }),
    collectTopologyRows({ jobDir, topology: asObject(topology) }),
  );
  const mode = clean(topology?.mode || 'unknown');
  const stress = Number(topology?.stress?.score || 0);
  const header = [
    '## Tracking files',
    START_MARKER,
    `> Generated from current memory topology${mode && mode !== 'unknown' ? ` (${mode}, stress=${stress.toFixed(2)})` : ''}. Do not append duplicate rows here; this section is replaced on topology refresh.`,
    '',
  ];
  const body = rows.length > 0
    ? rows.map(renderRow)
    : ['- core_memory.md: Compact memory surface.'];
  return `${header.join('\n')}${body.join('\n')}\n${END_MARKER}`;
}

function findTrackingRootDoc(jobDir = '', profile = null) {
  const dir = sharedDir(jobDir);
  const normalized = profile || loadProfile(jobDir);
  const profileFiles = asArray(normalized?.docs).map((doc) => clean(doc.file_name)).filter(Boolean);
  const candidates = [
    process.env.MEMORY_COMPACT_SEED_FILE,
    DEFAULT_ROOT_DOC,
    ...profileFiles,
  ].map((entry) => clean(entry)).filter(Boolean);
  for (const name of [...new Set(candidates)]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

export function replaceTrackingFilesSection(markdown = '', view = '') {
  const text = String(markdown || '');
  const nextView = String(view || '').trim();
  if (!nextView) return text;
  const markerRe = new RegExp(`## Tracking files\\n${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
  if (markerRe.test(text)) return text.replace(markerRe, nextView);
  const headingRe = /## Tracking files\n[\s\S]*?(?=\n##\s+|\n#\s+|$)/m;
  if (headingRe.test(text)) return text.replace(headingRe, `${nextView}\n`);
  const trimmed = text.trimEnd();
  return `${trimmed}${trimmed ? '\n\n' : ''}${nextView}\n`;
}

export function syncTrackingFilesView({ jobDir = '', topology = null, profile = null } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return { updated: false, reason: 'missing_job_dir' };
  const rootPath = findTrackingRootDoc(cleanJobDir, profile);
  if (!rootPath) return { updated: false, reason: 'missing_tracking_root' };
  const current = safeRead(rootPath);
  const view = buildTrackingFilesView({ jobDir: cleanJobDir, topology, profile });
  const next = replaceTrackingFilesSection(current, view);
  if (next === current) return { updated: false, reason: 'unchanged', path: rootPath };
  fs.writeFileSync(rootPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return { updated: true, path: rootPath };
}
