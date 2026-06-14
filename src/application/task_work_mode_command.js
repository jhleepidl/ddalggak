import {
  buildCyclePolicyForWorkMode,
  summarizeWorkModeConfig,
} from './work_mode.js';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export const TASK_WORK_MODE_SHORTCUTS = Object.freeze({
  instant: 'quick_answer',
  single: 'quick_answer',
  quick: 'quick_answer',
  answer: 'quick_answer',
  assist: 'assisted_task', // legacy alias; hidden from normal help
  assisted: 'assisted_task', // legacy alias
  team: 'team_review',
  review: 'team_review', // legacy alias
  teamreview: 'team_review',
  team_review: 'team_review',
  loop: 'project_task',
  loop: 'project_task',
  agent_loop: 'project_task',
  work_loop: 'project_task',
  반복: 'project_task',
  루프: 'project_task',
  project: 'project_task', // legacy/internal preset alias
  projecttask: 'project_task',
  project_task: 'project_task',
  research: 'research_campaign', // legacy/internal preset alias
  campaign: 'research_campaign',
  research_campaign: 'research_campaign',
  custom: 'customize',
  customize: 'customize',
});

const WORK_MODE_ALIASES = Object.freeze({
  instant: 'quick_answer',
  immediate: 'quick_answer',
  single: 'quick_answer',
  single_agent: 'quick_answer',
  solo: 'quick_answer',
  즉시: 'quick_answer',
  즉시답변: 'quick_answer',
  단일: 'quick_answer',
  quick: 'quick_answer',
  quick_answer: 'quick_answer',
  quickanswer: 'quick_answer',
  answer: 'quick_answer',
  qa: 'quick_answer',
  간단: 'quick_answer',
  빠른_답변: 'quick_answer',
  assisted: 'assisted_task',
  assist: 'assisted_task',
  assisted_task: 'assisted_task',
  assistedtask: 'assisted_task',
  task: 'assisted_task',
  보조_작업: 'assisted_task',
  agent_team: 'team_review',
  review: 'team_review',
  team: 'team_review',
  team_review: 'team_review',
  teamreview: 'team_review',
  reviewer: 'team_review',
  팀_검토: 'team_review',
  loop: 'project_task',
  agent_loop: 'project_task',
  work_loop: 'project_task',
  반복: 'project_task',
  루프: 'project_task',
  project: 'project_task',
  project_task: 'project_task',
  projecttask: 'project_task',
  프로젝트_작업: 'project_task',
  research: 'research_campaign',
  campaign: 'research_campaign',
  research_campaign: 'research_campaign',
  researchcampaign: 'research_campaign',
  논문: 'research_campaign',
  연구_캠페인: 'research_campaign',
  custom: 'customize',
  customize: 'customize',
  커스텀: 'customize',
});

export function normalizeTaskWorkModeId(value = '') {
  const key = cleanId(value);
  return WORK_MODE_ALIASES[key] || '';
}

function parseLoopBudget(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return undefined;
  if (['staged', 'stage', 'stages', '단계', '단계별'].includes(raw)) return 'staged';
  if (['custom', '커스텀'].includes(raw)) return 'custom';
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(24, Math.floor(n)));
}

function defaultSubcommandForMode(mode = '') {
  if (mode === 'quick_answer' || mode === 'assisted_task') return 'instant';
  if (mode === 'team_review') return 'team';
  if (mode === 'project_task' || mode === 'research_campaign' || mode === 'customize') return 'loop';
  return 'loop';
}

function defaultStartSubcommandForMode(mode = '') {
  return mode === 'quick_answer' || mode === 'assisted_task' ? 'instant' : (mode === 'team_review' ? 'team' : 'loop');
}

function readFlag(tokens, index) {
  const token = tokens[index] || '';
  const eq = token.indexOf('=');
  if (eq >= 0) return { value: token.slice(eq + 1), consumed: 1 };
  return { value: tokens[index + 1] || '', consumed: 2 };
}

