import { inferUserOrchestrationIntent, summarizeUserOrchestrationIntent } from './team_user_orchestration_intent.js';
import { buildTaskAttemptPlan, summarizeTaskAttemptPlan } from './task_attempt_planner.js';
import { summarizeMemoryImportIntent } from './team_memory_import_intent.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function clampNum(value, min = 0, max = 1) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }

const CANDIDATE_LABEL_ORDER = [
  'Y_UTIL',
  'Y_DEBT',
  'Y_FRONTIER_NEEDED',
  'Y_ADD_REVIEWER',
  'Y_ADD_RESEARCHER',
  'Y_ADD_ARTIFACT_VERIFIER',
  'Y_ADD_ARBITER',
];

const VALID_LABELS = {
  Y_UTIL: new Set(['bad', 'ok', 'good']),
  Y_DEBT: new Set(['low', 'med', 'high']),
  Y_FRONTIER_NEEDED: new Set(['yes', 'no']),
  Y_ADD_REVIEWER: new Set(['yes', 'no']),
  Y_ADD_RESEARCHER: new Set(['yes', 'no']),
  Y_ADD_ARTIFACT_VERIFIER: new Set(['yes', 'no']),
  Y_ADD_ARBITER: new Set(['yes', 'no']),
};

function bucket(value, { low = 0.34, high = 0.67 } = {}) {
  const n = clampNum(value, 0, 1);
  if (n >= high) return 'high';
  if (n >= low) return 'med';
  return 'low';
}

