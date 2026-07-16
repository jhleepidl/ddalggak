import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loopRunDir } from './loop_run_store.js';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function clip(value = '', max = 1200) { const text = clean(value); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function eventId(prefix = 'discussion') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`; }
function filePath(jobDir, loopId) { return path.join(loopRunDir(jobDir, loopId), 'discussion_ledger.jsonl'); }

export function normalizeDiscussionRecord(record = {}) {
  const type = clean(record.record_type || record.recordType || record.type).toLowerCase();
  if (!['claim', 'objection', 'response', 'resolution', 'decision'].includes(type)) throw new Error(`unsupported discussion record type: ${type}`);
  return {
    kind: 'loop_discussion_record_v1',
    record_id: clean(record.record_id || record.recordId) || eventId(type),
    loop_id: clean(record.loop_id || record.loopId),
    record_type: type,
    parent_id: clean(record.parent_id || record.parentId) || undefined,
    claim_id: clean(record.claim_id || record.claimId) || undefined,
    actor: clean(record.actor) || undefined,
    role_id: clean(record.role_id || record.roleId).toLowerCase() || undefined,
    text: clip(record.text || record.summary || '', 1800),
    evidence_refs: asArray(record.evidence_refs || record.evidenceRefs).map(clean).filter(Boolean).slice(0, 24),
    severity: ['blocking', 'major', 'minor', 'note'].includes(clean(record.severity).toLowerCase()) ? clean(record.severity).toLowerCase() : 'note',
    status: clean(record.status || (type === 'objection' ? 'open' : type === 'resolution' ? 'resolved' : 'active')).toLowerCase(),
    metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
    ts: clean(record.ts) || new Date().toISOString(),
  };
}

export function appendDiscussionRecord({ jobDir = '', loopId = '', record = {} } = {}) {
  const normalized = normalizeDiscussionRecord({ ...record, loop_id: loopId || record.loop_id });
  if (!normalized.loop_id) throw new Error('loopId is required');
  const file = filePath(jobDir, normalized.loop_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export function readDiscussionLedger({ jobDir = '', loopId = '' } = {}) {
  try {
    return fs.readFileSync(filePath(jobDir, loopId), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

export function deriveDiscussionState({ records = [] } = {}) {
  const rows = asArray(records);
  const resolvedIds = new Set(rows.filter((row) => row.record_type === 'resolution').map((row) => clean(row.parent_id || row.metadata?.resolves_id)).filter(Boolean));
  const objections = rows.filter((row) => row.record_type === 'objection').map((row) => ({ ...row, derived_status: resolvedIds.has(row.record_id) || row.status === 'resolved' ? 'resolved' : 'open' }));
  const open = objections.filter((row) => row.derived_status === 'open');
  return {
    claim_count: rows.filter((row) => row.record_type === 'claim').length,
    objection_count: objections.length,
    open_objection_count: open.length,
    blocking_open_count: open.filter((row) => row.severity === 'blocking').length,
    decision_count: rows.filter((row) => ['decision', 'resolution'].includes(row.record_type)).length,
    open_objections: open.slice(-12),
    recent_decisions: rows.filter((row) => ['decision', 'resolution'].includes(row.record_type)).slice(-12),
  };
}

export function formatDiscussionDigest({ records = [], maxChars = 2800 } = {}) {
  const state = deriveDiscussionState({ records });
  const lines = [
    '## Discussion ledger',
    `- claims: ${state.claim_count}`,
    `- objections: ${state.objection_count}`,
    `- open blocking: ${state.blocking_open_count}`,
    '',
    '### Open objections',
    ...(state.open_objections.length ? state.open_objections.map((row) => `- [${row.severity}] ${row.text}`) : ['- none']),
    '',
    '### Recent resolutions / decisions',
    ...(state.recent_decisions.length ? state.recent_decisions.map((row) => `- ${row.text}`) : ['- none']),
  ];
  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export default { normalizeDiscussionRecord, appendDiscussionRecord, readDiscussionLedger, deriveDiscussionState, formatDiscussionDigest };
