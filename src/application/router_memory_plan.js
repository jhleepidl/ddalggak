import { clip } from '../textutil.js';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function stringList(raw, { max = 16 } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[\n,]+/) : []);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const value = String(entry || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Math.floor(max))) break;
  }
  return out;
}

function normalizeSourceType(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (['turn', 'turns', 'conversation', 'conversation_tail', 'history', 'chat_history'].includes(key)) return 'turns';
  if (['summary', 'rolling_summary', 'core', 'core_summary'].includes(key)) return 'summary';
  if (['task', 'task_state', 'current_task', 'current_task_packet', 'progress_state'].includes(key)) return 'task_state';
  if (['decision', 'decisions', 'directive', 'directives', 'constraints'].includes(key)) return 'decisions';
  if (['shared', 'shared_work', 'shared_docs', 'work_state', 'progress', 'plan', 'review'].includes(key)) return 'shared_work';
  if (['artifact', 'artifacts', 'file', 'files', 'uploads', 'attachment', 'attachments'].includes(key)) return 'artifacts';
  if (['user_fact', 'user_facts', 'profile', 'preferences', 'facts'].includes(key)) return 'user_facts';
  return key.replace(/[^a-z0-9_:-]/g, '_').slice(0, 64);
}

export function normalizeRouterMemoryRouting(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const fb = asObject(fallback);
  const query = String(row.query || row.search_query || row.searchQuery || row.memory_query || row.memoryQuery || fb.query || '').trim();
  const sourceTypes = stringList(row.source_types || row.sourceTypes || row.sources || row.memory_sources || row.memorySources || fb.source_types || fb.sourceTypes, { max: 12 })
    .map(normalizeSourceType)
    .filter(Boolean);
  const surfaceIds = stringList(row.surface_ids || row.surfaceIds || row.surfaces || fb.surface_ids || fb.surfaceIds, { max: 16 })
    .map((entry) => String(entry || '').trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '_'))
    .filter(Boolean);
  const reasons = stringList(row.reasons || row.demand_reasons || row.demandReasons || row.why || fb.reasons, { max: 16 })
    .map((entry) => String(entry || '').trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '_'))
    .filter(Boolean);
  const agents = stringList(row.agent_ids || row.agentIds || row.agents || fb.agent_ids || fb.agentIds, { max: 12 })
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
  const modeRaw = String(row.mode || row.retrieval_mode || row.retrievalMode || fb.mode || '').trim().toLowerCase();
  const mode = ['none', 'minimal', 'query', 'expanded', 'audit_only'].includes(modeRaw)
    ? modeRaw
    : (query || sourceTypes.length > 0 || surfaceIds.length > 0 ? 'query' : 'minimal');
  const confidenceRaw = Number(row.confidence ?? fb.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : undefined;
  const required = row.required === true || row.must_retrieve === true || row.mustRetrieve === true || fb.required === true;
  const maxCharsRaw = Number(row.max_chars ?? row.maxChars ?? fb.max_chars ?? fb.maxChars);
  const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(600, Math.min(8000, Math.floor(maxCharsRaw))) : undefined;
  const classifier = String(row.classifier || row.classifier_source || row.classifierSource || fb.classifier || '').trim() || undefined;
  const note = clip(String(row.note || row.reason || row.explanation || fb.note || '').trim(), 280) || undefined;

  const normalized = {
    mode,
    query: query || undefined,
    source_types: [...new Set(sourceTypes)],
    surface_ids: [...new Set(surfaceIds)],
    reasons: [...new Set(reasons)],
    agent_ids: [...new Set(agents)],
    required: required || undefined,
    confidence,
    max_chars: maxChars,
    classifier,
    note,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== '';
  }));
}

export function hasRouterMemoryRouting(plan = {}) {
  const row = asObject(plan);
  return !!(row.mode || row.query || row.source_types || row.surface_ids || row.reasons || row.required || row.classifier);
}

export function mergeRouterMemoryRouting(base = {}, override = {}) {
  const a = normalizeRouterMemoryRouting(base);
  const b = normalizeRouterMemoryRouting(override);
  const merged = normalizeRouterMemoryRouting({
    ...a,
    ...b,
    query: b.query || a.query,
    source_types: [...(a.source_types || []), ...(b.source_types || [])],
    surface_ids: [...(a.surface_ids || []), ...(b.surface_ids || [])],
    reasons: [...(a.reasons || []), ...(b.reasons || [])],
    agent_ids: [...(a.agent_ids || []), ...(b.agent_ids || [])],
    confidence: b.confidence ?? a.confidence,
  });
  return merged;
}

