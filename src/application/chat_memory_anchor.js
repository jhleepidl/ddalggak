import fs from 'node:fs';
import path from 'node:path';

const ANCHOR_FILE = 'chat_memory_anchor.json';
const ANCHOR_EVENTS_FILE = 'chat_memory_anchor_events.jsonl';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function safeRead(filePath = '') { try { return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; } catch { return ''; } }
function safeJson(text = '') { try { return JSON.parse(String(text || '')); } catch { return null; } }
function ensureDir(dirPath = '') { if (!dirPath) return ''; fs.mkdirSync(dirPath, { recursive: true }); return dirPath; }
function localMemoryDir(jobDir = '') { const dir = clean(jobDir) ? path.join(jobDir, 'local_memory') : ''; return dir ? ensureDir(dir) : ''; }
function anchorPath(jobDir = '') { const dir = localMemoryDir(jobDir); return dir ? path.join(dir, ANCHOR_FILE) : ''; }
function anchorEventsPath(jobDir = '') { const dir = localMemoryDir(jobDir); return dir ? path.join(dir, ANCHOR_EVENTS_FILE) : ''; }
function topologySurfaceIds(topology = {}) {
  return asArray(asObject(topology).surfaces)
    .map((row) => clean(asObject(row).id || asObject(row).surface_id || asObject(row).surfaceId || row))
    .filter(Boolean);
}
function compactLineage(lineage = [], next = null, max = 16) {
  const rows = asArray(lineage).filter((row) => row && typeof row === 'object');
  if (next) rows.push(next);
  const out = [];
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = asObject(rows[i]);
    const surfaces = topologySurfaceIds({ surfaces: row.surfaces }).length ? topologySurfaceIds({ surfaces: row.surfaces }) : asArray(row.surfaces).map(clean).filter(Boolean).slice(0, 16);
    const key = [row.mode, surfaces.join(','), row.reason].join('|');
    if (seen.has(key) && out.length > 0) continue;
    seen.add(key);
    out.unshift({
      ts: clean(row.ts) || new Date().toISOString(),
      reason: clean(row.reason) || 'refresh',
      mode: clean(row.mode) || 'compact_single',
      run_id: clean(row.run_id || row.runId) || undefined,
      surfaces,
      stress_score: Number.isFinite(Number(row.stress_score || row.stressScore)) ? Number(row.stress_score || row.stressScore) : undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}
function stableRoots({ jobDir = '', jobId = '' } = {}) {
  const cleanJobDir = clean(jobDir);
  return {
    job_id: clean(jobId) || path.basename(cleanJobDir || ''),
    job_dir: cleanJobDir || undefined,
    conversation_log: cleanJobDir ? path.join(cleanJobDir, 'conversation.jsonl') : undefined,
    local_turns: cleanJobDir ? path.join(cleanJobDir, 'local_memory', 'turns.jsonl') : undefined,
    rolling_summary: cleanJobDir ? path.join(cleanJobDir, 'local_memory', 'summary.md') : undefined,
    current_task_packet: cleanJobDir ? path.join(cleanJobDir, 'local_memory', 'current_task_packet.json') : undefined,
    user_facts: cleanJobDir ? path.join(cleanJobDir, 'user_facts.jsonl') : undefined,
    artifact_observations: cleanJobDir ? path.join(cleanJobDir, 'artifact_observations.jsonl') : undefined,
    shared_dir: cleanJobDir ? path.join(cleanJobDir, 'shared') : undefined,
    workspace_dir: cleanJobDir ? path.join(cleanJobDir, 'workspace') : undefined,
  };
}
export function loadChatMemoryAnchor({ jobDir = '' } = {}) {
  const filePath = anchorPath(jobDir);
  if (!filePath) return null;
  return safeJson(safeRead(filePath));
}
export function updateChatMemoryAnchor({ jobDir = '', jobId = '', chatId = '', threadId = '', runId = '', topology = null, reason = 'refresh', userText = '', assistantText = '' } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const filePath = anchorPath(cleanJobDir);
  const previous = asObject(loadChatMemoryAnchor({ jobDir: cleanJobDir }));
  const now = new Date().toISOString();
  const mode = clean(asObject(topology).mode) || clean(previous.active_topology_mode) || 'compact_single';
  const surfaces = topologySurfaceIds(topology || {});
  const lineageEntry = { ts: now, reason, mode, run_id: clean(runId) || undefined, surfaces, stress_score: Number.isFinite(Number(asObject(topology).stress?.score)) ? Number(asObject(topology).stress.score) : undefined };
  const next = {
    schema_version: 'ddalggak.chat_memory_anchor/v1',
    chat_id: clean(chatId) || clean(previous.chat_id) || undefined,
    job_id: clean(jobId) || clean(previous.job_id) || path.basename(cleanJobDir),
    thread_id: clean(threadId) || clean(previous.thread_id) || undefined,
    created_at: clean(previous.created_at) || now,
    updated_at: now,
    active_topology_mode: mode,
    active_surface_ids: surfaces,
    stable_roots: stableRoots({ jobDir: cleanJobDir, jobId: clean(jobId) || clean(previous.job_id) }),
    continuity_policy: {
      same_chat_uses_same_job_memory_root: true,
      topology_transitions_are_non_destructive: true,
      core_anchors_must_remain_readable: ['rolling_summary', 'local_turns', 'conversation_log', 'current_task_packet', 'user_facts', 'artifact_observations', 'shared_dir'],
      latest_user_corrections_override_compacted_summaries: true,
    },
    topology_lineage: compactLineage(previous.topology_lineage || [], lineageEntry, 16),
    last_user_text: clean(userText).slice(0, 700) || previous.last_user_text || undefined,
    last_assistant_text: clean(assistantText).slice(0, 900) || previous.last_assistant_text || undefined,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const prevMode = clean(previous.active_topology_mode);
  const prevSurfaces = asArray(previous.active_surface_ids).map(clean).join('|');
  const nextSurfaces = surfaces.join('|');
  if (!previous.schema_version || prevMode !== mode || prevSurfaces !== nextSurfaces || reason === 'run_end' || reason === 'idle_maintenance') {
    fs.appendFileSync(anchorEventsPath(cleanJobDir), `${JSON.stringify({ ts: now, kind: 'chat_memory_anchor_event', reason, chat_id: next.chat_id, job_id: next.job_id, thread_id: next.thread_id, run_id: clean(runId) || undefined, previous_mode: prevMode || null, next_mode: mode, surface_ids: surfaces })}\n`, 'utf8');
  }
  return next;
}
export function buildChatMemoryAnchorPromptBlock(anchor = null, { maxLineage = 4 } = {}) {
  const row = asObject(anchor);
  if (!row.schema_version && !row.job_id) return '';
  const roots = asObject(row.stable_roots);
  const lineage = asArray(row.topology_lineage).slice(-Math.max(1, Number(maxLineage) || 4));
  const rootNames = ['rolling_summary', 'local_turns', 'conversation_log', 'current_task_packet', 'user_facts', 'artifact_observations', 'shared_dir'].filter((key) => roots[key]).join(', ');
  return [
    '[CHAT MEMORY ANCHOR]',
    `chat_id=${row.chat_id || '(unknown)'}`,
    `job_id=${row.job_id || '(unknown)'} thread_id=${row.thread_id || '(none)'}`,
    `active_topology=${row.active_topology_mode || 'compact_single'} surfaces=${asArray(row.active_surface_ids).join(', ') || '(none)'}`,
    `stable_roots=${rootNames || '(none)'}`,
    '- Treat this as the durable memory root for the same Telegram chat.',
    '- Idle compaction or topology split/merge is non-destructive; do not treat a missing specialized surface as memory loss.',
    '- If a fact is not present in the current role lens, recover from core anchors: rolling summary, local turns, conversation log, task packet, user facts, artifact observations, and shared docs.',
    '- Latest user corrections and verified absences override older summaries and surface-specific notes.',
    lineage.length ? 'Topology lineage:' : '',
    ...lineage.map((entry) => `- ${entry.ts || ''}: ${entry.mode || 'unknown'} surfaces=[${asArray(entry.surfaces).join(', ')}] reason=${entry.reason || 'refresh'}`),
  ].filter(Boolean).join('\n');
}
export function readChatMemoryAnchorEvents({ jobDir = '', limit = 20 } = {}) {
  const text = safeRead(anchorEventsPath(jobDir));
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return rows.slice(-Math.max(1, Number(limit) || 20));
}
export { ANCHOR_FILE as CHAT_MEMORY_ANCHOR_FILE, ANCHOR_EVENTS_FILE as CHAT_MEMORY_ANCHOR_EVENTS_FILE };
