import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';
import { formatActiveArtifactContext, loadArtifactObservations, loadUploadedArtifacts } from './artifact_context.js';
import { formatActiveUserFactContext, readUserFacts, resolveActiveUserFacts } from './user_fact_context.js';
import { mergeRouterMemoryRouting, normalizeRouterMemoryRouting } from './router_memory_plan.js';
import { loadCurrentTaskPacket, renderTaskPacket } from './task_packet.js';
import { searchSemanticIndex } from './semantic_index.js';

const DEFAULT_MAX_CHARS = 2600;
const EVENTS_FILE = 'memory_demand_events.jsonl';
const STOPWORDS = new Set([
  'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'is', 'are', 'was', 'were',
  '좀', '그', '이', '저', '것', '거', '수', '등', '및', '그리고', '근데', '그러면', '해줘', '해주세요', '있어', '있는', '했던', '해서',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeRead(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJsonl(filePath = '', { limit = 1000 } = {}) {
  const raw = safeRead(filePath);
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {}
  }
  const cleanLimit = Math.max(1, Math.floor(Number(limit) || 1000));
  return rows.length > cleanLimit ? rows.slice(rows.length - cleanLimit) : rows;
}

function tokenize(text = '') {
  const normalized = clean(text).toLowerCase();
  if (!normalized) return [];
  const rough = normalized
    .replace(/[\u2018\u2019\u201c\u201d`"'()[\]{}<>:;,.!?]/g, ' ')
    .split(/\s+|\/+|\\+|\|+|-+|_+/)
    .map((row) => row.trim())
    .filter(Boolean);
  const expanded = [];
  for (const token of rough) {
    if (token.length >= 2 && !STOPWORDS.has(token)) expanded.push(token);
    if (/^[가-힣]{4,}$/.test(token)) {
      for (let i = 0; i <= token.length - 2; i += 1) expanded.push(token.slice(i, i + 2));
    }
  }
  const seen = new Set();
  return expanded.filter((token) => {
    if (!token || seen.has(token)) return false;
    seen.add(token);
    return true;
  }).slice(0, 60);
}

function hasAny(text = '', patterns = []) {
  const src = String(text || '');
  return patterns.some((pattern) => pattern.test(src));
}

function inferMemoryDemand(userText = '', { roleId = '', agentId = '', goal = '', routerMemoryPlan = null, scopeHint = null } = {}) {
  const query = clean(userText || goal);
  const tokens = tokenize(query);
  const routerPlan = mergeRouterMemoryRouting(
    normalizeRouterMemoryRouting(scopeHint?.memory_demand || scopeHint?.memoryDemand || {}),
    normalizeRouterMemoryRouting(routerMemoryPlan || {})
  );
  const routerQuery = String(routerPlan.query || '').trim();
  const demand = {
    query: routerQuery || query,
    tokens: tokenize([routerQuery, query].filter(Boolean).join(' ')) || tokens,
    needsContinuity: false,
    needsUserFacts: false,
    needsArtifacts: false,
    needsTurns: false,
    needsTaskState: false,
    needsSharedWork: false,
    needsDecisions: false,
    needsSemanticMemory: false,
    reasons: [],
  };
  const mark = (key, reason) => {
    demand[key] = true;
    if (reason && !demand.reasons.includes(reason)) demand.reasons.push(reason);
  };

  const q = String(demand.query || query || '').toLowerCase();

  const sourceTypes = Array.isArray(routerPlan.source_types) ? routerPlan.source_types : [];
  const hasSource = (name) => sourceTypes.includes(name);
  if (routerPlan.mode && routerPlan.mode !== 'minimal' && routerPlan.mode !== 'none') {
    if (!demand.reasons.includes('router_memory_classifier')) demand.reasons.push('router_memory_classifier');
  }
  if (hasSource('turns') || hasSource('summary')) { mark('needsContinuity', 'router_memory_classifier'); mark('needsTurns', 'router_memory_classifier'); }
  if (hasSource('task_state')) mark('needsTaskState', 'router_memory_classifier');
  if (hasSource('shared_work')) mark('needsSharedWork', 'router_memory_classifier');
  if (hasSource('artifacts')) mark('needsArtifacts', 'router_memory_classifier');
  if (hasSource('user_facts')) mark('needsUserFacts', 'router_memory_classifier');
  if (hasSource('decisions')) { mark('needsDecisions', 'router_memory_classifier'); mark('needsTurns', 'router_memory_classifier'); }
  if (hasSource('semantic_index') || hasSource('semantic_memory') || hasSource('vector_memory')) mark('needsSemanticMemory', 'router_memory_classifier');
  demand.routerMemoryPlan = routerPlan;

  if (hasAny(q, [/\bprevious\b|\bearlier\b|\blast time\b|\bremember\b/i, /아까|이전|전에|지난|방금|기억|말했|했던|하던|이어|계속|다시|중간|쉬었다|못\s*찾|못\s*기억/])) {
    mark('needsContinuity', 'continuity_reference');
    mark('needsTurns', 'continuity_reference');
  }
  if (hasAny(q, [/첨부|업로드|올렸|파일|이미지|사진|캡처|스크린샷|artifact|attachment|upload|file|image|photo/])) {
    mark('needsArtifacts', 'artifact_reference');
  }
  if (hasAny(q, [/키|몸무게|체중|나이|성별|활동량|선호|싫어|좋아|알레르기|먹었|먹은|식사|점심|저녁|아침|칼로리|영양|메뉴|profile|preference|meal|diet/i])) {
    mark('needsUserFacts', 'user_fact_reference');
  }
  if (hasAny(q, [/계획|진행|상태|결정|TODO|할\s*일|다음\s*단계|패치|구현|수정|검토|diff|테스트|빌드|run|job|plan|progress|decision|status|patch|test/i])) {
    mark('needsTaskState', 'task_state_reference');
    mark('needsSharedWork', 'work_state_reference');
  }
  if (hasAny(q, [/왜|원인|분석|설계|구조|memory|메모리|topology|agent|context|projection|idle|compaction/i])) {
    mark('needsSharedWork', 'design_or_memory_reference');
    mark('needsSemanticMemory', 'semantic_design_or_memory_reference');
  }
  if (hasAny(q, [/결정|바꿔|변경|하지\s*마|해야|원해|목적|방향|주의|constraint|requirement|decision|must|never/i])) {
    mark('needsDecisions', 'directive_or_decision_reference');
    mark('needsTurns', 'directive_or_decision_reference');
  }

  const role = String(roleId || agentId || '').toLowerCase();
  if (/reviewer|critic|builder|coder|researcher|synthesizer|planner|router/.test(role)) {
    mark('needsTaskState', 'agent_role_requires_task_state');
  }
  if (hasAny(q, [/비슷|유사|관련|찾아|검색|recall|remember|similar|related|semantic|vector|embedding|skill|role|team|스킬|역할|팀|벡터|임베딩/i])) {
    mark('needsSemanticMemory', 'semantic_recall_reference');
  }
  if (!demand.needsContinuity && !demand.needsUserFacts && !demand.needsArtifacts && !demand.needsTaskState && !demand.needsSharedWork && !demand.needsDecisions && !demand.needsSemanticMemory) {
    if (tokens.length >= 3) mark('needsTurns', 'query_terms_available');
  }
  return demand;
}

function roleOfTurn(row = {}) {
  return String(row.role || row.author || row.agent || 'user').trim().toLowerCase() || 'user';
}

function textOfTurn(row = {}) {
  return clean(row.text || row.content || row.message || '');
}

function scoreText(text = '', tokens = [], { recencyBoost = 0, priority = 0 } = {}) {
  const src = clean(text).toLowerCase();
  if (!src) return 0;
  let score = Number(priority || 0) + Number(recencyBoost || 0);
  for (const token of tokens) {
    if (!token) continue;
    if (src.includes(token)) score += token.length >= 4 ? 2 : 1;
  }
  return score;
}

function priorityTurnScore(text = '', role = '') {
  const src = clean(text).toLowerCase();
  let score = 0;
  if (role === 'user') score += 1;
  if (/하지\s*마|하지마|반드시|절대로|기억|주의|구분|원해|목적|바꿔|수정|아니라|대신|must|never|do not|don't|instead|rather than/.test(src)) score += 5;
  if (/진행해|계속|이어|패치|구현|다음\s*단계|approve|continue/.test(src)) score += 3;
  return score;
}

function retrieveTurns(jobDir = '', demand = {}, { maxItems = 6 } = {}) {
  const turnsPath = path.join(jobDir, 'local_memory', 'turns.jsonl');
  const rows = safeReadJsonl(turnsPath, { limit: 800 });
  if (rows.length === 0) return [];
  const tokens = Array.isArray(demand.tokens) ? demand.tokens : [];
  const scored = [];
  rows.forEach((row, idx) => {
    const role = roleOfTurn(row);
    const text = textOfTurn(row);
    if (!text) return;
    const recencyBoost = Math.max(0, 2 - ((rows.length - 1 - idx) / 20));
    const priority = priorityTurnScore(text, role);
    let score = scoreText(text, tokens, { recencyBoost, priority });
    if (demand.needsContinuity && idx >= rows.length - 12) score += 2;
    if (demand.needsDecisions && priority > 0) score += 4;
    if (score <= 0 && !demand.needsContinuity) return;
    scored.push({ idx, role, text, score });
  });
  const selected = scored
    .sort((a, b) => b.score - a.score || b.idx - a.idx)
    .slice(0, Math.max(1, Math.floor(Number(maxItems) || 6)))
    .sort((a, b) => a.idx - b.idx);
  return selected.map((row) => ({
    kind: 'turn',
    source: 'local_memory/turns.jsonl',
    role: row.role,
    text: clip(row.text, 520),
    score: row.score,
  }));
}

function retrieveSummary(jobDir = '', demand = {}) {
  const summaryPath = path.join(jobDir, 'local_memory', 'summary.md');
  const raw = clean(safeRead(summaryPath));
  if (!raw) return [];
  const tokens = Array.isArray(demand.tokens) ? demand.tokens : [];
  const score = scoreText(raw, tokens, { priority: demand.needsContinuity ? 3 : 0 });
  if (score <= 0 && !demand.needsContinuity && !demand.needsTaskState) return [];
  return [{ kind: 'summary', source: 'local_memory/summary.md', text: clip(raw, 900, { mode: 'middle' }), score }];
}

function retrieveUserFacts(jobDir = '', demand = {}) {
  if (!demand.needsUserFacts && !demand.needsContinuity) return [];
  const facts = resolveActiveUserFacts(readUserFacts(jobDir));
  if (facts.length === 0) return [];
  const tokens = Array.isArray(demand.tokens) ? demand.tokens : [];
  const rows = facts.map((fact) => {
    const text = JSON.stringify(fact);
    let score = scoreText(text, tokens, { priority: 2 });
    const type = String(fact.type || '').trim();
    if (demand.needsUserFacts) score += 3;
    if (type === 'profile' && /키|몸무게|체중|나이|성별|활동량|profile|height|weight|age|gender/.test(demand.query)) score += 4;
    if (type === 'meal' && /먹|식사|점심|저녁|아침|칼로리|영양|메뉴|meal|diet/.test(demand.query)) score += 4;
    if (type === 'preference' && /선호|싫|좋|preference|like|dislike/.test(demand.query)) score += 4;
    return { fact, score };
  }).filter((row) => row.score > 0);
  if (rows.length === 0) return [];
  const block = formatActiveUserFactContext(jobDir, { maxChars: 1000 });
  return block ? [{ kind: 'user_facts', source: 'user_facts.jsonl', text: block, score: Math.max(...rows.map((row) => row.score)) }] : [];
}

function retrieveArtifacts(jobDir = '', demand = {}) {
  if (!demand.needsArtifacts && !demand.needsContinuity) return [];
  const uploads = loadUploadedArtifacts(jobDir, { limit: 12 });
  const observations = loadArtifactObservations(jobDir, { limit: 120 });
  if (uploads.length === 0 && observations.length === 0) return [];
  const block = formatActiveArtifactContext(jobDir, { maxChars: 1100, limit: 5 });
  if (!block) return [];
  return [{ kind: 'artifact_context', source: 'artifact_observations.jsonl + workspace/uploads/manifest.jsonl', text: block, score: demand.needsArtifacts ? 8 : 2 }];
}

function listSharedDocs(jobDir = '') {
  const sharedDir = path.join(jobDir, 'shared');
  try {
    if (!fs.existsSync(sharedDir)) return [];
    return fs.readdirSync(sharedDir)
      .filter((name) => /\.(md|txt|json)$/i.test(name))
      .filter((name) => !/^idle_compaction_candidates\.jsonl$/i.test(name))
      .map((name) => path.join(sharedDir, name));
  } catch {
    return [];
  }
}

function selectDocExcerpt(text = '', tokens = [], maxChars = 620) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const lower = raw.toLowerCase();
  let bestIdx = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(String(token || '').toLowerCase());
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx < 0) return clip(raw.trim(), maxChars, { mode: 'tail' });
  const start = Math.max(0, bestIdx - Math.floor(maxChars * 0.35));
  const end = Math.min(raw.length, start + maxChars);
  const excerpt = raw.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < raw.length ? '…' : ''}`;
}

function retrieveSharedWork(jobDir = '', demand = {}, { maxDocs = 3 } = {}) {
  if (!demand.needsSharedWork && !demand.needsTaskState && !demand.needsDecisions) return [];
  const tokens = Array.isArray(demand.tokens) ? demand.tokens : [];
  const docs = listSharedDocs(jobDir);
  const preferred = [/decision/i, /progress/i, /plan/i, /research/i, /artifact/i, /review/i, /idle_compaction_summary/i];
  const scored = [];
  for (const filePath of docs) {
    const raw = safeRead(filePath);
    if (!raw.trim()) continue;
    const rel = path.relative(jobDir, filePath).replace(/\\/g, '/');
    let priority = preferred.some((pattern) => pattern.test(rel)) ? 3 : 0;
    if (demand.needsDecisions && /decision|plan|contract/i.test(rel)) priority += 3;
    if (demand.needsTaskState && /progress|plan|artifact|review/i.test(rel)) priority += 2;
    const score = scoreText(raw, tokens, { priority });
    if (score <= 0 && priority <= 0) continue;
    scored.push({ filePath, rel, raw, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, Math.max(1, Math.floor(Number(maxDocs) || 3)))
    .map((row) => ({
      kind: 'shared_doc',
      source: row.rel,
      text: selectDocExcerpt(row.raw, tokens, 620),
      score: row.score,
    }));
}

function retrieveTaskPacket(jobDir = '', demand = {}, runMeta = {}) {
  if (!demand.needsTaskState && !demand.needsContinuity && !demand.needsDecisions) return [];
  const packet = loadCurrentTaskPacket({ jobDir, runMeta, refresh: false });
  const text = renderTaskPacket(packet, { maxChars: 900 });
  return text ? [{ kind: 'task_packet', source: 'local_memory/current_task_packet.json', text, score: 4 }] : [];
}

function retrieveSemanticMemory(jobDir = '', demand = {}, { maxItems = 4 } = {}) {
  if (!demand.needsSemanticMemory && !demand.needsContinuity && !demand.needsDecisions) return [];
  const query = demand.query || '';
  const result = searchSemanticIndex({
    jobDir,
    query,
    itemTypes: ['memory', 'review_finding', 'watch_iteration', 'team_blueprint'],
    limit: Math.max(1, Math.floor(Number(maxItems) || 4)),
    includeInactive: false,
    useVector: true,
    minScore: 0.035,
  });
  return (result.items || []).map((row) => ({
    kind: 'semantic_memory',
    source: `semantic_index:${row.item_type}:${row.source_ref || row.item_id}`,
    text: clip([row.title, row.display_text || row.text_original, row.canonical_text_en].filter(Boolean).join('\n'), 640, { mode: 'middle' }),
    score: Number(row.semantic_score || row.vector_score || row.lexical_semantic_score || 0) * 10,
    retrieval_backend: row.retrieval_backend || result.vector_backend || 'semantic_index',
  }));
}

function appendDemandEvent(jobDir = '', event = {}) {
  try {
    if (!jobDir) return;
    const dir = path.join(jobDir, 'local_memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, EVENTS_FILE), `${JSON.stringify({ ts: new Date().toISOString(), ...asObject(event) })}\n`, 'utf8');
  } catch {}
}

function dedupeItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = clean(item?.text || '');
    if (!text) continue;
    const key = `${item.kind || ''}:${item.source || ''}:${text.slice(0, 120)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, text });
  }
  return out;
}

export function buildMemoryDemandContext({
  jobDir = '',
  userText = '',
  goal = '',
  roleId = '',
  agentId = '',
  runMeta = {},
  routerMemoryPlan = null,
  scopeHint = null,
  maxChars = DEFAULT_MAX_CHARS,
  persist = false,
  reason = 'context_preflight',
} = {}) {
  const cleanJobDir = String(jobDir || '').trim();
  const demand = inferMemoryDemand(userText || goal, { roleId, agentId, goal, routerMemoryPlan, scopeHint });
  if (!cleanJobDir || !demand.query) {
    return { demand, items: [], text: '', sources: [], totalItems: 0 };
  }

  let items = [
    ...retrieveTaskPacket(cleanJobDir, demand, runMeta),
    ...retrieveUserFacts(cleanJobDir, demand),
    ...retrieveArtifacts(cleanJobDir, demand),
    ...retrieveSemanticMemory(cleanJobDir, demand, { maxItems: 4 }),
    ...retrieveTurns(cleanJobDir, demand, { maxItems: demand.needsContinuity ? 8 : 5 }),
    ...retrieveSummary(cleanJobDir, demand),
    ...retrieveSharedWork(cleanJobDir, demand, { maxDocs: demand.needsSharedWork ? 4 : 2 }),
  ];
  items = dedupeItems(items).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const cleanMax = Math.max(900, Math.floor(Number(maxChars) || DEFAULT_MAX_CHARS));
  const lines = [];
  if (items.length > 0) {
    lines.push('[MEMORY DEMAND CONTEXT]');
    lines.push(`query=${clip(demand.query, 220)}`);
    lines.push(`demand=${demand.reasons.join(', ') || 'query_terms'}`);
    lines.push('- This context was retrieved before agent execution from the current user question and same-chat stable memory roots.');
    lines.push('- Use it before claiming that prior context, user facts, artifacts, decisions, or task state are unknown.');
    lines.push('- Topology split/merge during idle maintenance is non-destructive; missing role-specific surface is not evidence of absent memory.');
    const perItemBudget = Math.max(260, Math.floor((cleanMax - lines.join('\n').length - 300) / Math.max(1, Math.min(items.length, 7))));
    items.slice(0, 7).forEach((item, idx) => {
      const label = `${item.kind || 'memory'} from ${item.source || 'unknown'}`;
      lines.push(`${idx + 1}. ${label}`);
      lines.push(clip(item.text, perItemBudget, { mode: 'middle' }));
    });
  }
  let text = lines.join('\n');
  if (text.length > cleanMax) text = `${text.slice(0, cleanMax - 38)}\n…(memory demand context truncated)`;
  const result = {
    demand,
    items,
    text,
    sources: [...new Set(items.map((item) => String(item.source || '').trim()).filter(Boolean))],
    totalItems: items.length,
  };
  if (persist) {
    appendDemandEvent(cleanJobDir, {
      reason,
      query: demand.query,
      demand_reasons: demand.reasons,
      router_memory_plan: demand.routerMemoryPlan && Object.keys(demand.routerMemoryPlan).length > 0 ? demand.routerMemoryPlan : undefined,
      retrieval_mode: demand.routerMemoryPlan?.classifier ? 'router_llm_preflight' : 'runtime_preflight',
      classifier: demand.routerMemoryPlan?.classifier || undefined,
      confidence: demand.routerMemoryPlan?.confidence,
      sources: result.sources,
      item_count: items.length,
      source_types: Array.isArray(demand.routerMemoryPlan?.source_types) ? demand.routerMemoryPlan.source_types : [...new Set(items.map((item) => String(item.kind || '').trim()).filter(Boolean))],
      surface_ids: Array.isArray(demand.routerMemoryPlan?.surface_ids) ? demand.routerMemoryPlan.surface_ids : [],
      matching: {
        strategy: items.some((item) => item.kind === 'semantic_memory') ? 'semantic_vector_plus_runtime_scoring' : (demand.routerMemoryPlan?.classifier ? 'router_memory_plan' : 'runtime_token_scoring'),
        item_count: items.length,
        sources: result.sources,
        demand_reasons: demand.reasons,
      },
      agent_id: String(agentId || '').trim().toLowerCase() || undefined,
      role_id: String(roleId || '').trim().toLowerCase() || undefined,
    });
  }
  return result;
}

export function buildMemoryDemandPromptBlock(args = {}) {
  return buildMemoryDemandContext(args).text;
}

export { inferMemoryDemand };