function actionMemoryRouting(rawAction = {}, topLevelRouting = {}) {
  const action = asObject(rawAction);
  const explicit = normalizeRouterMemoryRouting(
    action.memory_routing || action.memoryRouting || action.memory_demand || action.memoryDemand || asObject(action.scope || action.lens || {}).memory_demand,
    {}
  );
  const top = normalizeRouterMemoryRouting(topLevelRouting);
  if (top.agent_ids && top.agent_ids.length > 0) {
    const agentId = String(action.agent_id || action.agentId || action.agent || '').trim().toLowerCase();
    if (agentId && !top.agent_ids.includes(agentId) && Object.keys(explicit).length === 0) return {};
  }
  return mergeRouterMemoryRouting(top, explicit);
}

function attachToScope(rawAction = {}, memoryRouting = {}) {
  const action = { ...asObject(rawAction) };
  if (!memoryRouting || Object.keys(memoryRouting).length === 0) return action;
  const scope = asObject(action.scope || action.scope_hint || action.scopeHint || action.lens || action.lens_spec || action.lensSpec);
  const explicitBudget = Number(scope.budget_tokens ?? scope.budgetTokens);
  const derivedBudget = Number.isFinite(explicitBudget)
    ? Math.max(200, Math.min(12000, Math.floor(explicitBudget)))
    : (memoryRouting.max_chars ? Math.max(600, Math.min(12000, Math.ceil(Number(memoryRouting.max_chars || 2400) / 4))) : undefined);
  action.scope = {
    ...scope,
    mode: scope.mode || (memoryRouting.query ? 'unfold_query' : 'shared_only'),
    query: scope.query || memoryRouting.query || undefined,
    budget_tokens: derivedBudget,
    memory_demand: memoryRouting,
  };
  action.lens = action.scope;
  return action;
}

export function attachMemoryRoutingToRawPlan(rawPlan = {}, topLevelRouting = {}) {
  const plan = { ...asObject(rawPlan) };
  const top = normalizeRouterMemoryRouting(topLevelRouting || plan.memory_routing || plan.memoryRouting || plan.memory_plan || plan.memoryPlan || {});
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  plan.actions = actions.map((action) => {
    const row = asObject(action);
    if (row.type === 'spawn_agents' || row.type === 'spawn' || row.type === 'fork_join') {
      const parentRouting = actionMemoryRouting(row, top);
      const next = attachToScope(row, parentRouting);
      const children = Array.isArray(row.agents) ? row.agents : (Array.isArray(row.children) ? row.children : []);
      next.agents = children.map((child) => attachToScope(child, actionMemoryRouting(child, parentRouting)));
      return next;
    }
    if (row.type === 'run_agent' || row.type === 'agent_run') {
      return attachToScope(row, actionMemoryRouting(row, top));
    }
    return row;
  });
  if (Object.keys(top).length > 0) plan.memory_routing = top;
  return plan;
}

export function buildRouterMemoryRoutingInstruction() {
  return [
    'memory_routing 규칙:',
    '- 너는 agent router인 동시에 memory router다. agent 선택과 필요한 memory retrieval 계획을 함께 결정한다.',
    '- agent_id를 잘 고르는 것만으로 충분하지 않다. 같은 agent라도 질문마다 필요한 과거 맥락이 달라진다.',
    '- 이전 대화, 첨부, 작업 상태, 결정사항, 사용자 사실, 정정/제약이 필요하면 top-level memory_routing 또는 run_agent.scope.memory_demand에 명시한다.',
    '- memory_routing.source_types는 turns, summary, task_state, shared_work, artifacts, user_facts, decisions 중에서 고른다.',
    '- 표현이 정확히 “아까/전에/파일”이 아니어도 의미상 과거 맥락이 필요하면 continuity/task/artifact/user_fact memory를 요청한다.',
    '- single/compact memory 단계에서는 source_types를 넓게 주고, team_scoped 단계에서는 필요한 surface_ids도 함께 준다.',
    '- 불필요한 memory 확장은 피한다. 단순 새 질문이면 memory_routing.mode=minimal 또는 생략한다.',
  ].join('\n');
}
