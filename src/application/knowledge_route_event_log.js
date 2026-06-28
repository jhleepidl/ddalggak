import fs from 'node:fs';
import path from 'node:path';

export const KNOWLEDGE_ROUTE_EVENTS_FILE = 'knowledge_route_events.jsonl';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }

function filePath(jobDir = '') {
  const dir = clean(jobDir);
  return dir ? path.join(dir, 'local_memory', KNOWLEDGE_ROUTE_EVENTS_FILE) : '';
}

function append(file = '', row = {}) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

function inferKnowledgeSurfaces(decision = {}, message = '') {
  const signals = new Set(asArray(decision.signals));
  const blockers = new Set(asArray(decision.blockers));
  const route = clean(decision.route);
  const surfaces = [];
  if (route === 'concierge_direct_answer') surfaces.push('model_prior');
  if (route === 'concierge_search_answer' || signals.has('search_or_freshness_intent')) surfaces.push('fresh_search');
  if (signals.has('artifact_reference_intent') || blockers.has('needs_artifact_context') || /업로드|이미지|사진|첨부|메뉴판|upload|image|photo|attachment/i.test(message)) surfaces.push('artifact_memory');
  if (/어제|전에|지난|기억|먹었지|올렸|했었|previous|remember|memory/i.test(message)) surfaces.push('room_memory');
  if (signals.has('workbench_intent') || blockers.has('needs_workspace_or_artifact')) surfaces.push('workspace_tools');
  if (signals.has('team_or_review_intent')) surfaces.push('team_workflow');
  return [...new Set(surfaces.length ? surfaces : ['standard_context'])];
}

export function appendKnowledgeRouteEvent({ jobDir = '', chatId = '', userId = '', command = '/ask', message = '', decision = {}, modelPolicy = {}, executor = '', outcome = 'planned', extra = {} } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const row = {
    ts: new Date().toISOString(),
    event: 'knowledge_route_decision',
    command: clean(command) || '/ask',
    query_excerpt: clean(message).slice(0, 300),
    chat_id: clean(chatId) || undefined,
    user_id: clean(userId) || undefined,
    route: clean(decision?.route) || 'unknown',
    depth: clean(decision?.depth) || undefined,
    knowledge_surfaces: inferKnowledgeSurfaces(asObject(decision), message),
    skipped_surfaces: asArray(extra.skipped_surfaces || extra.skippedSurfaces).map(clean).filter(Boolean),
    signals: asArray(decision?.signals).map(clean).filter(Boolean),
    blockers: asArray(decision?.blockers).map(clean).filter(Boolean),
    model_policy: {
      provider: clean(modelPolicy?.provider) || undefined,
      model: clean(modelPolicy?.model) || undefined,
      reasons: asArray(modelPolicy?.reasons).map(clean).filter(Boolean),
    },
    executor: clean(executor) || undefined,
    outcome: clean(outcome) || 'planned',
    cost_estimate: asObject(extra.cost_estimate || extra.costEstimate),
  };
  append(filePath(cleanJobDir), row);
  return row;
}

export function loadKnowledgeRouteEvents(jobDir = '', { limit = 200 } = {}) {
  const fp = filePath(jobDir);
  try {
    if (!fp || !fs.existsSync(fp)) return [];
    const rows = String(fs.readFileSync(fp, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    const n = Math.max(1, Math.floor(Number(limit) || 200));
    return rows.length > n ? rows.slice(rows.length - n) : rows;
  } catch {
    return [];
  }
}
