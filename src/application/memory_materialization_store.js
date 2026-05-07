import fs from 'node:fs';
import path from 'node:path';

const MODULES_DIR = 'memory_modules';
const MODULE_INDEX_FILE = 'memory_modules_index.json';
const MODULE_EVENTS_FILE = 'memory_module_events.jsonl';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function safeId(value = '') {
  const raw = clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
  return raw || 'memory_module';
}
function safeRead(filePath = '') {
  try { return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; } catch { return ''; }
}
function safeReadJson(filePath = '', fallback = null) {
  try { const raw = safeRead(filePath); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function appendJsonl(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}
function localMemoryDir(jobDir = '') { return path.join(String(jobDir || ''), 'local_memory'); }
function modulesRoot(jobDir = '') { return path.join(localMemoryDir(jobDir), MODULES_DIR); }
function candidateRows(candidate = {}) { return asArray(asObject(candidate.backfill_preview).rows); }
function normalizeColumnType(type = '') {
  const t = clean(type).toLowerCase();
  if (['text', 'string', 'datetime', 'date', 'json', 'integer', 'real', 'boolean'].includes(t)) return t;
  if (t === 'number' || t === 'float' || t === 'double') return 'real';
  if (t === 'int') return 'integer';
  return 'text';
}
function normalizeSchema(candidate = {}) {
  const schema = asObject(candidate.proposed_schema);
  const table = safeId(schema.table || candidate.domain || 'memory_entries');
  const columns = asArray(schema.columns).map((col) => {
    const row = asObject(col);
    return {
      name: safeId(row.name || ''),
      type: normalizeColumnType(row.type || 'text'),
      role: row.role || undefined,
      nullable: row.nullable !== false,
      default: row.default,
    };
  }).filter((col) => col.name);
  if (!columns.find((col) => col.name === 'id')) columns.unshift({ name: 'id', type: 'text', role: 'primary_key', nullable: false });
  if (!columns.find((col) => col.name === 'source_ref')) columns.push({ name: 'source_ref', type: 'text', nullable: true });
  if (!columns.find((col) => col.name === 'confidence')) columns.push({ name: 'confidence', type: 'real', nullable: true });
  if (!columns.find((col) => col.name === 'review_state')) columns.push({ name: 'review_state', type: 'text', nullable: true });
  return { table, columns, create_table_sql: schema.create_table_sql || '' };
}
function rowForSchema(rawRow = {}, schema = {}) {
  const raw = asObject(rawRow);
  const out = {};
  for (const col of asArray(schema.columns)) {
    const name = col.name;
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(raw, name)) out[name] = raw[name];
    else if (Object.prototype.hasOwnProperty.call(raw, 'preview') && name === 'notes') out[name] = raw.preview;
    else if (Object.prototype.hasOwnProperty.call(raw, 'source') && name === 'source_ref') out[name] = raw.source;
    else if (col.default !== undefined) out[name] = col.default;
    else out[name] = null;
  }
  if (!out.id) out.id = safeId(raw.id || `${schema.table}_${Math.random().toString(36).slice(2, 10)}`);
  if (raw.review_state && !out.review_state) out.review_state = raw.review_state;
  if (raw.confidence != null && out.confidence == null) out.confidence = raw.confidence;
  return out;
}
function buildOperationContracts(candidate = {}) {
  return asArray(candidate.proposed_operations).map((op) => {
    const row = asObject(op);
    return {
      name: safeId(row.name || ''),
      kind: clean(row.kind || 'runtime_safe_operation'),
      required_fields: asArray(row.required_fields),
      filters: asArray(row.filters),
      patch_fields: asArray(row.patch_fields),
      group_by: asArray(row.group_by),
      enabled: false,
      approval_required: true,
    };
  }).filter((op) => op.name);
}
function buildModuleManifest({ candidate = {}, jobDir = '', reason = 'shadow_materialization' } = {}) {
  const schema = normalizeSchema(candidate);
  const moduleId = safeId(candidate.domain || candidate.candidate_id || schema.table || 'memory_module');
  const createdAt = nowIso();
  return {
    kind: 'ddalggak_memory_module_manifest',
    schema_version: 1,
    module_id: moduleId,
    domain: clean(candidate.domain || moduleId),
    title: clean(candidate.title || candidate.domain || moduleId),
    status: 'shadow',
    canonical_memory_switch: false,
    raw_memory_retained: true,
    generated_code_execution: false,
    created_at: createdAt,
    updated_at: createdAt,
    reason,
    source_job_dir: jobDir ? path.basename(jobDir) : '',
    source_candidate_id: clean(candidate.candidate_id || ''),
    materialization_score: Number(candidate.materialization_score || 0),
    recommendation: clean(candidate.recommendation || ''),
    proposed_store: clean(candidate.proposed_store || 'shadow_table_jsonl'),
    schema,
    operations: buildOperationContracts(candidate),
    publish_policy: asObject(candidate.publish_policy),
    safety: {
      mode: 'shadow_only',
      approval_required_for: ['enable_write_operations', 'canonical_write_path', 'raw_memory_deletion', 'public_publish'],
      safe_automatic_steps: ['module_manifest', 'schema_snapshot', 'shadow_rows_jsonl'],
    },
    paths: {
      manifest: 'module_manifest.json',
      schema: 'schema.json',
      operations: 'operations.json',
      rows: 'rows.jsonl',
      review: 'review_queue.jsonl',
    },
  };
}
function loadModuleIndex(jobDir = '') {
  return safeReadJson(path.join(localMemoryDir(jobDir), MODULE_INDEX_FILE), { kind: 'ddalggak_memory_module_index', schema_version: 1, updated_at: nowIso(), modules: [] });
}
function writeModuleIndex(jobDir = '', index = {}) {
  const row = asObject(index);
  row.kind = row.kind || 'ddalggak_memory_module_index';
  row.schema_version = row.schema_version || 1;
  row.updated_at = nowIso();
  row.modules = asArray(row.modules);
  writeJson(path.join(localMemoryDir(jobDir), MODULE_INDEX_FILE), row);
  return row;
}
function upsertModuleIndex(jobDir = '', manifest = {}, stats = {}) {
  const index = loadModuleIndex(jobDir);
  const modules = asArray(index.modules).filter((row) => row.module_id !== manifest.module_id);
  modules.push({
    module_id: manifest.module_id,
    domain: manifest.domain,
    title: manifest.title,
    status: manifest.status,
    table: manifest.schema?.table || '',
    row_count: Number(stats.row_count || 0),
    review_count: Number(stats.review_count || 0),
    high_confidence_count: Number(stats.high_confidence_count || 0),
    path: `${MODULES_DIR}/${manifest.module_id}/module_manifest.json`,
    updated_at: nowIso(),
  });
  index.modules = modules.sort((a, b) => String(a.module_id).localeCompare(String(b.module_id)));
  return writeModuleIndex(jobDir, index);
}
export function findMaterializationCandidate(plan = {}, selector = '') {
  const candidates = asArray(asObject(plan).candidates);
  const wanted = clean(selector).toLowerCase();
  if (!wanted) return candidates[0] || null;
  return candidates.find((c) => clean(c.domain).toLowerCase() === wanted || clean(c.candidate_id).toLowerCase() === wanted || clean(c.title).toLowerCase() === wanted) || null;
}
export function createShadowMemoryModule({ jobDir = '', candidate = {}, reason = 'shadow_materialization' } = {}) {
  const d = String(jobDir || '').trim();
  if (!d) throw new Error('jobDir is required');
  const c = asObject(candidate);
  if (!clean(c.domain) && !clean(asObject(c.proposed_schema).table)) throw new Error('candidate is required');
  const manifest = buildModuleManifest({ candidate: c, jobDir: d, reason });
  const root = path.join(modulesRoot(d), manifest.module_id);
  fs.mkdirSync(root, { recursive: true });
  const rows = candidateRows(c).map((row) => rowForSchema(row, manifest.schema));
  const reviewRows = rows.filter((row) => clean(row.review_state) !== 'high_confidence' && Number(row.confidence || 0) < 0.75);
  writeJson(path.join(root, 'module_manifest.json'), manifest);
  writeJson(path.join(root, 'schema.json'), manifest.schema);
  writeJson(path.join(root, 'operations.json'), { kind: 'ddalggak_memory_module_operations', module_id: manifest.module_id, operations: manifest.operations });
  fs.writeFileSync(path.join(root, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(root, 'review_queue.jsonl'), reviewRows.map((row) => JSON.stringify({ ...row, review_reason: 'low_confidence_or_ambiguous_backfill' })).join('\n') + (reviewRows.length ? '\n' : ''), 'utf8');
  const stats = {
    row_count: rows.length,
    review_count: reviewRows.length,
    high_confidence_count: rows.length - reviewRows.length,
  };
  upsertModuleIndex(d, manifest, stats);
  const event = { ts: nowIso(), kind: 'memory_module_shadow_created', module_id: manifest.module_id, domain: manifest.domain, stats, candidate_id: manifest.source_candidate_id };
  appendJsonl(path.join(localMemoryDir(d), MODULE_EVENTS_FILE), event);
  return { ok: true, manifest, stats, root, event };
}
export function listShadowMemoryModules({ jobDir = '' } = {}) {
  const index = loadModuleIndex(jobDir);
  return { ...index, modules: asArray(index.modules) };
}
export function formatShadowMemoryModuleResultForTelegram(result = {}) {
  const manifest = asObject(result.manifest), stats = asObject(result.stats);
  if (!manifest.module_id) return 'No memory module was created.';
  const ops = asArray(manifest.operations).slice(0, 5).map((op) => op.name).filter(Boolean);
  const lines = [
    '🧱 Shadow memory module created',
    `- module: ${manifest.title || manifest.module_id}`,
    `- domain: ${manifest.domain}`,
    `- status: ${manifest.status}`,
    `- table: ${manifest.schema?.table || '-'}`,
    `- rows: ${Number(stats.row_count || 0)} (${Number(stats.high_confidence_count || 0)} high confidence, ${Number(stats.review_count || 0)} review)`,
    `- canonical writes: disabled`,
    `- raw memory retained: yes`,
  ];
  if (ops.length) lines.push(`- functions drafted: ${ops.join(', ')}`);
  lines.push('', 'Next: review this module in GoC before enabling write functions or making it canonical.');
  return lines.join('\n');
}
export function formatShadowMemoryModuleListForTelegram(index = {}) {
  const modules = asArray(asObject(index).modules);
  if (!modules.length) return 'No shadow memory modules yet. Use /memory materialize-preview first, then /memory materialize shadow <domain>.';
  const lines = ['🧱 Memory modules'];
  modules.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.title || m.module_id} · ${m.status || 'shadow'} · table=${m.table || '-'} · rows=${Number(m.row_count || 0)} · review=${Number(m.review_count || 0)}`);
  });
  return lines.join('\n');
}
