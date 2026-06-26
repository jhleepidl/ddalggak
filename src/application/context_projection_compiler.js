import crypto from 'node:crypto';

import { getContextProjection, summarizeContextSubstrate } from './context_substrate_store.js';
import { rememberCompiledProjection, getRecentRunContextHandoffs } from './run_context_cache.js';
import { appendContextRuntimeMetric, estimateContextTokens } from './context_runtime_metrics.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function stableHash(value = '') { return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12); }
function clip(value = '', max = 4000) { const s = String(value || ''); return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s; }
function nowMs() { return Date.now(); }

function looksLikeCasualRecommendation(goal = '') {
  const text = clean(goal).toLowerCase();
  if (!text) return false;
  const casual = /메뉴|식당|저녁|점심|아침|회식|맛집|추천|먹을|음식|restaurant|menu|dinner|lunch|recommend/.test(text);
  const implementation = /code|implement|build|fix|test|refactor|patch|webapp|src\/|코드|구현|패치|리팩터|테스트|레포|workspace|repo/.test(text);
  return casual && !implementation;
}

function inferTaskType({ taskType = '', goal = '', role = '' } = {}) {
  const explicit = clean(taskType).toLowerCase();
  if (explicit) return explicit;
  if (looksLikeCasualRecommendation(goal)) return 'general_task';
  const text = `${goal} ${role}`.toLowerCase();
  if (/code|implement|build|fix|test|refactor|patch|webapp|src\//.test(text)) return 'code_change';
  if (/review|verify|검토|리뷰|검증/.test(text)) return 'review';
  if (/research|source|evidence|뉴스|검색|조사/.test(text)) return 'research';
  if (/synth|summary|final|최종|요약/.test(text)) return 'synthesis';
  return 'general_task';
}

function compactAtomLine(atom = {}) {
  const type = clean(atom.atom_type || 'memory');
  const title = clean(atom.title || atom.id || type);
  const text = clean(atom.canonical_text_en || atom.text_original || '');
  const tags = asArray(atom.tags).map(clean).filter(Boolean).slice(0, 4).join(',');
  return `- [${type}] ${title}${text ? `: ${clip(text, 260)}` : ''}${tags ? ` (${tags})` : ''}`;
}

function compactLinkLine(link = {}) {
  return `- ${clean(link.from)} --${clean(link.type || 'related_to')}--> ${clean(link.to)}${Number.isFinite(Number(link.weight)) ? ` (${Number(link.weight).toFixed(2)})` : ''}`;
}

function formatProjectionBlock({ projection = {}, role = '', taskType = '', modelNode = '', budgetTokens = 1800, baseContextText = '', handoffs = [] } = {}) {
  const atoms = asArray(projection.atoms);
  const links = asArray(projection.links);
  const handoffLines = asArray(handoffs).slice(-4).map((handoff) => {
    const delta = asObject(handoff.delta);
    const bits = [
      delta.output_summary ? clip(delta.output_summary, 220) : '',
      asArray(delta.findings).length ? `findings=${asArray(delta.findings).slice(0, 3).join('; ')}` : '',
      asArray(delta.verification_notes).length ? `verification=${asArray(delta.verification_notes).slice(0, 2).join('; ')}` : '',
    ].filter(Boolean).join(' | ');
    return `- ${clean(handoff.from_agent || 'agent')} → ${clean(handoff.to_agent || role || 'agent')} (${clean(handoff.handoff_type || 'delta')}): ${bits || clip(handoff.summary || '', 220)}`;
  });
  const parts = [
    '[CONTEXT PROJECTION]',
    `projection_id: ${clean(projection.projection_id || '')}`,
    `snapshot_id: ${clean(projection.snapshot_id || 'ctx_000000')}`,
    `role: ${clean(role || projection.query?.role || 'agent')}`,
    `task_type: ${clean(taskType || projection.query?.task_type || 'general_task')}`,
    modelNode ? `model_node: ${modelNode}` : '',
    `cache_hit: ${projection.cache_hit === true ? 'true' : 'false'}`,
    '',
    atoms.length ? 'Relevant context atoms:' : 'Relevant context atoms: none selected',
    ...atoms.slice(0, 16).map(compactAtomLine),
    links.length ? '\nRelevant context links:' : '',
    ...links.slice(0, 12).map(compactLinkLine),
    handoffLines.length ? '\nRecent typed handoff deltas:' : '',
    ...handoffLines,
    baseContextText ? '\nLegacy/context-engine fallback projection:' : '',
    baseContextText ? clip(baseContextText, Math.max(1200, Math.floor(Number(budgetTokens || 1800) * 2))) : '',
  ].filter((line) => line !== '');
  return parts.join('\n');
}

export function compileAgentContextProjection({
  jobId = '',
  chatId = '',
  threadId = '',
  agentId = '',
  roleId = '',
  taskType = '',
  modelNode = '',
  goal = '',
  baseContextText = '',
  baseContextInfo = {},
  budgetTokens = 1800,
  rootDir = process.cwd(),
  runDir = '',
  cache = true,
  includeHandoffs = true,
} = {}) {
  const started = nowMs();
  const role = clean(roleId || agentId || 'agent').toLowerCase();
  const inferredTaskType = inferTaskType({ taskType, goal, role });
  const budget = Number.isFinite(Number(budgetTokens)) ? Math.max(300, Math.floor(Number(budgetTokens))) : 1800;
  const substrateOptions = { rootDir, jobId, runDir };
  const substrateSummary = summarizeContextSubstrate(substrateOptions);
  const query = {
    role,
    task_type: inferredTaskType,
    goal: clean(goal),
    budget_tokens: budget,
    scope: clean(baseContextInfo?.context_set_id || baseContextInfo?.lens_context_set_id || chatId || threadId || ''),
    limit: Number(process.env.CONTEXT_PROJECTION_ATOM_LIMIT || 24),
    cache,
  };
  const rawProjection = getContextProjection(substrateOptions, query);
  const projectionId = `proj_${stableHash(JSON.stringify({ snapshot: rawProjection.snapshot_id, role, inferredTaskType, goal: clean(goal).slice(0, 500), modelNode, budget }))}`;
  const handoffs = includeHandoffs ? getRecentRunContextHandoffs({ agentId: role, limit: 6 }, { rootDir, jobId, runDir }) : [];
  const projection = {
    ...rawProjection,
    projection_id: projectionId,
    role,
    task_type: inferredTaskType,
    model_node: clean(modelNode),
  };
  const promptBlock = formatProjectionBlock({
    projection,
    role,
    taskType: inferredTaskType,
    modelNode,
    budgetTokens: budget,
    baseContextText,
    handoffs,
  });
  const metrics = {
    projection_id: projectionId,
    snapshot_id: projection.snapshot_id,
    cache_hit: projection.cache_hit === true,
    compile_ms: nowMs() - started,
    context_tokens: estimateContextTokens(promptBlock),
    selected_atom_count: projection.atom_count || 0,
    selected_link_count: projection.link_count || 0,
    handoff_count: handoffs.length,
    substrate_atom_count: substrateSummary.atom_count || 0,
    substrate_link_count: substrateSummary.link_count || 0,
  };
  rememberCompiledProjection({ ...projection, metrics, context_tokens: metrics.context_tokens }, { rootDir, jobId, runDir });
  appendContextRuntimeMetric('projection', {
    ...metrics,
    agent_id: clean(agentId),
    role_id: role,
    task_type: inferredTaskType,
    model_node: clean(modelNode),
    goal_hash: stableHash(clean(goal)),
  }, { rootDir, jobId, runDir });
  return {
    ok: true,
    kind: 'compiled_context_projection_v1',
    projection_id: projectionId,
    snapshot_id: projection.snapshot_id,
    role,
    task_type: inferredTaskType,
    model_node: clean(modelNode),
    query,
    projection,
    prompt_block: promptBlock,
    metrics,
    base_context_info: asObject(baseContextInfo),
  };
}

export function attachCompiledProjectionToPreparedContext(prepared = {}, compiled = {}) {
  const contextInfo = {
    ...(prepared?.context_info && typeof prepared.context_info === 'object' ? prepared.context_info : {}),
    projection_id: compiled.projection_id,
    snapshot_id: compiled.snapshot_id,
    context_projection: {
      projection_id: compiled.projection_id,
      snapshot_id: compiled.snapshot_id,
      role: compiled.role,
      task_type: compiled.task_type,
      model_node: compiled.model_node,
      cache_hit: compiled.metrics?.cache_hit === true,
      compile_ms: compiled.metrics?.compile_ms,
      context_tokens: compiled.metrics?.context_tokens,
      selected_atom_count: compiled.metrics?.selected_atom_count,
      selected_link_count: compiled.metrics?.selected_link_count,
      handoff_count: compiled.metrics?.handoff_count,
    },
    compiled_tokens_estimate: compiled.metrics?.context_tokens || prepared?.context_info?.compiled_tokens_estimate,
    token_estimate: compiled.metrics?.context_tokens || prepared?.context_info?.token_estimate,
    compiled_chars: String(compiled.prompt_block || '').length || prepared?.context_info?.compiled_chars,
  };
  return {
    ...prepared,
    final_prompt: clean(compiled.prompt_block) || clean(prepared?.final_prompt),
    context_info: contextInfo,
  };
}
