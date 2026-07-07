import fs from 'node:fs';
import path from 'node:path';
import {
  buildRoomDocumentViewInvalidation,
  renderRoomDocumentMocFiles,
} from './room_markdown_moc.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function safeId(value = '') {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 120) || 'unknown';
}

function safeRelativeFile(value = '') {
  const clean = String(value || '').replace(/\\+/g, '/').replace(/^\/+/, '').replace(/\.\.+/g, '.');
  const parts = clean.split('/').filter(Boolean).map((part) => part.replace(/[^a-zA-Z0-9가-힣._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'file');
  return parts.join('/') || 'note.md';
}

function slugify(value = '', fallback = 'note') {
  const slug = cleanText(value || fallback, { lower: true, maxLen: 120 })
    .replace(/[^a-z0-9가-힣._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function dateOf(value = '') {
  const raw = String(value || '');
  const d = raw ? new Date(raw) : new Date();
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function classifyEventCategory(event = {}) {
  const row = asObject(event);
  const type = cleanText(row.event_type || row.eventType || row.type || '', { lower: true, maxLen: 160 });
  const command = cleanText(row.command || '', { lower: true, maxLen: 80 });
  const goal = cleanText(row.goal || row.text || asObject(row.extra).goal || '', { lower: true, maxLen: 300 });
  const hay = `${type} ${command} ${goal}`;
  if (/room|preset|package|profile|evolution|composition/.test(hay)) return 'room-setting';
  if (/memory|remember|correction|correct/.test(hay)) return 'memory-governance';
  if (/skill|tool|artifact|file|test|build|patch|code|구현|패치|테스트/.test(hay)) return 'execution-skill';
  if (/loop|team|agent|council|handoff|topology/.test(hay)) return 'agent-topology';
  if (/research|paper|논문|실험|evaluation|benchmark/.test(hay)) return 'research-work';
  return 'operations';
}

function eventTitle(event = {}) {
  const row = asObject(event);
  const type = cleanText(row.event_type || row.eventType || row.type || 'room_event', { maxLen: 80 });
  const command = cleanText(row.command || '', { maxLen: 80 });
  const goal = cleanText(row.goal || asObject(row.extra).goal || row.text || '', { maxLen: 100 });
  return [command || type, goal].filter(Boolean).join(' · ') || type;
}

function roomDocsRoot(chatId, { rootDir = process.env.DDALGGAK_ROOM_DOCS_DIR || 'runs/room_docs' } = {}) {
  return path.resolve(process.cwd(), rootDir, safeId(chatId));
}

export function readRoomDocumentManifest(chatId, { rootDir = process.env.DDALGGAK_ROOM_DOCS_DIR || 'runs/room_docs' } = {}) {
  const file = path.join(roomDocsRoot(chatId, { rootDir }), 'moc-manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function materializeRoomDocumentMocPack({ chatId = 'unknown', pack = {}, events = [], rootDir = process.env.DDALGGAK_ROOM_DOCS_DIR || 'runs/room_docs' } = {}) {
  const dir = roomDocsRoot(chatId, { rootDir });
  fs.mkdirSync(dir, { recursive: true });
  const files = renderRoomDocumentMocFiles(pack);
  for (const file of files) {
    const rel = safeRelativeFile(file.path || 'note.md');
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, String(file.content || ''), 'utf8');
  }
  const now = new Date().toISOString();
  const invalidation = buildRoomDocumentViewInvalidation(pack, { materializedAt: now, events });
  const manifest = {
    schema_version: 'ddalggak.room_docs_manifest/v1',
    chat_id: String(chatId || ''),
    materialized_at: now,
    file_count: files.length,
    files: files.map((file) => ({ path: safeRelativeFile(file.path || ''), bytes: Buffer.byteLength(String(file.content || ''), 'utf8') })),
    dependencies: {
      room_usage_events: asArray(events).length,
      source_layers: ['room_profile', 'room_usage_events', 'memory_candidates', 'skills', 'protocols', 'topology'],
    },
    invalidation,
  };
  fs.writeFileSync(path.join(dir, 'moc-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, root: dir, manifest, files_written: files.length };
}

export function buildMaterializedRoomDocsInvalidation({ chatId = 'unknown', pack = {}, events = [], rootDir = process.env.DDALGGAK_ROOM_DOCS_DIR || 'runs/room_docs' } = {}) {
  const manifest = readRoomDocumentManifest(chatId, { rootDir });
  const materializedAt = manifest?.materialized_at || null;
  return buildRoomDocumentViewInvalidation(pack, { materializedAt, events });
}

export function isActionNoteEvent(event = {}) {
  const type = cleanText(asObject(event).event_type || asObject(event).eventType || asObject(event).type || '', { lower: true, maxLen: 160 });
  const command = cleanText(asObject(event).command || '', { lower: true, maxLen: 80 });
  return Boolean(
    /work_depth|loop|room_applied|room_suggested|preset|package|memory|correct|council|topology|materialization|artifact|review|skill|docs_sync/.test(type)
    || /^\/(loop|l|team|room|memory|correct|council|skill|task)/.test(command),
  );
}

export function appendRoomActionNoteFromEvent({ chatId = 'unknown', event = {}, rootDir = process.env.DDALGGAK_ROOM_DOCS_DIR || 'runs/room_docs' } = {}) {
  if (!isActionNoteEvent(event)) return null;
  const row = asObject(event);
  const dir = roomDocsRoot(chatId || row.chat_id || 'unknown', { rootDir });
  const actionDir = path.join(dir, 'action');
  fs.mkdirSync(actionDir, { recursive: true });
  const date = dateOf(row.ts || row.created_at || row.updated_at);
  const category = classifyEventCategory(row);
  const title = eventTitle(row);
  const stamp = String(row.ts || new Date().toISOString()).replace(/[:.]/g, '-');
  const basename = `${date}-${slugify(category)}-${slugify(title, 'event')}-${stamp.slice(11, 19)}.md`.slice(0, 220);
  const file = path.join(actionDir, basename.endsWith('.md') ? basename : `${basename}.md`);
  if (fs.existsSync(file)) return file;
  const content = [
    `# ${title}`,
    '',
    `- date: ${date}`,
    `- category: ${category}`,
    `- event_type: ${cleanText(row.event_type || row.eventType || row.type || '', { maxLen: 120 }) || '(unknown)'}`,
    row.command ? `- command: ${cleanText(row.command, { maxLen: 120 })}` : '',
    row.room?.package_id ? `- package: ${cleanText(row.room.package_id, { maxLen: 120 })}` : '',
    asObject(row.extra).depth ? `- depth: ${cleanText(asObject(row.extra).depth, { maxLen: 80 })}` : '',
    asObject(row.extra).max_iterations ? `- max_iterations: ${asObject(row.extra).max_iterations}` : '',
    '- raw transcript copied: false',
    '',
    '## Summary',
    cleanText(row.goal || asObject(row.extra).summary || title, { maxLen: 1000 }) || '(empty)',
    '',
    '## MOC impact',
    `- Update \`moc-by-date.md\` under ${date}.`,
    `- Update \`moc-by-category.md\` under ${category}.`,
    '- Mark docs/MOC materialized views stale until `/room docs sync` refreshes them.',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(file, content, 'utf8');
  fs.appendFileSync(path.join(dir, 'action-journal.jsonl'), `${JSON.stringify({ path: path.relative(dir, file), ts: row.ts || new Date().toISOString(), event_type: row.event_type || row.type || '', category })}\n`, 'utf8');
  return file;
}

export function formatRoomDocsSyncResultForTelegram(result = {}) {
  const manifest = asObject(result.manifest);
  return [
    '🗂️ Room docs synced',
    '',
    `files written: ${Number(result.files_written || 0)}`,
    result.root ? `root: ${result.root}` : '',
    manifest.materialized_at ? `materialized_at: ${manifest.materialized_at}` : '',
    '',
    'Generated views:',
    ...asArray(manifest.files).slice(0, 12).map((file) => `- ${file.path} · ${file.bytes} bytes`),
  ].filter(Boolean).join('\n');
}
