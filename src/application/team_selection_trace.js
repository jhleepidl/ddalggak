import fs from 'node:fs';
import path from 'node:path';
import { buildTeamCandidateSummary } from './team_candidate_generator.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function nowIso() { return new Date().toISOString(); }

function defaultTracePath() {
  return process.env.TEAM_SELECTION_TRACE_LOG || process.env.DDALGGAK_TEAM_SELECTION_TRACE_LOG || path.join(process.cwd(), 'runs', 'team_selection_traces.jsonl');
}

function safeAppendJsonl(filePath = '', row = {}) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

export function buildTeamSelectionTrace({ request = '', stress = {}, candidates = [], selectedCandidate = null, policy = 'cheapest_sufficient', source = 'team_portfolio' } = {}) {
  const selectedId = clean(selectedCandidate?.candidate_id || selectedCandidate?.id || '');
  return {
    kind: 'team_selection_trace_v1',
    selection_id: `tsel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    source,
    request_excerpt: clean(request).slice(0, 500),
    stress: asObject(stress),
    policy,
    selected_candidate_id: selectedId || null,
    candidates: asArray(candidates).map((candidate) => buildTeamCandidateSummary(candidate)),
  };
}

export function appendTeamSelectionTrace(trace = {}, { filePath = '' } = {}) {
  const row = asObject(trace);
  if (!Object.keys(row).length) return null;
  const target = filePath || defaultTracePath();
  safeAppendJsonl(target, row);
  return { ...row, trace_path: target };
}

export function readRecentTeamSelectionTraces({ filePath = '', limit = 20 } = {}) {
  const target = filePath || defaultTracePath();
  try {
    if (!fs.existsSync(target)) return [];
    const rows = String(fs.readFileSync(target, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return rows.slice(-Math.max(1, Number(limit || 20))).reverse();
  } catch {
    return [];
  }
}
