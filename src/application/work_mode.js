function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function uniq(values = [], max = 12) {
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

export const WORK_MODE_DEFAULTS = Object.freeze({
  quick_answer: Object.freeze({
    label: 'Quick Answer',
    agents_hint: 'single_agent',
    context_depth: 'minimal',
    team_skeleton: 'single_agent',
    loop_budget: 0,
    stop_condition: 'answer_ready',
    review_policy: 'none',
    memory_mode: 'none',
    goc_mode: 'optional',
  }),
  assisted_task: Object.freeze({
    label: 'Assisted Task',
    agents_hint: 'single_agent_plus_tools',
    context_depth: 'light',
    team_skeleton: 'single_agent',
    loop_budget: 1,
    stop_condition: 'stage_complete',
    review_policy: 'optional',
    memory_mode: 'light',
    goc_mode: 'optional',
  }),
  team_review: Object.freeze({
    label: 'Team Review',
    agents_hint: 'small_review_team',
    context_depth: 'projected',
    team_skeleton: 'builder_reviewer',
    loop_budget: 2,
    stop_condition: 'review_complete',
    review_policy: 'required',
    memory_mode: 'package',
    goc_mode: 'recommended',
  }),
  project_task: Object.freeze({
    label: 'Project Task',
    agents_hint: 'bounded_project_team',
    context_depth: 'workspace',
    team_skeleton: 'planner_builder_reviewer',
    loop_budget: 5,
    stop_condition: 'tests_pass_or_stage_complete',
    review_policy: 'required',
    memory_mode: 'package',
    goc_mode: 'required',
  }),
  research_campaign: Object.freeze({
    label: 'Research Campaign',
    agents_hint: 'staged_research_team',
    context_depth: 'structured',
    team_skeleton: 'research_planner_evidence_writer_review',
    loop_budget: 'staged',
    stop_condition: 'user_checkpoint',
    review_policy: 'stage_gate',
    memory_mode: 'structured',
    goc_mode: 'required',
  }),
  customize: Object.freeze({
    label: 'Customize',
    agents_hint: 'user_defined_agents',
    context_depth: 'custom',
    team_skeleton: 'custom',
    loop_budget: 'custom',
    stop_condition: 'approval_required',
    review_policy: 'stage_gate',
    memory_mode: 'package',
    goc_mode: 'required',
  }),
});

const VALID_WORK_MODES = Object.freeze(Object.keys(WORK_MODE_DEFAULTS));

function normalizeMode(value = '') {
  const mode = cleanId(value || '');
  const alias = {
    quick: 'quick_answer',
    quickanswer: 'quick_answer',
    quick_answer: 'quick_answer',
    answer: 'quick_answer',
    assisted: 'assisted_task',
    assistedtask: 'assisted_task',
    assisted_task: 'assisted_task',
    task: 'assisted_task',
    team: 'team_review',
    review: 'team_review',
    teamreview: 'team_review',
    team_review: 'team_review',
    project: 'project_task',
    projecttask: 'project_task',
    project_task: 'project_task',
    research: 'research_campaign',
    campaign: 'research_campaign',
    researchcampaign: 'research_campaign',
    research_campaign: 'research_campaign',
    customize: 'customize',
    custom: 'customize',
  };
  return VALID_WORK_MODES.includes(mode) ? mode : (alias[mode] || '');
}

function explicitModeFromText(text = '') {
  const value = clean(text).toLowerCase();
  if (!value) return '';
  const direct = value.match(/(?:work\s*mode|agent\s*work\s*depth|mode|모드|작업\s*깊이)\s*[:=：]\s*([a-zA-Z_\- ]{3,40}|빠른\s*답변|간단\s*답변|보조\s*작업|팀\s*검토|프로젝트\s*작업|연구\s*캠페인|커스텀|사용자\s*정의)/);
  if (direct) {
    const raw = cleanId(direct[1]);
    if (/빠른|간단|quick/.test(raw)) return 'quick_answer';
    if (/보조|assist/.test(raw)) return 'assisted_task';
    if (/팀|검토|review/.test(raw)) return 'team_review';
    if (/프로젝트|project/.test(raw)) return 'project_task';
    if (/연구|캠페인|research/.test(raw)) return 'research_campaign';
    if (/커스텀|사용자|custom/.test(raw)) return 'customize';
    return normalizeMode(raw);
  }
  if (/quick\s*answer|빠른\s*답변|간단\s*답변|짧게\s*답만/.test(value)) return 'quick_answer';
  if (/assisted\s*task|보조\s*작업|한\s*번\s*정도\s*작업|간단한\s*작업/.test(value)) return 'assisted_task';
  if (/team\s*review|팀\s*검토|리뷰\s*모드|검토\s*모드/.test(value)) return 'team_review';
  if (/project\s*task|프로젝트\s*작업|작업\s*모드|bounded\s*loop|코드\s*패치\s*작업/.test(value)) return 'project_task';
  if (/research\s*campaign|연구\s*캠페인|리서치\s*캠페인|논문\s*작성\s*캠페인|staged\s*research/.test(value)) return 'research_campaign';
  if (/customize|custom\s*mode|커스텀|사용자\s*정의/.test(value)) return 'customize';
  return '';
}

export function inferWorkMode(taskText = '', { explicitMode = '', runtime = null, userOrchestrationIntent = null, memoryImportIntent = null, stress = null } = {}) {
  const text = clean(taskText).toLowerCase();
  const runtimeRow = asObject(runtime);
  const userIntent = asObject(userOrchestrationIntent);
  const memoryIntent = asObject(memoryImportIntent);
  const s = asObject(stress);
  const reasonCodes = [];
  let mode = normalizeMode(explicitMode || runtimeRow.workMode || runtimeRow.work_mode || runtimeRow.agentWorkDepth || runtimeRow.agent_work_depth);
  if (mode) reasonCodes.push('explicit_work_mode');
  if (!mode) {
    mode = explicitModeFromText(text);
    if (mode) reasonCodes.push('explicit_work_mode_text');
  }
  if (!mode && !/논문작성팀|논문\s*팀|paper\s*(writing)?\s*team/.test(text) && /survey\s*paper|literature\s*review|related\s*work|연구\s*질문|읽을\s*논문|논문\s*(초안|작성|서론|관련\s*연구|실험|방법|방법론)|evidence\s*matrix|claim\s*table|출처\s*목록|citation|실험\s*계획|research\s*plan/.test(text)) {
    mode = 'research_campaign';
    reasonCodes.push('research_campaign_task_detected');
  }
  if (!mode && (/repo|patch|code|구현|코드|개발|테스트|test|artifact|workspace|보고서|리포트|문서\s*작성|슬라이드|deck/.test(text) || Number(s.workspace_mutation || 0) >= 0.55 || Number(s.artifact_pressure || 0) >= 0.65)) {
    mode = 'project_task';
    reasonCodes.push('project_artifact_task_detected');
  }
  if (!mode && (['explicit', 'preferred'].includes(cleanId(userIntent.team_intent || '')) || /reviewer|검토|리뷰|second\s*opinion|double[-\s]?check|여러\s*관점|비판적/.test(text))) {
    mode = 'team_review';
    reasonCodes.push('team_review_requested_or_implied');
  }
  if (!mode && (memoryIntent.import_intent && memoryIntent.import_intent !== 'none')) {
    mode = 'team_review';
    reasonCodes.push('memory_import_needs_structured_review');
  }
  if (!mode && /draft|rewrite|다듬|수정|요약|정리|작성|분석/.test(text)) {
    mode = 'assisted_task';
    reasonCodes.push('assisted_task_detected');
  }
  if (!mode) {
    mode = 'quick_answer';
    reasonCodes.push('default_quick_answer');
  }
  return {
    work_mode: mode,
    reason_codes: uniq(reasonCodes, 8),
    explicit: reasonCodes.some((code) => code.startsWith('explicit_work_mode')),
  };
}

export function summarizeWorkModeConfig(config = {}) {
  const row = asObject(config);
  const mode = normalizeMode(row.work_mode || row.mode || row.id) || 'quick_answer';
  const defaults = WORK_MODE_DEFAULTS[mode] || WORK_MODE_DEFAULTS.quick_answer;
  const reasonCodes = uniq(row.reason_codes || [], 10);
  return {
    kind: 'work_mode_config_v1',
    work_mode: mode,
    label: clean(row.label || defaults.label) || defaults.label,
    agents_hint: cleanId(row.agents_hint || defaults.agents_hint) || defaults.agents_hint,
    context_depth: cleanId(row.context_depth || defaults.context_depth) || defaults.context_depth,
    team_skeleton: cleanId(row.team_skeleton || defaults.team_skeleton) || defaults.team_skeleton,
    loop_budget: row.loop_budget ?? defaults.loop_budget,
    stop_condition: cleanId(row.stop_condition || defaults.stop_condition) || defaults.stop_condition,
    review_policy: cleanId(row.review_policy || defaults.review_policy) || defaults.review_policy,
    memory_mode: cleanId(row.memory_mode || defaults.memory_mode) || defaults.memory_mode,
    goc_mode: cleanId(row.goc_mode || defaults.goc_mode) || defaults.goc_mode,
    explicit: row.explicit === true,
    reason_codes: reasonCodes,
  };
}

export function buildWorkModeConfig({ request = '', explicitMode = '', runtime = null, userOrchestrationIntent = null, memoryImportIntent = null, stress = null } = {}) {
  const inferred = inferWorkMode(request, { explicitMode, runtime, userOrchestrationIntent, memoryImportIntent, stress });
  return summarizeWorkModeConfig({ ...inferred });
}

export function buildCyclePolicyForWorkMode(workModeConfig = {}) {
  const mode = summarizeWorkModeConfig(workModeConfig);
  return {
    kind: 'bounded_work_cycle_policy_v1',
    work_mode: mode.work_mode,
    loop_budget: mode.loop_budget,
    stop_condition: mode.stop_condition,
    review_policy: mode.review_policy,
    goc_mode: mode.goc_mode,
    cycle_shape: mode.work_mode === 'research_campaign' ? 'staged_checkpoints' : (Number(mode.loop_budget || 0) <= 0 ? 'answer_and_stop' : 'plan_act_report_stop'),
    approval_gate: ['required', 'stage_gate'].includes(mode.review_policy),
    observable_output: mode.work_mode === 'quick_answer' ? 'telegram_result' : 'telegram_and_goc_summary',
    memory_write_policy: mode.memory_mode === 'none' ? 'none' : (mode.memory_mode === 'light' ? 'propose_light_note' : 'proposal_only'),
  };
}

export function rolesForWorkMode(workMode = 'quick_answer', { request = '', targetTeam = 'general' } = {}) {
  const mode = normalizeMode(workMode) || 'quick_answer';
  const text = clean(request).toLowerCase();
  const target = cleanId(targetTeam || 'general') || 'general';
  if (mode === 'quick_answer') return ['single_agent'];
  if (mode === 'assisted_task') return /research|조사|분석/.test(text) ? ['researcher'] : ['builder'];
  if (mode === 'team_review') return /research|조사|분석|논문|paper/.test(text) || target === 'paper' ? ['researcher', 'synthesizer', 'reviewer'] : ['builder', 'reviewer'];
  if (mode === 'project_task') {
    if (target === 'paper' || /논문|paper|report|보고서/.test(text)) return ['researcher', 'synthesizer', 'reviewer', 'artifact_verifier'];
    if (target === 'presentation' || /slide|deck|발표|슬라이드/.test(text)) return ['researcher', 'synthesizer', 'reviewer', 'artifact_verifier'];
    return ['operator', 'builder', 'reviewer', 'synthesizer'];
  }
  if (mode === 'research_campaign') return ['operator', 'researcher', 'synthesizer', 'reviewer', 'builder'];
  if (mode === 'customize') return ['operator', 'builder', 'reviewer', 'synthesizer'];
  return ['builder'];
}

export function candidateSatisfiesWorkMode(candidate = {}, workModeConfig = {}) {
  const mode = summarizeWorkModeConfig(workModeConfig);
  const roles = uniq(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((agent) => agent.role), 16);
  const roleSet = new Set(roles);
  const agentCount = Number(candidate.agent_count || candidate.team?.agents?.length || roles.length || 1);
  if (mode.work_mode === 'quick_answer') {
    return { satisfied: agentCount <= 1 || roleSet.has('single_agent') || roleSet.has('solo'), reason: agentCount <= 1 ? 'quick_answer_single_agent' : 'quick_answer_overbuilt_team' };
  }
  if (mode.work_mode === 'assisted_task') {
    return { satisfied: agentCount <= 2, reason: agentCount <= 2 ? 'assisted_task_bounded' : 'assisted_task_overbuilt_team' };
  }
  if (mode.work_mode === 'team_review') {
    const ok = agentCount >= 2 && (roleSet.has('reviewer') || roleSet.has('tester') || roleSet.has('artifact_verifier'));
    return { satisfied: ok, reason: ok ? 'team_review_has_reviewer' : 'team_review_needs_review_role' };
  }
  if (mode.work_mode === 'project_task') {
    const hasWorker = roleSet.has('builder') || roleSet.has('researcher') || roleSet.has('synthesizer');
    const hasVerifier = roleSet.has('reviewer') || roleSet.has('tester') || roleSet.has('artifact_verifier');
    const ok = agentCount >= 3 && hasWorker && hasVerifier;
    return { satisfied: ok, reason: ok ? 'project_task_bounded_team' : 'project_task_needs_worker_and_verifier' };
  }
  if (mode.work_mode === 'research_campaign') {
    const ok = agentCount >= 4 && roleSet.has('researcher') && roleSet.has('synthesizer') && roleSet.has('reviewer');
    return { satisfied: ok, reason: ok ? 'research_campaign_staged_team' : 'research_campaign_needs_research_synthesis_review' };
  }
  return { satisfied: true, reason: 'custom_or_unspecified' };
}
