import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { loopRunDir, readLoopRun, listLoopRuns, appendLoopRunEvent } from './loop_run_store.js';
import { readDiscussionLedger, deriveDiscussionState, formatDiscussionDigest } from './loop_discussion_ledger.js';

function clean(value = '') { return String(value || '').trim(); }
function ensureDir(dir = '') { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readText(file = '') { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function readJsonl(file = '') { return readText(file).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sha256Text(value = '') { return sha256Buffer(Buffer.from(String(value), 'utf8')); }
function writeJson(file = '', payload = {}) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function appendJsonl(file = '', payload = {}) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8'); }
function statSize(file = '') { try { return fs.statSync(file).size; } catch { return 0; } }
function clip(value = '', max = 1000) { const text = clean(value).replace(/\s+/g, ' '); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }

export function buildLoopMemoryPolicy(overrides = {}) {
  return {
    raw_trace: 'append_only',
    hot_projection: 'working_memory.json',
    warm_summary: 'compactions/*.json',
    cold_archive: 'cold_archive/*.gz',
    durable_promotion: 'proposal_only',
    compact_after_events: Math.max(20, Number(overrides.compact_after_events || 80) || 80),
    compact_after_bytes: Math.max(10_000, Number(overrides.compact_after_bytes || 48_000) || 48_000),
    keep_recent_events: Math.max(8, Number(overrides.keep_recent_events || 24) || 24),
    max_working_summary_chars: Math.max(1200, Number(overrides.max_working_summary_chars || 7000) || 7000),
    raw_retention_days: Math.max(1, Number(overrides.raw_retention_days || 30) || 30),
    allow_verified_raw_prune: overrides.allow_verified_raw_prune === true,
  };
}

export function inspectLoopMemoryPressure({ jobDir = '', loopId = '' } = {}) {
  const dir = loopRunDir(jobDir, loopId);
  const eventsFile = path.join(dir, 'events.jsonl');
  const discussionFile = path.join(dir, 'discussion_ledger.jsonl');
  const events = readJsonl(eventsFile);
  const discussion = readJsonl(discussionFile);
  const rawBytes = statSize(eventsFile) + statSize(discussionFile);
  const run = readLoopRun({ jobDir, loopId });
  const policy = buildLoopMemoryPolicy(run?.state?.spec?.memory_policy || {});
  const ratio = Math.max(events.length / policy.compact_after_events, rawBytes / policy.compact_after_bytes);
  const level = ratio >= 2 ? 'high' : ratio >= 1 ? 'medium' : 'low';
  return {
    kind: 'loop_memory_pressure_v1',
    loop_id: loopId,
    event_count: events.length,
    discussion_count: discussion.length,
    raw_bytes: rawBytes,
    pressure_ratio: Math.round(ratio * 1000) / 1000,
    pressure_level: level,
    compaction_recommended: ratio >= 1,
    policy,
  };
}

function buildWorkingSummary({ run, events, discussion, maxChars = 7000 } = {}) {
  const state = run.state;
  const d = deriveDiscussionState({ records: discussion });
  const milestones = (state.milestones || []).slice(-12);
  const recent = events.slice(-Math.max(8, Number(state.spec?.memory_policy?.keep_recent_events || 24)));
  const lines = [
    '# Loop Working Memory',
    '',
    `- loop_id: ${state.loop_id}`,
    `- objective: ${state.spec?.objective || ''}`,
    `- topology: ${state.spec?.topology?.label || state.spec?.topology?.topology_id || ''}`,
    `- status: ${state.status}`,
    `- current_stage: ${state.current_stage_id || ''}`,
    `- current_round: ${state.current_round || 1}/${state.spec?.budget_policy?.max_rounds || 1}`,
    `- open_blocking_issues: ${d.blocking_open_count}`,
    `- next_action: ${state.next_action || ''}`,
    '',
    '## Active constraints',
    ...((state.spec?.active_constraints || []).length ? state.spec.active_constraints.map((row) => `- ${row}`) : ['- none']),
    '',
    '## Milestones',
    ...(milestones.length ? milestones.map((row) => `- ${row.label}`) : ['- none']),
    '',
    formatDiscussionDigest({ records: discussion, maxChars: 2200 }),
    '',
    '## Recent execution events',
    ...(recent.length ? recent.map((row) => `- ${row.event_type}${row.role_id ? ` [${row.role_id}]` : ''}: ${clip(row.summary || row.actor || '', 320)}`) : ['- none']),
    '',
    '## Memory rule',
    '- Raw trace is evidence and is not copied into the prompt by default.',
    '- This working summary is the prompt-facing projection.',
    '- Durable Room memory is created only through reviewable promotion candidates.',
  ];
  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function compactLoopRunMemory({ jobDir = '', loopId = '', force = false } = {}) {
  const run = readLoopRun({ jobDir, loopId, includeEvents: true });
  if (!run) return { ok: false, reason: 'loop_not_found' };
  const pressure = inspectLoopMemoryPressure({ jobDir, loopId });
  if (!force && !pressure.compaction_recommended) return { ok: true, skipped: true, pressure };
  const dir = loopRunDir(jobDir, loopId);
  const discussion = readDiscussionLedger({ jobDir, loopId });
  const events = run.events || [];
  const policy = buildLoopMemoryPolicy(run.state?.spec?.memory_policy || {});
  const summary = buildWorkingSummary({ run, events, discussion, maxChars: policy.max_working_summary_chars });
  const compactionsDir = ensureDir(path.join(dir, 'compactions'));
  const index = fs.readdirSync(compactionsDir).filter((name) => name.endsWith('.json')).length + 1;
  const record = {
    kind: 'loop_memory_compaction_v1',
    compaction_id: `loop_compaction_${String(index).padStart(4, '0')}`,
    loop_id: loopId,
    created_at: new Date().toISOString(),
    source: {
      events_count: events.length,
      discussion_count: discussion.length,
      events_sha256: sha256Text(readText(path.join(dir, 'events.jsonl'))),
      discussion_sha256: sha256Text(readText(path.join(dir, 'discussion_ledger.jsonl'))),
    },
    pressure,
    summary_markdown: summary,
    destructive_changes: false,
  };
  const file = path.join(compactionsDir, `${record.compaction_id}.json`);
  writeJson(file, record);
  writeJson(path.join(dir, 'working_memory.json'), {
    kind: 'loop_working_memory_v1',
    loop_id: loopId,
    based_on_compaction: record.compaction_id,
    summary_markdown: summary,
    recent_event_ids: events.slice(-policy.keep_recent_events).map((row) => row.event_id),
    updated_at: record.created_at,
  });
  appendLoopRunEvent({ jobDir, loopId, eventType: 'memory_compacted', summary: `Working memory compacted (${events.length} events, ${pressure.raw_bytes} bytes)`, payload: { compaction_id: record.compaction_id, trace_ref: file }, source: 'loop_memory_manager' });
  return { ok: true, skipped: false, record, file, working_memory_path: path.join(dir, 'working_memory.json') };
}

export function buildLoopMemoryPromotionCandidates({ jobDir = '', loopId = '' } = {}) {
  const run = readLoopRun({ jobDir, loopId, includeEvents: true });
  if (!run) return [];
  const discussion = readDiscussionLedger({ jobDir, loopId });
  const candidates = [];
  for (const row of discussion) {
    if (!['resolution', 'decision'].includes(row.record_type)) continue;
    if (!clean(row.text)) continue;
    candidates.push({
      kind: 'room_memory_promotion_candidate_v1',
      candidate_id: `loop_mem_${sha256Text(`${loopId}\n${row.record_id}\n${row.text}`).slice(0, 16)}`,
      loop_id: loopId,
      candidate_type: row.record_type === 'decision' ? 'decision' : 'resolved_claim',
      text: row.text,
      evidence_refs: [row.record_id, ...(row.evidence_refs || [])],
      proposed_scope: 'room',
      status: 'pending_review',
      source: 'loop_discussion_ledger',
      created_at: new Date().toISOString(),
    });
  }
  const redirects = (run.events || []).filter((row) => row.event_type === 'user_control' && ['redirect', 'constraint_update'].includes(clean(row.payload?.control)));
  for (const row of redirects) {
    const text = clean(row.payload?.objective || row.payload?.text);
    if (!text) continue;
    candidates.push({
      kind: 'room_memory_promotion_candidate_v1',
      candidate_id: `loop_mem_${sha256Text(`${loopId}\n${row.event_id}\n${text}`).slice(0, 16)}`,
      loop_id: loopId,
      candidate_type: 'user_constraint_or_correction',
      text,
      evidence_refs: [row.event_id],
      proposed_scope: 'room',
      status: 'pending_review',
      source: 'loop_user_control',
      created_at: new Date().toISOString(),
    });
  }
  const seen = new Set();
  return candidates.filter((row) => { const key = row.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
}

export function archiveLoopRawTrace({ jobDir = '', loopId = '', allowRawPrune = false } = {}) {
  const dir = loopRunDir(jobDir, loopId);
  const archiveDir = ensureDir(path.join(dir, 'cold_archive'));
  const sourceFiles = ['events.jsonl', 'discussion_ledger.jsonl'].map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
  const rows = [];
  for (const source of sourceFiles) {
    const input = fs.readFileSync(source);
    const compressed = zlib.gzipSync(input, { level: 9 });
    const target = path.join(archiveDir, `${path.basename(source)}.gz`);
    fs.writeFileSync(target, compressed);
    const verified = zlib.gunzipSync(fs.readFileSync(target)).equals(input);
    if (!verified) throw new Error(`archive verification failed: ${source}`);
    rows.push({ source, target, source_bytes: input.length, archive_bytes: compressed.length, sha256: sha256Buffer(input), verified });
    if (allowRawPrune) fs.unlinkSync(source);
  }
  const manifest = { kind: 'loop_cold_archive_manifest_v1', loop_id: loopId, created_at: new Date().toISOString(), raw_pruned: allowRawPrune, files: rows };
  writeJson(path.join(archiveDir, 'manifest.json'), manifest);
  return manifest;
}

export function finalizeLoopMemory({ jobDir = '', loopId = '', archive = true, allowRawPrune = false } = {}) {
  const compaction = compactLoopRunMemory({ jobDir, loopId, force: true });
  const candidates = buildLoopMemoryPromotionCandidates({ jobDir, loopId });
  const dir = loopRunDir(jobDir, loopId);
  const candidateFile = path.join(dir, 'memory_promotion_candidates.jsonl');
  if (fs.existsSync(candidateFile)) fs.unlinkSync(candidateFile);
  for (const row of candidates) appendJsonl(candidateFile, row);
  const archiveManifest = archive ? archiveLoopRawTrace({ jobDir, loopId, allowRawPrune }) : null;
  const manifest = {
    kind: 'loop_memory_finalization_v1',
    loop_id: loopId,
    finalized_at: new Date().toISOString(),
    compaction_id: compaction.record?.compaction_id || null,
    promotion_candidate_count: candidates.length,
    promotion_policy: 'proposal_only',
    raw_archive: archiveManifest,
  };
  writeJson(path.join(dir, 'memory_finalization.json'), manifest);
  return { ok: true, compaction, candidates, archive: archiveManifest, manifest };
}



export function runLoopMemoryMaintenance({ jobDir = '', force = false, archiveTerminal = true, allowRawPrune = false, limit = 100 } = {}) {
  if (!clean(jobDir)) throw new Error('jobDir is required');
  const runs = listLoopRuns({ jobDir, limit: Math.max(1, Number(limit) || 100) });
  const report = {
    kind: 'loop_memory_maintenance_report_v1',
    job_dir: path.resolve(jobDir),
    checked_runs: runs.length,
    compacted: [],
    finalized: [],
    skipped: [],
    failures: [],
    created_at: new Date().toISOString(),
  };
  for (const run of runs) {
    const loopId = clean(run?.state?.loop_id);
    if (!loopId) continue;
    try {
      const terminal = ['completed', 'cancelled', 'failed'].includes(clean(run.state?.status).toLowerCase());
      const dir = loopRunDir(jobDir, loopId);
      const finalizedFile = path.join(dir, 'memory_finalization.json');
      if (terminal && archiveTerminal) {
        if (!force && fs.existsSync(finalizedFile)) {
          report.skipped.push({ loop_id: loopId, reason: 'already_finalized' });
          continue;
        }
        const finalized = finalizeLoopMemory({ jobDir, loopId, archive: true, allowRawPrune });
        report.finalized.push({ loop_id: loopId, promotion_candidate_count: finalized.candidates.length, raw_pruned: finalized.archive?.raw_pruned === true });
        continue;
      }
      const pressure = inspectLoopMemoryPressure({ jobDir, loopId });
      if (force || pressure.compaction_recommended) {
        const compacted = compactLoopRunMemory({ jobDir, loopId, force: true });
        report.compacted.push({ loop_id: loopId, compaction_id: compacted.record?.compaction_id || null, raw_bytes: pressure.raw_bytes });
      } else {
        report.skipped.push({ loop_id: loopId, reason: 'low_pressure' });
      }
    } catch (error) {
      report.failures.push({ loop_id: loopId, error: String(error?.message || error) });
    }
  }
  return report;
}

export function readLoopWorkingMemory({ jobDir = '', loopId = '' } = {}) {
  const file = path.join(loopRunDir(jobDir, loopId), 'working_memory.json');
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    return row && typeof row === 'object' ? row : null;
  } catch { return null; }
}

export function formatLoopWorkingMemoryProjection({ workingMemory = null, maxChars = 3200 } = {}) {
  if (!workingMemory?.summary_markdown) return '';
  const text = String(workingMemory.summary_markdown || '').trim();
  const max = Math.max(600, Number(maxChars) || 3200);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatLoopMemoryStatus({ jobDir = '', loopId = '' } = {}) {
  const p = inspectLoopMemoryPressure({ jobDir, loopId });
  return [
    '🧠 Loop memory',
    `- pressure: ${p.pressure_level} (${p.pressure_ratio})`,
    `- events: ${p.event_count}`,
    `- discussion records: ${p.discussion_count}`,
    `- raw bytes: ${p.raw_bytes}`,
    `- compaction: ${p.compaction_recommended ? 'recommended' : 'not needed'}`,
    '- raw trace: append-only evidence',
    '- prompt context: compacted working projection',
    '- durable memory: proposal-only',
  ].join('\n');
}

export default { buildLoopMemoryPolicy, inspectLoopMemoryPressure, compactLoopRunMemory, buildLoopMemoryPromotionCandidates, archiveLoopRawTrace, finalizeLoopMemory, runLoopMemoryMaintenance, readLoopWorkingMemory, formatLoopWorkingMemoryProjection, formatLoopMemoryStatus };