function uniq(values = [], max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function inferSkeletonTaskType({ request = '', candidate = {}, stress = {} } = {}) {
  const text = `${request} ${asArray(candidate.tags).join(' ')} ${asArray(candidate.task_types).join(' ')}`.toLowerCase();
  if (/deploy|release|rollback|approval|배포|릴리즈/.test(text) || Number(stress.deployment_risk || 0) >= 0.55) return 'deployment';
  if (/api|tool|function|provider|cli|도구|툴/.test(text) || Number(stress.tool_risk || stress.tool_pressure || 0) >= 0.55) return 'tool_use';
  if (/search|research|evidence|brief|조사|분석|리서치/.test(text) || Number(stress.current_info_need || 0) >= 0.55) return 'research_synthesis';
  if (/code|patch|repo|test|bug|fix|workspace|구현|코드|패치|수정/.test(text) || Number(stress.workspace_mutation || 0) >= 0.45) return 'code_patch';
  if (/artifact|document|write|draft|문서|산출물|소설|글/.test(text) || Number(stress.artifact_pressure || 0) >= 0.45) return 'artifact_generation';
  if (/memory|privacy|private|remember|기억|메모리/.test(text)) return 'memory_update';
  if (asArray(candidate.roles).length >= 4 || Number(stress.coordination_need || stress.overall || 0) >= 0.7) return 'multi_agent_coordination';
  return 'chat_answer';
}

export function skeletonPressureBuckets(stress = {}, { taskType = 'unknown' } = {}) {
  const s = asObject(stress);
  return {
    TASK: bucket(s.overall ?? s.task_pressure ?? 0),
    VERIFY: bucket(s.verification_need ?? s.verify ?? 0),
    FAILURE: bucket(s.failure_risk ?? s.recovery_pressure ?? s.regression_risk ?? 0),
    CONTEXT: bucket(s.context_pressure ?? s.context_risk ?? s.memory_pressure ?? 0),
    RISK: bucket(s.side_effect_risk ?? s.risk ?? s.deployment_risk ?? 0),
    TOOL: bucket(s.tool_risk ?? s.tool_pressure ?? (taskType === 'tool_use' ? 0.8 : 0)),
    ARTIFACT: bucket(s.artifact_pressure ?? s.workspace_mutation ?? 0),
    COORD: bucket(s.coordination_need ?? s.overall ?? 0),
    MODEL: bucket(s.model_pressure ?? s.frontier_pressure ?? 0),
  };
}

function normalizeRole(role = '') {
  const r = cleanId(role);
  if (!r) return '';
  if (['critic', 'judge', 'auditor'].includes(r)) return 'reviewer';
  if (['writer', 'coder', 'implementer', 'developer'].includes(r)) return 'builder';
  if (['qa', 'test', 'verifier'].includes(r)) return 'tester';
  if (['approver', 'approval'].includes(r)) return 'user_approval';
  if (['artifact_check', 'artifact_reviewer'].includes(r)) return 'artifact_verifier';
  return r;
}

export function skeletonRolesFromCandidate(candidate = {}, { taskType = 'unknown' } = {}) {
  const roles = uniq(asArray(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((a) => a.role)).map(normalizeRole), 16);
  if (roles.length > 0) return roles;
  if (taskType === 'code_patch') return ['builder', 'tester', 'reviewer'];
  if (taskType === 'tool_use') return ['planner', 'tool_executor', 'reviewer'];
  if (taskType === 'research_synthesis') return ['researcher', 'synthesizer', 'reviewer'];
  if (taskType === 'deployment') return ['planner', 'builder', 'risk_reviewer', 'user_approval'];
  if (taskType === 'artifact_generation') return ['builder', 'artifact_verifier'];
  return ['solo'];
}

function modelTierForRole(role = '') {
  return {
    solo: 'cheap_api', planner: 'cheap_api', builder: 'local_code', tester: 'tool', reviewer: 'cheap_api',
    researcher: 'cheap_api', synthesizer: 'cheap_api', risk_reviewer: 'frontier', context_curator: 'local_small',
    artifact_verifier: 'local_small', tool_executor: 'tool', web_agent: 'cheap_api', skill_router: 'local_small',
    arbiter: 'frontier', user_approval: 'human',
  }[cleanId(role)] || 'cheap_api';
}

function contextForRole(role = '', taskType = 'unknown') {
  const r = cleanId(role);
  if (r === 'reviewer') return 'patch_only';
  if (['context_curator', 'artifact_verifier'].includes(r)) return 'workspace_manifest';
  if (['researcher', 'tool_executor', 'web_agent', 'skill_router'].includes(r)) return 'task_only';
  if (r === 'builder') return taskType === 'code_patch' ? 'compressed' : 'relevant_memory';
  return 'task_only';
}

function inferFlow(taskType = 'unknown', roles = [], pressures = {}) {
  const r = new Set(roles.map(cleanId));
  if (r.size <= 1) return 'solo';
  if (r.has('user_approval') || r.has('risk_reviewer')) return 'approval_chain';
  if (r.has('arbiter') && (r.has('reviewer') || pressures.RISK === 'high')) return 'hierarchical';
  if (['research_synthesis', 'multi_agent_coordination'].includes(taskType)) return r.has('synthesizer') ? 'parallel_map_reduce' : 'hub_spoke';
  if (['code_patch', 'artifact_generation', 'deployment'].includes(taskType)) return 'pipeline';
  if (['tool_use', 'tool_selection', 'web_navigation'].includes(taskType)) return 'linear';
  if (pressures.COORD === 'high') return 'hub_spoke';
  return 'linear';
}

function inferSync(taskType = 'unknown', roles = [], pressures = {}) {
  const r = new Set(roles.map(cleanId));
  if (r.has('user_approval')) return 'human_gate';
  if (r.has('arbiter')) return 'arbiter_gate';
  if (r.has('tester') && taskType === 'code_patch') return 'test_gate';
  if (r.has('reviewer')) return 'review_gate';
  if (['research_synthesis', 'multi_agent_coordination'].includes(taskType) && r.has('synthesizer')) return 'leader_merge';
  if (r.size <= 1) return 'none';
  if (pressures.COORD === 'high') return 'barrier';
  return 'none';
}

function inferWidthDepthControl(roles = [], flow = 'linear') {
  const n = new Set(roles.map(cleanId)).size;
  const width = flow.includes('parallel') ? 'parallel' : (n <= 1 ? 'solo' : (n <= 3 ? 'narrow' : 'wide'));
  const depth = ['pipeline', 'approval_chain'].includes(flow) ? (n >= 4 ? 'deep' : 'medium') : (n <= 2 ? 'shallow' : 'medium');
  const control = flow === 'approval_chain' ? 'approval' : (flow.includes('parallel') ? 'fanout_merge' : (['hub_spoke', 'hierarchical'].includes(flow) ? 'leader' : (flow === 'debate' ? 'debate' : 'handoff')));
  return { width, depth, control };
}

function capabilityTokens(taskType = 'unknown', roles = [], pressures = {}) {
  const r = new Set(roles.map(cleanId));
  const out = [];
  if (r.has('builder')) out.push(['code_patch', 'artifact_generation'].includes(taskType) ? 'CAP=workspace_write' : 'CAP=workspace_read');
  if (r.has('tester') || taskType === 'code_patch') out.push('CAP=tests');
  if (r.has('tool_executor') || ['tool_use', 'tool_selection'].includes(taskType)) out.push('CAP=api_or_tool');
  if (r.has('skill_router') || taskType === 'tool_selection') out.push('CAP=skill_routing');
  if (r.has('web_agent') || r.has('researcher')) out.push('CAP=web_or_research');
  if (r.has('artifact_verifier') || pressures.ARTIFACT === 'high') out.push('CAP=artifact_verify');
  if (r.has('risk_reviewer') || pressures.RISK === 'high') out.push('CAP=risk_review');
  if (r.has('user_approval')) out.push('CAP=human_approval');
  if (r.has('arbiter')) out.push('CAP=frontier_arbitration');
  return [...new Set(out)];
}

function edgeTokens(roles = []) {
  const r = new Set(roles.map(cleanId));
  const out = [];
  if (r.has('planner') && r.has('builder')) out.push('EDGE=planner>builder:implementation_plan');
  if (r.has('planner') && r.has('tool_executor')) out.push('EDGE=planner>tool_executor:tool_request');
  if (r.has('skill_router') && r.has('tool_executor')) out.push('EDGE=skill_router>tool_executor:skill_select');
  if (r.has('tool_executor') && r.has('reviewer')) out.push('EDGE=tool_executor>reviewer:tool_result');
  if (r.has('researcher') && r.has('synthesizer')) out.push('EDGE=researcher>synthesizer:evidence');
  if (r.has('synthesizer') && r.has('reviewer')) out.push('EDGE=synthesizer>reviewer:review_request');
  if (r.has('builder') && r.has('reviewer')) out.push('EDGE=builder>reviewer:review_request', 'EDGE=reviewer>builder:repair');
  if (r.has('builder') && r.has('artifact_verifier')) out.push('EDGE=builder>artifact_verifier:artifact_check');
  if (r.has('risk_reviewer') && r.has('user_approval')) out.push('EDGE=risk_reviewer>user_approval:approval_request');
  if (r.has('reviewer') && r.has('arbiter')) out.push('EDGE=reviewer>arbiter:arbitrate');
  return out;
}

export function buildSkeletonDslTokens({ request = '', candidate = {}, stress = {}, skeletonScope = 'core', userOrchestrationIntent = null, taskAttemptPlan = null, memoryImportIntent = null } = {}) {
  const taskType = inferSkeletonTaskType({ request, candidate, stress });
  const pressures = skeletonPressureBuckets(stress, { taskType });
  const userIntent = summarizeUserOrchestrationIntent(userOrchestrationIntent || candidate.user_orchestration_intent || inferUserOrchestrationIntent(request));
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || candidate.task_attempt_plan || buildTaskAttemptPlan({ request, userOrchestrationIntent: userIntent }));
  const memoryImport = summarizeMemoryImportIntent(memoryImportIntent || candidate.memory_import_intent || attemptPlan.memory_import || {});
  const roles = skeletonRolesFromCandidate(candidate, { taskType });
  const flow = inferFlow(taskType, roles, pressures);
  const sync = inferSync(taskType, roles, pressures);
  const order = flow === 'solo' ? 'none' : (flow.includes('parallel') ? 'invariant_within_group' : (['hub_spoke', 'debate'].includes(flow) ? 'partial' : 'sensitive'));
  const { width, depth, control } = inferWidthDepthControl(roles, flow);
  const tokens = [
    '[BOS]',
    'MODE=candidate_scoring',
    'OUTPUT_SCHEMA=candidate_labels',
    'LABEL_SCHEMA=candidate_v1',
    'LABEL_KEYS=closed',
    `LABEL_ORDER=${CANDIDATE_LABEL_ORDER.join(',')}`,
    `TASK=${taskType}`,
    `U_TEAM=${userIntent.team_intent}`,
    `U_TEAM_STYLE=${userIntent.team_style}`,
    `U_TEAM_MIN=${userIntent.min_team_size}`,
    `RUN_MODE=${attemptPlan.run_mode}`,
    `RETRY_REASON=${attemptPlan.retry_reason}`,
    `PREV_RESULT=${attemptPlan.previous_result_policy}`,
    `TARGET_TEAM=${attemptPlan.target_team}`,
    `WORK_DEPTH=${attemptPlan.work_mode?.work_depth || 'instant'}`,
    `WORK_MODE=${attemptPlan.work_mode?.work_mode || 'quick_answer'}`,
    `LOOP_BUDGET=${attemptPlan.work_mode?.loop_budget ?? '0'}`,
    `STOP_CONDITION=${attemptPlan.work_mode?.stop_condition || 'answer_ready'}`,
    `REVIEW_POLICY=${attemptPlan.work_mode?.review_policy || 'none'}`,
    `MEMORY_MODE=${attemptPlan.work_mode?.memory_mode || 'none'}`,
    `GOC_MODE=${attemptPlan.work_mode?.goc_mode || 'optional'}`,
    `GOC_ACTION=${attemptPlan.goc?.action || 'optional_review'}`,
    `MEM_IMPORT=${memoryImport.import_intent}`,
    `MEM_MODE=${memoryImport.mode}`,
    `MEM_PROFILE=${memoryImport.projection_profile}`,
    `MEM_SCOPE=${memoryImport.scope}`,
    `MEM_PERM=${memoryImport.permissions?.read_only ? 'read_only' : 'write_allowed'}`,
    `MEM_FORK=${memoryImport.fork_policy}`,
    `SKELETON_SCOPE=${skeletonScope}`,
    'DESIGN_STAGE=core_then_late_bind',
    'SKILL_POLICY=late_bind',
  ];
  for (const role of asArray(userIntent.required_roles)) tokens.push(`U_ROLE=${role}`);
  for (const code of asArray(userIntent.reason_codes)) tokens.push(`U_REASON=${code}`);
  for (const code of asArray(attemptPlan.reason_codes)) tokens.push(`ATTEMPT_REASON=${code}`);
  for (const code of asArray(memoryImport.reason_codes)) tokens.push(`MEM_REASON=${code}`);
  for (const dim of ['TASK', 'VERIFY', 'FAILURE', 'CONTEXT', 'RISK', 'TOOL', 'ARTIFACT', 'COORD', 'MODEL']) tokens.push(`P_${dim}=${pressures[dim] || 'low'}`);
  tokens.push(`FLOW=${flow}`, `ORDER=${order}`, `SYNC=${sync}`, `WIDTH=${width}`, `DEPTH=${depth}`, `CONTROL=${control}`);
  for (const role of roles) {
    tokens.push(`ROLE=${role}`, `MODEL=${modelTierForRole(role)}`, `CTX=${contextForRole(role, taskType)}`);
  }
  tokens.push(...capabilityTokens(taskType, roles, pressures), ...edgeTokens(roles));
  if (pressures.RISK === 'high') tokens.push('ESC=frontier_if_high_risk');
  else if (roles.includes('reviewer')) tokens.push('ESC=frontier_if_conflict');
  else if (roles.includes('artifact_verifier')) tokens.push('ESC=review_if_path_leak');
  else tokens.push('ESC=none');
  tokens.push('[EOS]');
  return tokens;
}