export function parseTaskWorkModeCommand(rawArgs = '', { defaultMode = '', defaultSubcommand = '' } = {}) {
  const input = clean(rawArgs);
  const tokens = input ? input.split(/\s+/) : [];
  let subcommand = cleanId(defaultSubcommand || tokens[0] || '');
  let index = subcommand ? 1 : 0;
  let mode = normalizeTaskWorkModeId(defaultMode || '');
  if (!mode && TASK_WORK_MODE_SHORTCUTS[subcommand]) mode = TASK_WORK_MODE_SHORTCUTS[subcommand];
  if (subcommand === 'mode') {
    const maybeMode = normalizeTaskWorkModeId(tokens[index] || '');
    if (maybeMode) {
      mode = maybeMode;
      index += 1;
    }
  }
  const overrides = {};
  const explicit = Boolean(mode);
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || !token.startsWith('--')) break;
    const key = cleanId(token.replace(/^--+/, '').split('=')[0]);
    const { value, consumed } = readFlag(tokens, index);
    if (['mode', 'work_mode', 'depth'].includes(key)) {
      const parsedMode = normalizeTaskWorkModeId(value);
      if (parsedMode) mode = parsedMode;
    } else if (['loops', 'loop', 'budget', 'loop_budget', 'iterations', 'iter'].includes(key)) {
      const parsed = parseLoopBudget(value);
      if (parsed !== undefined) overrides.loop_budget = parsed;
    } else if (['stop', 'stop_condition'].includes(key)) {
      const cleanValue = cleanId(value);
      if (cleanValue) overrides.stop_condition = cleanValue;
    } else if (['review', 'review_policy'].includes(key)) {
      const cleanValue = cleanId(value);
      if (cleanValue) overrides.review_policy = cleanValue;
    } else if (['memory', 'memory_mode'].includes(key)) {
      const cleanValue = cleanId(value);
      if (cleanValue) overrides.memory_mode = cleanValue;
    } else if (['goc', 'goc_mode'].includes(key)) {
      const cleanValue = cleanId(value);
      if (cleanValue) overrides.goc_mode = cleanValue;
    } else if (['context', 'context_depth'].includes(key)) {
      const cleanValue = cleanId(value);
      if (cleanValue) overrides.context_depth = cleanValue;
    } else {
      break;
    }
    index += consumed;
  }
  const goal = tokens.slice(index).join(' ').trim();
  const workMode = summarizeWorkModeConfig({
    work_mode: mode || 'assisted_task',
    explicit: explicit || subcommand === 'mode',
    reason_codes: [subcommand === 'mode' ? 'telegram_task_mode_command' : `telegram_task_${defaultSubcommandForMode(mode) || subcommand}`],
    ...overrides,
  });
  const cyclePolicy = buildCyclePolicyForWorkMode(workMode);
  return {
    subcommand: subcommand || defaultStartSubcommandForMode(workMode.work_mode),
    goal,
    mode: workMode.work_mode,
    work_mode: workMode,
    cycle_policy: cyclePolicy,
    overrides,
    explicit: explicit || Object.keys(overrides).length > 0,
  };
}

export function applyWorkModeToWorkflowContract(contract = {}, workModeConfig = {}, cyclePolicy = {}) {
  const row = { ...asObject(contract) };
  const mode = summarizeWorkModeConfig(workModeConfig);
  const cycle = asObject(cyclePolicy);
  const loopBudget = mode.loop_budget;
  let maxIterations = Number.isFinite(Number(loopBudget)) ? Math.max(1, Math.min(24, Number(loopBudget))) : undefined;
  if (mode.work_depth === 'instant' || mode.work_mode === 'quick_answer') maxIterations = 1;
  if (mode.work_mode === 'assisted_task') maxIterations = maxIterations || 1;
  if (mode.work_depth === 'team' || mode.work_mode === 'team_review') maxIterations = maxIterations || 2;
  if (mode.work_depth === 'loop' || mode.work_mode === 'project_task') maxIterations = maxIterations || 5;
  if (mode.work_mode === 'research_campaign') maxIterations = maxIterations || 8;
  const workflowKind = mode.work_depth === 'instant' || mode.work_mode === 'quick_answer' || mode.work_mode === 'assisted_task'
    ? (row.workflow_kind || 'single_task')
    : (mode.work_mode === 'research_campaign' ? 'staged_research_campaign' : (row.workflow_kind === 'single_task' ? 'review_gated_pipeline' : row.workflow_kind || 'review_gated_pipeline'));
  const stopConditions = Array.isArray(row.stop_conditions) ? [...row.stop_conditions] : [];
  if (mode.stop_condition && !stopConditions.includes(mode.stop_condition)) stopConditions.push(mode.stop_condition);
  if (!stopConditions.includes('user_stop')) stopConditions.push('user_stop');
  return {
    ...row,
    workflow_kind: workflowKind,
    work_mode: mode,
    cycle_policy: cycle,
    min_iterations: mode.work_mode === 'quick_answer' ? 1 : Math.min(Number(row.min_iterations || 1) || 1, maxIterations || 1),
    max_iterations: maxIterations || row.max_iterations || 1,
    review_each_iteration: mode.review_policy === 'required' || mode.review_policy === 'stage_gate' || row.review_each_iteration === true,
    approval_boundary: mode.review_policy === 'required' || mode.review_policy === 'stage_gate' || row.approval_boundary === true,
    stop_conditions: stopConditions,
    source_reasons: [...new Set([...(Array.isArray(row.source_reasons) ? row.source_reasons : []), `work_mode_${mode.work_mode}`])],
  };
}

export function formatWorkModeCommandSummary(workModeConfig = {}, cyclePolicy = {}) {
  const mode = summarizeWorkModeConfig(workModeConfig);
  const cycle = asObject(cyclePolicy);
  return [
    `depth=${mode.work_depth || 'instant'}`,
    `mode=${mode.work_mode}`,
    `loop=${mode.loop_budget}`,
    `stop=${mode.stop_condition}`,
    `review=${mode.review_policy}`,
    `memory=${mode.memory_mode}`,
    `GoC=${mode.goc_mode}`,
    cycle.cycle_shape ? `cycle=${cycle.cycle_shape}` : '',
  ].filter(Boolean).join(' · ');
}
