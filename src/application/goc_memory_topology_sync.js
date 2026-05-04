import { loadMemoryTopology, readMemoryTopologyEvents } from './memory_topology.js';
import { loadChatMemoryAnchor, readChatMemoryAnchorEvents } from './chat_memory_anchor.js';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function loadTopology(jobDir = '', topology = null) { return topology && typeof topology === 'object' ? topology : loadMemoryTopology({ jobDir }); }
function loadAnchor(jobDir = '', anchor = null) { return anchor && typeof anchor === 'object' ? anchor : loadChatMemoryAnchor({ jobDir }); }

export function buildGocMemoryTopologyPayload({ jobDir = '', jobId = '', runId = '', topology = null, anchor = null, source = 'ddalggak', eventLimit = 20 } = {}) {
  const resolvedTopology = loadTopology(jobDir, topology);
  if (!resolvedTopology || typeof resolvedTopology !== 'object') return null;
  const resolvedAnchor = loadAnchor(jobDir, anchor);
  const topologyEvents = readMemoryTopologyEvents({ jobDir, limit: eventLimit });
  const anchorEvents = readChatMemoryAnchorEvents({ jobDir, limit: Math.max(4, Math.floor(Number(eventLimit) || 20)) });
  const enrichedTopology = {
    ...resolvedTopology,
    run_id: clean(runId) || clean(resolvedTopology.run_id) || undefined,
    job_id: clean(jobId) || clean(resolvedAnchor?.job_id) || clean(resolvedTopology.job_id) || undefined,
    chat_memory_anchor: resolvedAnchor || undefined,
    continuity: {
      same_chat_memory_anchor: true,
      topology_transitions_non_destructive: true,
      stable_roots: asObject(resolvedAnchor?.stable_roots),
      active_surface_ids: Array.isArray(resolvedAnchor?.active_surface_ids) ? resolvedAnchor.active_surface_ids : undefined,
    },
  };
  const events = [
    ...topologyEvents.map((row) => ({ ...asObject(row), event_source: 'memory_topology' })),
    ...anchorEvents.map((row) => ({ ...asObject(row), event_source: 'chat_memory_anchor' })),
  ].slice(-Math.max(1, Math.floor(Number(eventLimit) || 20)));
  return { run_id: clean(runId) || undefined, source: clean(source) || 'ddalggak', topology: enrichedTopology, events };
}

export async function syncMemoryTopologyToGoc({ client = null, threadId = '', jobDir = '', jobId = '', runId = '', topology = null, anchor = null, source = 'ddalggak', eventLimit = 20, logger = null } = {}) {
  const cleanThreadId = clean(threadId);
  if (!client || !cleanThreadId) return { synced: false, skipped: true, reason: 'missing_client_or_thread' };
  const payload = buildGocMemoryTopologyPayload({ jobDir, jobId, runId, topology, anchor, source, eventLimit });
  if (!payload) return { synced: false, skipped: true, reason: 'missing_topology' };
  if (typeof client.recordMemoryTopology !== 'function') return { synced: false, skipped: true, reason: 'client_method_missing' };
  try {
    const result = await client.recordMemoryTopology(cleanThreadId, payload);
    return { synced: true, skipped: false, snapshot_id: clean(result?.snapshot_id || result?.snapshotId || result?.topology?.snapshot_id) || undefined, mode: clean(payload.topology?.mode) || undefined, event_count: Array.isArray(payload.events) ? payload.events.length : 0, result };
  } catch (error) {
    const message = String(error?.message || error || 'unknown');
    if (typeof logger === 'function') logger(`[goc] memory topology sync failed: ${message}`);
    return { synced: false, skipped: false, reason: 'error', error: message };
  }
}