export function buildSkeletonAdvisoryRequest({ request = '', candidate = {}, stress = {}, runtime = null, userOrchestrationIntent = null, taskAttemptPlan = null, memoryImportIntent = null } = {}) {
  const userIntent = summarizeUserOrchestrationIntent(userOrchestrationIntent || candidate.user_orchestration_intent || inferUserOrchestrationIntent(request));
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || candidate.task_attempt_plan || buildTaskAttemptPlan({ request, userOrchestrationIntent: userIntent }));
  const memoryImport = summarizeMemoryImportIntent(memoryImportIntent || candidate.memory_import_intent || attemptPlan.memory_import || {});
  const tokens = buildSkeletonDslTokens({ request, candidate, stress, userOrchestrationIntent: userIntent, taskAttemptPlan: attemptPlan, memoryImportIntent: memoryImport });
  return {
    kind: 'ddalggak_skeleton_advisory_request_v1',
    candidate_id: clean(candidate.candidate_id || candidate.id || candidate.motif_id || ''),
    task_text: clean(request).slice(0, 1000),
    tokens,
    text: tokens.join(' '),
    user_orchestration_intent: userIntent,
    task_attempt_plan: attemptPlan,
    memory_import_intent: memoryImport,
    runtime_hint: runtime ? { has_runtime: true } : { has_runtime: false },
  };
}

