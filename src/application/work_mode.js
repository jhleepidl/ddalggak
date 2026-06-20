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
  ask: Object.freeze({
    label: 'Ask',
    agents_hint: 'single_agent',
    context_depth: 'minimal',
    team_skeleton: 'single_agent',
    loop_budget: 0,
    stop_condition: 'answer_ready',
    review_policy: 'none',
    memory_mode: 'none',
    goc_mode: 'optional',
  }),
  team_task: Object.freeze({
    label: 'Team Task',
    agents_hint: 'small_scoped_team',
    context_depth: 'projected',
    team_skeleton: 'builder_reviewer',
    loop_budget: 1,
    stop_condition: 'team_pass_complete',
    review_policy: 'required',
    memory_mode: 'package',
    goc_mode: 'recommended',
  }),
  team_loop_task: Object.freeze({
    label: 'Team Loop Task',
    agents_hint: 'bounded_loop_team',
    context_depth: 'workspace',
    team_skeleton: 'planner_builder_reviewer',
    loop_budget: 'bounded',
    stop_condition: 'checkpoint_or_budget',
    review_policy: 'checkpoint',
    memory_mode: 'structured_package',
    goc_mode: 'required',
  }),
});

const VALID_WORK_MODES = Object.freeze(Object.keys(WORK_MODE_DEFAULTS));

function normalizeMode(value = '') {
  const mode = cleanId(value || '');
  const alias = {
    ask: 'ask',
    single: 'ask',
    single_pass: 'ask',
    quick: 'ask',
    quickanswer: 'ask',
    quick_answer: 'ask',
    answer: 'ask',
    assisted: 'ask',
    assistedtask: 'ask',
    assisted_task: 'ask',

    task: 'team_task',
    team: 'team_task',
    teamtask: 'team_task',
    team_task: 'team_task',
    review: 'team_task',
    teamreview: 'team_task',
    team_review: 'team_task',

    loop: 'team_loop_task',
    bounded_loop: 'team_loop_task',
    teamloop: 'team_loop_task',
    team_loop: 'team_loop_task',
    teamlooptask: 'team_loop_task',
    team_loop_task: 'team_loop_task',
    project: 'team_loop_task',
    projecttask: 'team_loop_task',
    project_task: 'team_loop_task',
    research: 'team_loop_task',
    campaign: 'team_loop_task',
    researchcampaign: 'team_loop_task',
    research_campaign: 'team_loop_task',
    customize: 'team_loop_task',
    custom: 'team_loop_task',
  };
  return VALID_WORK_MODES.includes(mode) ? mode : (alias[mode] || '');
}

function explicitModeFromText(text = '') {
  const value = clean(text).toLowerCase();
  if (!value) return '';
  const direct = value.match(/(?:work\s*mode|agent\s*work\s*depth|work\s*depth|mode|모드|작업\s*깊이)\s*[:=：]\s*([a-zA-Z_\- ]{2,60}|빠른\s*답변|간단\s*답변|질문|단순\s*ask|팀\s*작업|팀\s*태스크|팀\s*검토|팀\s*루프|반복\s*작업|프로젝트\s*작업|연구\s*캠페인)/);
  if (direct) {
    const raw = cleanId(direct[1]);
    if (/^(ask|quick)$|빠른|간단|질문/.test(raw)) return 'ask';
    if (/loop|루프|반복|bounded|project|프로젝트|research|연구|캠페인/.test(raw)) return 'team_loop_task';
    if (/team|팀|검토|review|task|태스크|작업/.test(raw)) return 'team_task';
    return normalizeMode(raw);
  }
  if (/\bask\b|quick\s*answer|빠른\s*답변|간단\s*답변|짧게\s*답만|단순\s*질문/.test(value)) return 'ask';
  if (/team\s*loop\s*task|team\s*loop|bounded\s*loop|팀\s*루프|반복\s*작업|프로젝트\s*작업|연구\s*캠페인|리서치\s*캠페인|논문\s*작성\s*캠페인|staged\s*research/.test(value)) return 'team_loop_task';
  if (/team\s*task|team\s*review|팀\s*작업|팀\s*태스크|팀\s*검토|리뷰\s*모드|검토\s*모드/.test(value)) return 'team_task';
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
    mode = 'team_loop_task';
    reasonCodes.push('research_campaign_task_detected');
  }
  if (!mode && (/repo|patch|code|구현|코드|개발|테스트|test|artifact|workspace|보고서|리포트|문서\s*작성|슬라이드|deck/.test(text) || Number(s.workspace_mutation || 0) >= 0.55 || Number(s.artifact_pressure || 0) >= 0.65)) {
    mode = 'team_loop_task';
    reasonCodes.push('project_artifact_task_detected');
  }
  if (!mode && (['explicit', 'preferred'].includes(cleanId(userIntent.team_intent || '')) || /reviewer|검토|리뷰|second\s*opinion|double[-\s]?check|여러\s*관점|비판적/.test(text))) {
    mode = 'team_task';
    reasonCodes.push('team_review_requested_or_implied');
  }
  if (!mode && (memoryIntent.import_intent && memoryIntent.import_intent !== 'none')) {
    mode = 'team_task';
    reasonCodes.push('memory_import_needs_structured_review');
  }
  if (!mode && /draft|rewrite|다듬|수정|요약|정리|작성|분석/.test(text)) {
    mode = 'ask';
    reasonCodes.push('assisted_task_detected');
  }
  if (!mode) {
    mode = 'ask';
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
  const mode = normalizeMode(row.work_mode || row.mode || row.id) || 'ask';
  const defaults = WORK_MODE_DEFAULTS[mode] || WORK_MODE_DEFAULTS.ask;
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
    cycle_shape: mode.work_mode === 'team_loop_task'
      ? 'bounded_team_loop'
      : (mode.work_mode === 'team_task' ? 'team_pass_review_stop' : 'answer_and_stop'),
    approval_gate: ['required', 'stage_gate', 'checkpoint'].includes(mode.review_policy),
    observable_output: mode.work_mode === 'ask' ? 'telegram_result' : 'telegram_and_goc_summary',
    memory_write_policy: mode.memory_mode === 'none' ? 'none' : (mode.memory_mode === 'light' ? 'propose_light_note' : 'proposal_only'),
  };
}

