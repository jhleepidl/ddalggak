import fs from 'node:fs';
import path from 'node:path';

import { clip, compactWithPinnedContext } from '../textutil.js';
import { formatActiveArtifactContext, loadArtifactObservations } from './artifact_context.js';
import { planMemoryTopology } from './memory_topology.js';
import { updateChatMemoryAnchor } from './chat_memory_anchor.js';
import { runLoopMemoryMaintenance } from './loop_memory_manager.js';

const IDLE_COMPACTION_CANDIDATES_FILE = 'idle_compaction_candidates.jsonl';
const IDLE_COMPACTION_SUMMARY_FILE = 'idle_compaction_summary.md';
const IDLE_MAINTENANCE_STATE_FILE = 'idle_maintenance_state.json';

function clean(value = '') {
  return String(value || '').trim();
}

function safeRead(filePath = '') {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function readJsonl(filePath = '') {
  return safeRead(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function sharedDir(jobDir = '') {
  const dir = path.join(jobDir, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localMemoryDir(jobDir = '') {
  const dir = path.join(jobDir, 'local_memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(filePath = '') {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJson(filePath = '', payload = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {}
}

function envBool(name = '', fallback = true) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function idleMaintenanceStatePath(jobDir = '') {
  return path.join(localMemoryDir(jobDir), IDLE_MAINTENANCE_STATE_FILE);
}

function formatRecentConversation(jobDir = '', { maxRows = 18, maxChars = 3000 } = {}) {
  const rows = readJsonl(path.join(jobDir, 'conversation.jsonl')).slice(-Math.max(1, Math.floor(Number(maxRows) || 18)));
  if (rows.length === 0) return '';
  const lines = ['## Recent conversation tail'];
  for (const row of rows) {
    const role = clean(row.role || row.kind || 'unknown');
    const text = clean(row.text || row.output || row.summary || '');
    if (!text) continue;
    lines.push(`- ${role}: ${clip(text.replace(/\s+/g, ' '), 260)}`);
  }
  return compactWithPinnedContext(lines.join('\n'), Math.max(800, Math.floor(Number(maxChars) || 3000)));
}

function collectSharedDocStats(jobDir = '') {
  const dir = path.join(jobDir, 'shared');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, size: Number(stat.size || 0), mtime_ms: Number(stat.mtimeMs || 0) };
      })
      .sort((a, b) => b.mtime_ms - a.mtime_ms)
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function buildIdleCompactionCandidate({ jobDir = '', maxChars = 7000 } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) throw new Error('jobDir is required');
  const activeArtifactContext = formatActiveArtifactContext(cleanJobDir, { maxChars: 1800, limit: 6 });
  const recentConversation = formatRecentConversation(cleanJobDir, { maxRows: 20, maxChars: 3200 });
  const artifactObservations = loadArtifactObservations(cleanJobDir, { limit: 20 });
  const sharedStats = collectSharedDocStats(cleanJobDir);
  let topology = null;
  try {
    topology = planMemoryTopology({ jobDir: cleanJobDir, persist: true, eventReason: 'idle_compaction' });
  } catch {}
  const topologyActions = Array.isArray(topology?.maintenance?.actions) ? topology.maintenance.actions : [];
  const lines = [
    '# Idle Compaction Candidate',
    '',
    `> generatedAt: ${new Date().toISOString()}`,
    '> status: candidate_requires_review',
    '> destructive_changes: false',
    '',
    '## Policy',
    '- This candidate summarizes/pins context only; it does not delete raw history, trace, uploads, or shared docs.',
    '- Active artifact facts and user corrections must remain higher priority than older compacted memory.',
    '- Apply/promote this summary only after review, or use it as an additional prompt surface.',
    '',
    activeArtifactContext || '## Active artifact context\n- (none)',
    '',
    recentConversation || '## Recent conversation tail\n- (none)',
    '',
    '## Artifact observation log summary',
    artifactObservations.length > 0
      ? artifactObservations.slice(-10).map((row) => {
          const labels = Array.isArray(row.observed_labels) && row.observed_labels.length ? ` labels=${row.observed_labels.join(', ')}` : '';
          const rejected = Array.isArray(row.rejected_labels) && row.rejected_labels.length ? ` rejected=${row.rejected_labels.join(', ')}` : '';
          return `- ${row.workspace_path || '(artifact)'}${labels}${rejected} status=${row.status || row.event || 'n/a'}`;
        }).join('\n')
      : '- (none)',
    '',
    '## Shared doc pressure',
    sharedStats.length > 0
      ? sharedStats.map((row) => `- ${row.name}: ${row.size} bytes`).join('\n')
      : '- (none)',
    '',
    '## Adaptive memory topology',
    topology
      ? [`- mode: ${topology.mode}`, `- stress: ${Number(topology.stress?.score || 0).toFixed(2)}`, `- reasons: ${(topology.stress?.reasons || topology.selection_reason || []).join(', ') || 'low_pressure'}`].join('\n')
      : '- (unavailable)',
    '',
    '## Idle-safe topology maintenance plan',
    topologyActions.length > 0
      ? topologyActions.slice(0, 10).map((row) => `- ${row.action}${row.target ? ` -> ${row.target}` : ''}: ${row.reason || ''}${row.candidate_only ? ' (candidate)' : ''}`).join('\n')
      : '- (none)',
  ];
  const summaryMarkdown = compactWithPinnedContext(lines.filter(Boolean).join('\n'), Math.max(1400, Math.floor(Number(maxChars) || 7000)), { maxPinLines: 16 });
  return {
    ts: new Date().toISOString(),
    kind: 'idle_compaction_candidate',
    status: 'candidate_requires_review',
    destructive_changes: false,
    artifact_observation_count: artifactObservations.length,
    shared_doc_count: sharedStats.length,
    memory_topology_mode: topology?.mode || undefined,
    memory_topology_stress: topology?.stress?.score,
    memory_topology_actions: topologyActions,
    summary_markdown: summaryMarkdown,
  };
}

export function writeIdleCompactionCandidate({ jobDir = '', maxChars = 7000 } = {}) {
  const cleanJobDir = clean(jobDir);
  const candidate = buildIdleCompactionCandidate({ jobDir: cleanJobDir, maxChars });
  fs.appendFileSync(path.join(cleanJobDir, IDLE_COMPACTION_CANDIDATES_FILE), `${JSON.stringify(candidate)}\n`, 'utf8');
  const summaryPath = path.join(sharedDir(cleanJobDir), IDLE_COMPACTION_SUMMARY_FILE);
  fs.writeFileSync(summaryPath, `${candidate.summary_markdown.trim()}\n`, 'utf8');
  return { ...candidate, summary_path: summaryPath };
}

export function runIdleMemoryMaintenance({ jobDir = '', jobId = '', chatId = '', threadId = '', runId = '', force = false, maxChars = 7000, minIntervalMs = null } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) throw new Error('jobDir is required');
  if (!force && !envBool('IDLE_MEMORY_MAINTENANCE_ENABLED', true)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const interval = Number.isFinite(Number(minIntervalMs))
    ? Math.max(0, Number(minIntervalMs))
    : Math.max(0, Number(process.env.IDLE_MEMORY_MAINTENANCE_MIN_INTERVAL_MS || 5 * 60 * 1000));
  const statePath = idleMaintenanceStatePath(cleanJobDir);
  const state = readJson(statePath) || {};
  const now = Date.now();
  const lastRunMs = Date.parse(String(state.last_run_at || '')) || 0;
  if (!force && lastRunMs && interval > 0 && now - lastRunMs < interval) {
    return { ok: true, skipped: true, reason: 'interval', next_after_ms: interval - (now - lastRunMs) };
  }
  const topology = planMemoryTopology({ jobDir: cleanJobDir, persist: true, eventReason: 'idle_maintenance' });
  const anchor = updateChatMemoryAnchor({
    jobDir: cleanJobDir,
    jobId,
    chatId,
    threadId,
    runId,
    topology,
    reason: 'idle_maintenance',
  });
  const stress = Number(topology?.stress?.score || 0);
  const mode = String(topology?.mode || '').trim();
  const shouldWriteCandidate = force
    || stress >= Number(process.env.IDLE_MEMORY_COMPACTION_STRESS_THRESHOLD || 2.4)
    || ['structured_single', 'team_scoped', 'graph_snapshot'].includes(mode);
  let candidate = null;
  if (shouldWriteCandidate) {
    candidate = writeIdleCompactionCandidate({ jobDir: cleanJobDir, maxChars });
  }
  let loopMemory = null;
  try {
    loopMemory = runLoopMemoryMaintenance({
      jobDir: cleanJobDir,
      force: false,
      archiveTerminal: true,
      allowRawPrune: false,
      limit: Number(process.env.IDLE_LOOP_MEMORY_MAINTENANCE_LIMIT || 100),
    });
  } catch {}
  const nextState = {
    last_run_at: new Date().toISOString(),
    last_topology_mode: mode || undefined,
    last_topology_stress: stress,
    last_candidate_written: !!candidate,
    last_loop_memory_maintenance: loopMemory ? {
      checked_runs: loopMemory.checked_runs,
      compacted: loopMemory.compacted.length,
      finalized: loopMemory.finalized.length,
      failures: loopMemory.failures.length,
    } : undefined,
    last_reason: shouldWriteCandidate ? 'candidate_written' : 'topology_only_low_pressure',
  };
  writeJson(statePath, nextState);
  return { ok: true, skipped: false, topology, anchor, candidate, loop_memory: loopMemory, state: nextState };
}

export function formatIdleCompactionCandidateForTelegram(candidate = {}) {
  const artifactCount = Number(candidate.artifact_observation_count || 0);
  const docCount = Number(candidate.shared_doc_count || 0);
  return [
    '🧹 idle compaction candidate 생성 완료',
    `- status: ${candidate.status || 'candidate_requires_review'}`,
    `- destructive_changes: ${candidate.destructive_changes === true ? 'true' : 'false'}`,
    `- artifact_observations: ${artifactCount}`,
    `- shared_docs: ${docCount}`,
    candidate.memory_topology_mode ? `- topology: ${candidate.memory_topology_mode} (stress=${Number(candidate.memory_topology_stress || 0).toFixed(2)})` : '',
    candidate.summary_path ? `- summary: ${candidate.summary_path}` : '',
    '',
    clip(String(candidate.summary_markdown || ''), 1800),
  ].filter(Boolean).join('\n');
}