export function parseSkeletonAdvisoryLabels(text = '') {
  const out = {};
  const diagnostics = { invalid_keys: [], invalid_values: [], missing_keys: [] };
  const pattern = /\b(Y_[A-Z0-9_]+)=([A-Za-z0-9_]+)/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (!Object.prototype.hasOwnProperty.call(VALID_LABELS, key)) {
      diagnostics.invalid_keys.push(key);
      continue;
    }
    if (!VALID_LABELS[key].has(value)) diagnostics.invalid_values.push(`${key}=${value}`);
    out[key] = value;
  }
  for (const key of CANDIDATE_LABEL_ORDER) if (!out[key]) diagnostics.missing_keys.push(key);
  return { labels: out, diagnostics };
}

export function advisoryAxisScores(labels = {}) {
  const util = { bad: -0.35, ok: 0.08, good: 0.25 }[labels.Y_UTIL] ?? 0;
  const debt = { low: 0.08, med: -0.05, high: -0.22 }[labels.Y_DEBT] ?? 0;
  const frontierPenalty = labels.Y_FRONTIER_NEEDED === 'yes' ? -0.03 : 0.03;
  const capacityBonus = ['Y_ADD_REVIEWER', 'Y_ADD_RESEARCHER', 'Y_ADD_ARTIFACT_VERIFIER', 'Y_ADD_ARBITER']
    .reduce((sum, key) => sum + (labels[key] === 'yes' ? 0.035 : 0), 0);
  return { util, debt, frontierPenalty, capacityBonus, total: util + debt + frontierPenalty + capacityBonus };
}

export function summarizeSkeletonAdvisory({ labels = {}, diagnostics = {}, source = 'none', confidence = null } = {}) {
  const capacityGaps = [];
  if (labels.Y_ADD_REVIEWER === 'yes') capacityGaps.push('reviewer');
  if (labels.Y_ADD_RESEARCHER === 'yes') capacityGaps.push('researcher');
  if (labels.Y_ADD_ARTIFACT_VERIFIER === 'yes') capacityGaps.push('artifact_verifier');
  if (labels.Y_ADD_ARBITER === 'yes') capacityGaps.push('arbiter');
  const warnings = [];
  if (labels.Y_DEBT === 'high') warnings.push('predicted_team_debt_high');
  if (labels.Y_FRONTIER_NEEDED === 'yes') warnings.push('frontier_or_external_review_needed');
  if (diagnostics?.missing_keys?.length) warnings.push('incomplete_advisory_output');
  return {
    kind: 'skeleton_advisory_v1',
    source,
    labels,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    axis_scores: advisoryAxisScores(labels),
    capacity_gaps: capacityGaps,
    warnings,
    diagnostics,
  };
}