export function rolesForWorkMode(workMode = 'ask', { request = '', targetTeam = 'general' } = {}) {
  const mode = normalizeMode(workMode) || 'ask';
  const text = clean(request).toLowerCase();
  const target = cleanId(targetTeam || 'general') || 'general';
  if (mode === 'ask') return ['single_agent'];
  if (mode === 'team_task') {
    return /research|조사|분석|논문|paper/.test(text) || target === 'paper'
      ? ['researcher', 'synthesizer', 'reviewer']
      : ['builder', 'reviewer'];
  }
  if (mode === 'team_loop_task') {
    if (target === 'paper' || /논문|paper|report|보고서|survey|literature|research/.test(text)) {
      return ['operator', 'researcher', 'synthesizer', 'reviewer', 'artifact_verifier'];
    }
    if (target === 'presentation' || /slide|deck|발표|슬라이드/.test(text)) {
      return ['operator', 'researcher', 'synthesizer', 'reviewer', 'artifact_verifier'];
    }
    return ['operator', 'builder', 'reviewer', 'synthesizer'];
  }
  return ['builder'];
}

export function candidateSatisfiesWorkMode(candidate = {}, workModeConfig = {}) {
  const mode = summarizeWorkModeConfig(workModeConfig);
  const roles = uniq(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((agent) => agent.role), 16);
  const roleSet = new Set(roles);
  const agentCount = Number(candidate.agent_count || candidate.team?.agents?.length || roles.length || 1);
  if (mode.work_mode === 'ask') {
    return {
      satisfied: agentCount <= 1 || roleSet.has('single_agent') || roleSet.has('solo'),
      reason: agentCount <= 1 ? 'ask_single_agent' : 'ask_overbuilt_team',
    };
  }
  if (mode.work_mode === 'team_task') {
    const ok = agentCount >= 2 && (roleSet.has('reviewer') || roleSet.has('tester') || roleSet.has('artifact_verifier'));
    return { satisfied: ok, reason: ok ? 'team_task_has_review_role' : 'team_task_needs_review_role' };
  }
  if (mode.work_mode === 'team_loop_task') {
    const hasWorker = roleSet.has('builder') || roleSet.has('researcher') || roleSet.has('synthesizer');
    const hasVerifier = roleSet.has('reviewer') || roleSet.has('tester') || roleSet.has('artifact_verifier');
    const hasLoopControl = roleSet.has('operator') || agentCount >= 4;
    const ok = agentCount >= 3 && hasWorker && hasVerifier && hasLoopControl;
    return { satisfied: ok, reason: ok ? 'team_loop_task_bounded_team' : 'team_loop_task_needs_worker_verifier_and_loop_control' };
  }
  return { satisfied: true, reason: 'unspecified' };
}
