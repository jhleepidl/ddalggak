import fs from 'node:fs';
import path from 'node:path';

const EVENTS_FILE = 'memory_demand_events.jsonl';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }

function readJsonl(filePath = '', { limit = 200 } = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const rows = String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
    const cleanLimit = Math.max(1, Math.floor(Number(limit) || 200));
    return rows.length > cleanLimit ? rows.slice(rows.length - cleanLimit) : rows;
  } catch {
    return [];
  }
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((entry) => clean(entry)).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((entry) => clean(entry)).filter(Boolean);
  return [];
}

function normalizeDemandEvent(row = {}, { fallbackRunId = '', source = 'ddalggak' } = {}) {
  const event = asObject(row);
  const routerPlan = asObject(event.router_memory_plan || event.routerMemoryPlan || event.memory_routing || event.memoryRouting);
  const sourceTypes = normalizeStringList(event.source_types || event.sourceTypes);
  const surfaceIds = normalizeStringList(event.surface_ids || event.surfaceIds);
  const sources = normalizeStringList(event.sources || event.source_paths || event.sourcePaths);
  const matching = {
    strategy: clean(asObject(event.matching).strategy) || clean(event.retrieval_mode) || clean(routerPlan.classifier) || 'runtime_preflight',
    item_count: Math.max(0, Math.floor(Number(event.item_count || event.itemCount || 0) || 0)),
    sources,
    ...(asObject(event.matching)),
  };
  return {
    id: clean(event.id || event.event_id || ''),
    ts: clean(event.ts || event.created_at || event.createdAt || '') || undefined,
    created_at: clean(event.created_at || event.createdAt || event.ts || '') || undefined,
    run_id: clean(event.run_id || event.runId || fallbackRunId) || undefined,
    query: clean(event.query || routerPlan.query || ''),
    reason: clean(event.reason || 'context_preflight') || 'context_preflight',
    demand_reasons: normalizeStringList(event.demand_reasons || event.demandReasons || event.reasons),
    sources,
    item_count: Math.max(0, Math.floor(Number(event.item_count || event.itemCount || sources.length || 0) || 0)),
    agent_id: clean(event.agent_id || event.agentId || '') || undefined,
    role_id: clean(event.role_id || event.roleId || '') || undefined,
    retrieval_mode: clean(event.retrieval_mode || event.retrievalMode || (routerPlan.classifier ? 'router_llm_preflight' : 'runtime_preflight')) || 'runtime_preflight',
    classifier: clean(event.classifier || routerPlan.classifier || '') || undefined,
    confidence: Number.isFinite(Number(event.confidence ?? routerPlan.confidence)) ? Number(event.confidence ?? routerPlan.confidence) : undefined,
    source_types: sourceTypes.length ? sourceTypes : normalizeStringList(routerPlan.source_types || routerPlan.sourceTypes),
    surface_ids: surfaceIds.length ? surfaceIds : normalizeStringList(routerPlan.surface_ids || routerPlan.surfaceIds),
    router_memory_plan: Object.keys(routerPlan).length ? routerPlan : undefined,
    matching,
    source: clean(event.source || source) || 'ddalggak',
    event,
  };
}

export function buildGocMemoryDemandPayload({ jobDir = '', runId = '', source = 'ddalggak', eventLimit = 80 } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const eventPath = path.join(cleanJobDir, 'local_memory', EVENTS_FILE);
  const rows = readJsonl(eventPath, { limit: eventLimit });
  if (!rows.length) return null;
  const events = rows
    .map((row) => normalizeDemandEvent(row, { fallbackRunId: runId, source }))
    .filter((row) => row.query || row.demand_reasons.length || row.sources.length || row.item_count > 0);
  if (!events.length) return null;
  return {
    run_id: clean(runId) || clean(events[events.length - 1]?.run_id) || undefined,
    source: clean(source) || 'ddalggak',
    events,
  };
}

export async function syncMemoryDemandToGoc({ client = null, threadId = '', jobDir = '', runId = '', source = 'ddalggak', eventLimit = 80, logger = null } = {}) {
  const cleanThreadId = clean(threadId);
  if (!client || !cleanThreadId) return { synced: false, skipped: true, reason: 'missing_client_or_thread' };
  if (typeof client.recordMemoryDemand !== 'function') return { synced: false, skipped: true, reason: 'client_method_missing' };
  const payload = buildGocMemoryDemandPayload({ jobDir, runId, source, eventLimit });
  if (!payload) return { synced: false, skipped: true, reason: 'missing_events' };
  try {
    const result = await client.recordMemoryDemand(cleanThreadId, payload);
    return { synced: true, skipped: false, event_count: payload.events.length, result };
  } catch (error) {
    const message = String(error?.message || error || 'unknown');
    if (typeof logger === 'function') logger(`[goc] memory demand sync failed: ${message}`);
    return { synced: false, skipped: false, reason: 'error', error: message };
  }
}
