import fs from 'node:fs';
import path from 'node:path';
import { normalizeLanguageMetadata } from './language_policy.js';
import { buildCanonicalProjectionRequest, upsertCanonicalProjectionRequest } from './canonical_projection.js';

export const PROPOSAL_LOG_FILE = 'proposals.jsonl';
export const PROPOSAL_STATE_FILE = 'proposal_state.json';
export const PROPOSAL_ACTIONS_FILE = 'proposal_actions.jsonl';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function nowIso() {
  return new Date().toISOString();
}
function localMemoryDir(jobDir = '') {
  return path.join(String(jobDir || ''), 'local_memory');
}
function filePath(jobDir = '', name = '') {
  return path.join(localMemoryDir(jobDir), name);
}
function safeRead(file = '') {
  try { return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}
function safeReadJson(file = '', fallback = null) {
  try { const raw = safeRead(file); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJson(file = '', value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function appendJsonl(file = '', value = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}
function readJsonl(file = '', { limit = 5000 } = {}) {
  const raw = safeRead(file);
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {}
  }
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}
function hash(value = '') {
  let h = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
function safeId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '') || '';
}
function normalizeRisk(value = '') {
  const risk = clean(value).toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(risk) ? risk : 'medium';
}
function normalizeStatus(value = '') {
  const status = clean(value).toLowerCase();
  return [
    'pending_review', 'auto_committed', 'committed', 'approved', 'rejected', 'stale',
    'superseded', 'blocked', 'candidate', 'needs_evidence', 'review_required',
  ].includes(status) ? status : 'pending_review';
}
function proposalFingerprint(row = {}) {
  const p = asObject(row);
  return hash([
    p.kind,
    p.title,
    p.summary,
    p.source,
    p.source_id,
    p.recommended_action,
  ].map((x) => clean(x)).join('\n'));
}
export function normalizeProposal(input = {}, defaults = {}) {
  const row = { ...asObject(defaults), ...asObject(input) };
  const kind = safeId(row.proposal_kind || row.kind_label || (row.kind === 'ddalggak_runtime_proposal' ? '' : row.kind) || row.type || 'memory_candidate');
  const title = clean(row.title || kind.replace(/_/g, ' '));
  const summary = clean(row.summary || row.text || row.claim || row.description || title);
  const source = clean(row.source || row.origin || defaults.source || 'runtime');
  const sourceId = clean(row.source_id || row.sourceId || defaults.source_id || '');
  const proposedAt = clean(row.proposed_at || row.created_at || defaults.proposed_at || nowIso());
  const language = normalizeLanguageMetadata({
    text: row.source_original_text || row.original_text || row.text || row.summary || summary,
    displayText: row.display_text || row.displayText || summary,
    locale: row.original_language || row.source_original_language || row.user_surface_locale || defaults.user_surface_locale || '',
    canonicalTextEn: row.canonical_text_en || row.canonical_summary_en || row.canonicalSummaryEn || '',
    source: 'proposal_log',
  });
  const projection = buildCanonicalProjectionRequest({
    object_type: kind,
    source_id: row.proposal_id || row.id || sourceId,
    source_ref: sourceId,
    title,
    source_original_text: language.source_original_text,
    source_original_language: language.source_original_language,
    display_text: language.display_text,
    canonical_text_en: language.canonical_text_en,
    metadata: row.payload || {},
  });
  const canonicalTextEn = projection.canonical_text_en || language.canonical_text_en;
  const proposalId = clean(row.proposal_id || row.proposalId || row.id)
    || `proposal_${kind}_${proposalFingerprint({ ...row, kind, title, summary, source, source_id: sourceId })}`;
  return {
    kind: 'ddalggak_runtime_proposal',
    schema_version: 1,
    proposal_id: proposalId,
    proposal_kind: kind,
    // Keep `kind_label` and legacy `kind` payload compatibility without losing the envelope kind.
    kind_label: kind,
    title,
    summary,
    source_original_text: language.source_original_text,
    source_original_language: language.source_original_language,
    original_language: language.original_language,
    display_text: language.display_text,
    canonical_language: language.canonical_language,
    canonical_text_en: canonicalTextEn,
    canonical_summary_en: canonicalTextEn,
    canonical_projection_status: projection.canonical_projection_status || language.canonical_projection_status,
    canonical_projection_id: projection.projection_id,
    projection_method: projection.projection_method,
    user_surface_locale: language.original_language,
    risk: normalizeRisk(row.risk),
    status: normalizeStatus(row.status),
    recommended_action: clean(row.recommended_action || row.action || 'review_in_goc'),
    source,
    source_id: sourceId,
    run_id: clean(row.run_id || row.runId || defaults.run_id || ''),
    actor: clean(row.actor || defaults.actor || 'runtime'),
    evidence_status: clean(row.evidence_status || row.evidenceStatus || ''),
    evidence: asArray(row.evidence).slice(0, 20),
    payload: asObject(row.payload),
    raw: asObject(row.raw),
    proposed_at: proposedAt,
    updated_at: clean(row.updated_at || proposedAt),
  };
}
function loadState(jobDir = '') {
  const state = safeReadJson(filePath(jobDir, PROPOSAL_STATE_FILE), null);
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    state.proposals = asObject(state.proposals);
    return state;
  }
  return { kind: 'ddalggak_proposal_state', schema_version: 1, updated_at: nowIso(), proposals: {} };
}
function writeState(jobDir = '', state = {}) {
  const row = asObject(state);
  row.kind = row.kind || 'ddalggak_proposal_state';
  row.schema_version = row.schema_version || 1;
  row.updated_at = nowIso();
  row.proposals = asObject(row.proposals);
  writeJson(filePath(jobDir, PROPOSAL_STATE_FILE), row);
  return row;
}
export function appendProposalToLog({ jobDir = '', proposal = {}, defaults = {}, dedupe = true } = {}) {
  const d = clean(jobDir);
  if (!d) throw new Error('jobDir is required');
  const normalized = normalizeProposal(proposal, defaults);
  upsertCanonicalProjectionRequest({
    jobDir: d,
    item: {
      object_type: normalized.proposal_kind,
      source_ref: normalized.source_id,
      source_id: normalized.proposal_id,
      title: normalized.title,
      source_original_text: normalized.source_original_text,
      source_original_language: normalized.source_original_language,
      display_text: normalized.display_text,
      canonical_text_en: normalized.canonical_text_en,
      metadata: normalized.payload,
    },
    actor: 'proposal_log',
  });
  const state = loadState(d);
  const existing = asObject(state.proposals[normalized.proposal_id]);
  const created = !existing.proposal_id;
  if (created || dedupe === false) appendJsonl(filePath(d, PROPOSAL_LOG_FILE), normalized);
  state.proposals[normalized.proposal_id] = {
    ...existing,
    proposal_id: normalized.proposal_id,
    proposal_kind: normalized.proposal_kind,
    title: normalized.title,
    summary: normalized.summary,
    risk: normalized.risk,
    status: existing.status ? normalizeStatus(existing.status) : normalized.status,
    recommended_action: normalized.recommended_action,
    source: normalized.source,
    source_id: normalized.source_id,
    run_id: normalized.run_id,
    evidence_status: normalized.evidence_status,
    source_original_language: normalized.source_original_language,
    canonical_projection_status: normalized.canonical_projection_status,
    canonical_projection_id: normalized.canonical_projection_id,
    projection_method: normalized.projection_method,
    proposed_at: existing.proposed_at || normalized.proposed_at,
    updated_at: nowIso(),
    log_created: created,
  };
  writeState(d, state);
  return { ok: true, created, proposal: { ...normalized, status: state.proposals[normalized.proposal_id].status }, state: state.proposals[normalized.proposal_id] };
}
export function appendProposalsToLog({ jobDir = '', proposals = [], defaults = {}, dedupe = true } = {}) {
  const results = asArray(proposals).map((proposal) => appendProposalToLog({ jobDir, proposal, defaults, dedupe }));
  return {
    ok: true,
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => !r.created).length,
    proposals: results.map((r) => r.proposal),
  };
}
export function updateProposalStatus({ jobDir = '', proposalId = '', status = '', actor = 'runtime', reason = '', action = '' } = {}) {
  const d = clean(jobDir);
  const id = clean(proposalId);
  if (!d) throw new Error('jobDir is required');
  if (!id) throw new Error('proposalId is required');
  const state = loadState(d);
  const current = asObject(state.proposals[id]);
  if (!current.proposal_id) throw new Error(`proposal not found: ${id}`);
  const nextStatus = normalizeStatus(status);
  const event = {
    ts: nowIso(),
    kind: 'proposal_status_changed',
    proposal_id: id,
    previous_status: current.status || 'pending_review',
    next_status: nextStatus,
    actor: clean(actor || 'runtime'),
    action: clean(action || nextStatus),
    reason: clean(reason),
  };
  state.proposals[id] = { ...current, status: nextStatus, updated_at: event.ts, last_action: event.action, last_reason: event.reason };
  writeState(d, state);
  appendJsonl(filePath(d, PROPOSAL_ACTIONS_FILE), event);
  return { ok: true, proposal: state.proposals[id], event };
}
export function readProposalLog({ jobDir = '', statuses = [], kinds = [], limit = 200, includeCommitted = false } = {}) {
  const d = clean(jobDir);
  if (!d) return { kind: 'ddalggak_proposal_log', proposals: [], summary: { proposal_count: 0 } };
  const state = loadState(d);
  const rows = readJsonl(filePath(d, PROPOSAL_LOG_FILE), { limit: Math.max(limit * 4, 1000) });
  const byId = new Map();
  for (const row of rows) {
    const normalized = normalizeProposal(row);
    byId.set(normalized.proposal_id, normalized);
  }
  for (const [id, patch] of Object.entries(asObject(state.proposals))) {
    const base = byId.get(id) || normalizeProposal({ proposal_id: id, ...asObject(patch) });
    byId.set(id, { ...base, ...asObject(patch), proposal_id: id });
  }
  const statusSet = new Set(asArray(statuses).map((x) => clean(x).toLowerCase()).filter(Boolean));
  const kindSet = new Set(asArray(kinds).map((x) => safeId(x)).filter(Boolean));
  const closedStatuses = new Set(['committed', 'auto_committed', 'rejected', 'stale', 'superseded']);
  let proposals = [...byId.values()].map((p) => ({ ...p, status: normalizeStatus(p.status), proposal_kind: safeId(p.proposal_kind || p.kind_label || p.kind) }));
  if (!includeCommitted) proposals = proposals.filter((p) => !closedStatuses.has(p.status));
  if (statusSet.size) proposals = proposals.filter((p) => statusSet.has(p.status));
  if (kindSet.size) proposals = proposals.filter((p) => kindSet.has(p.proposal_kind));
  proposals.sort((a, b) => clean(b.updated_at || b.proposed_at).localeCompare(clean(a.updated_at || a.proposed_at)));
  proposals = proposals.slice(0, Math.max(0, Number(limit) || 200));
  return {
    kind: 'ddalggak_proposal_log',
    schema_version: 1,
    generated_at: nowIso(),
    summary: summarizeProposals(proposals),
    proposals,
  };
}
export function summarizeProposals(proposals = []) {
  const rows = asArray(proposals);
  const byStatus = {};
  const byKind = {};
  for (const row of rows) {
    const status = normalizeStatus(row.status);
    const kind = safeId(row.proposal_kind || row.kind_label || row.kind || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return {
    proposal_count: rows.length,
    pending_review_count: rows.filter((p) => ['pending_review', 'review_required', 'needs_evidence', 'candidate'].includes(normalizeStatus(p.status))).length,
    high_risk_count: rows.filter((p) => ['high', 'critical'].includes(normalizeRisk(p.risk))).length,
    by_status: byStatus,
    by_kind: byKind,
  };
}
export function formatProposalLogForTelegram(snapshot = {}) {
  const summary = asObject(snapshot.summary);
  const rows = asArray(snapshot.proposals).slice(0, 12);
  const lines = [
    'Runtime proposal log',
    `- proposals: ${Number(summary.proposal_count || 0)}`,
    `- pending review: ${Number(summary.pending_review_count || 0)}`,
    `- high risk: ${Number(summary.high_risk_count || 0)}`,
  ];
  if (rows.length) {
    lines.push('', 'Pending:');
    for (const row of rows) lines.push(`- [${row.proposal_kind || row.kind_label || 'proposal'} · ${row.risk || 'risk'} · ${row.status || 'pending'}] ${clean(row.summary || row.title).slice(0, 180)}`);
  }
  return lines.join('\n');
}
