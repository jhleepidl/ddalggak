import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';

function safe(value = '') {
  return String(value || '').trim();
}

function ensureDir(dirPath = '') {
  if (!dirPath) return '';
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function localMemoryDir(jobDir = '') {
  const clean = safe(jobDir);
  if (!clean) return '';
  return ensureDir(path.join(clean, 'local_memory'));
}

function roleDir(jobDir = '') {
  const base = localMemoryDir(jobDir);
  return base ? ensureDir(path.join(base, 'role_summaries')) : '';
}

function normalizeRoleKey(roleKey = '') {
  const clean = safe(roleKey).toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  if (!clean) return '';
  if (/^_+$/.test(clean)) return '';
  return clean;
}

function roleFile(jobDir = '', roleKey = '') {
  const dir = roleDir(jobDir);
  const clean = normalizeRoleKey(roleKey);
  if (!dir || !clean) return '';
  return path.join(dir, `${clean}.md`);
}

function deltaFile(jobDir = '') {
  const base = localMemoryDir(jobDir);
  return base ? path.join(base, 'iteration_delta.md') : '';
}

function readText(filePath = '') {
  try {
    return filePath && fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function writeText(filePath = '', text = '') {
  try {
    if (!filePath) return;
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
  } catch {}
}

function normalizeBody(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .join('\n');
}

function parseIsoTimestamp(value = '') {
  const clean = safe(value);
  if (!clean) return 0;
  const ms = Date.parse(clean);
  return Number.isFinite(ms) ? ms : 0;
}

function parseTimestampedEntries(text = '') {
  const raw = String(text || '').replace(/^# .*?\n+/, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const heading = String(line || '').match(/^##\s+([^·\n]+?)\s+·\s+(.+)$/);
    if (heading) {
      if (current) entries.push(current);
      current = {
        heading: String(heading[0] || '').trim(),
        ts: String(heading[1] || '').trim(),
        actor: String(heading[2] || '').trim(),
        body: [],
      };
      continue;
    }
    if (!current) continue;
    const clean = String(line || '').trim();
    if (!clean) continue;
    current.body.push(clean);
  }
  if (current) entries.push(current);
  return entries;
}

function formatTimestampedEntries(entries = [], { keep = 6, maxChars = 2200 } = {}) {
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const heading = safe(entry?.heading);
    const body = Array.isArray(entry?.body) ? entry.body.map((line) => String(line || '').trim()).filter(Boolean) : [];
    const chunk = [heading, ...body].filter(Boolean).join('\n');
    if (chunk) rows.push(chunk);
  }
  return compactBullets(rows, { keep, maxChars });
}

function filterEntriesSince(entries = [], sinceTs = '') {
  const threshold = parseIsoTimestamp(sinceTs);
  if (!threshold) return Array.isArray(entries) ? entries : [];
  const filtered = (Array.isArray(entries) ? entries : []).filter((entry) => parseIsoTimestamp(entry?.ts) >= threshold);
  return filtered.length > 0 ? filtered : [];
}

function compactBullets(lines = [], { keep = 8, maxChars = 1800 } = {}) {
  const deduped = [];
  const seen = new Set();
  for (const value of Array.isArray(lines) ? lines : []) {
    const clean = normalizeBody(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(clean);
  }
  const tail = deduped.slice(Math.max(0, deduped.length - Math.max(1, keep)));
  let text = tail.join('\n\n');
  if (text.length > maxChars) text = clip(text, maxChars);
  return text;
}

function buildEntry({ heading = '', fields = [] } = {}) {
  const parts = [];
  if (heading) parts.push(`## ${heading}`);
  for (const field of Array.isArray(fields) ? fields : []) {
    const clean = normalizeBody(field);
    if (clean) parts.push(clean);
  }
  return parts.join('\n');
}

export function readRoleSummary({ jobDir = '', roleId = '', agentId = '', sinceTs = '' } = {}) {
  const candidates = [roleId, agentId].map((value) => normalizeRoleKey(value)).filter(Boolean);
  for (const key of candidates) {
    const entries = parseTimestampedEntries(readText(roleFile(jobDir, key)));
    if (entries.length === 0) continue;
    const filtered = filterEntriesSince(entries, sinceTs);
    const text = formatTimestampedEntries(filtered.length > 0 ? filtered : entries, { keep: 6, maxChars: 2200 });
    if (text) return text;
  }
  return '';
}

export function readIterationDelta({ jobDir = '', sinceTs = '' } = {}) {
  const entries = parseTimestampedEntries(readText(deltaFile(jobDir)));
  if (entries.length === 0) return '';
  const filtered = filterEntriesSince(entries, sinceTs);
  return formatTimestampedEntries(filtered.length > 0 ? filtered : entries, { keep: 8, maxChars: 2400 });
}

export function updateIterationDelta({ jobDir = '', roleId = '', agentId = '', goal = '', output = '' } = {}) {
  const cleanJobDir = safe(jobDir);
  const cleanOutput = clip(safe(output).replace(/\s+/g, ' '), 320);
  if (!cleanJobDir || !cleanOutput) return null;
  const filePath = deltaFile(cleanJobDir);
  const existingBody = normalizeBody(readText(filePath).replace(/^# .*?\n+/, ''));
  const ts = new Date().toISOString();
  const actor = safe(roleId || agentId || 'agent');
  const nextEntry = buildEntry({
    heading: `${ts} · ${actor}`,
    fields: [
      safe(goal) ? `- changed focus: ${clip(safe(goal), 180)}` : '',
      `- delta: ${cleanOutput}`,
    ],
  });
  const merged = compactBullets([existingBody, nextEntry], { keep: 8, maxChars: 2400 });
  writeText(filePath, `# iteration delta\n\n${merged}\n`);
  return { ok: true };
}

export function updateRoleSummary({
  jobDir = '',
  roleId = '',
  agentId = '',
  goal = '',
  output = '',
  provider = '',
  model = '',
} = {}) {
  const cleanJobDir = safe(jobDir);
  const cleanGoal = clip(safe(goal), 240);
  const cleanOutput = clip(safe(output).replace(/\s+/g, ' '), 480);
  if (!cleanJobDir || !cleanOutput) return null;
  const keys = Array.from(new Set([
    normalizeRoleKey(roleId),
    normalizeRoleKey(agentId),
  ].filter(Boolean)));
  if (keys.length === 0) return null;
  const ts = new Date().toISOString();
  const heading = `${ts} · ${safe(roleId || agentId || 'agent')}`;
  const detail = buildEntry({
    heading,
    fields: [
      cleanGoal ? `- goal: ${cleanGoal}` : '',
      `- output: ${cleanOutput}`,
      safe(provider) || safe(model) ? `- model: ${[safe(provider), safe(model)].filter(Boolean).join('/')}` : '',
    ],
  });
  for (const key of keys) {
    const filePath = roleFile(cleanJobDir, key);
    const existingBody = normalizeBody(readText(filePath).replace(/^# .*?\n+/, ''));
    const merged = compactBullets([existingBody, detail], { keep: 6, maxChars: 2200 });
    writeText(filePath, `# role summary · ${key}\n\n${merged}\n`);
  }
  updateIterationDelta({ jobDir: cleanJobDir, roleId, agentId, goal, output });
  return { ok: true, keys };
}
