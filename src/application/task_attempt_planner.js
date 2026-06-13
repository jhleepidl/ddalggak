import crypto from 'node:crypto';
import { inferMemoryImportIntent, summarizeMemoryImportIntent, inferTargetTeamFromText } from './team_memory_import_intent.js';
import { buildWorkModeConfig, summarizeWorkModeConfig, buildCyclePolicyForWorkMode } from './work_mode.js';

function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9가-힣_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function uniq(values = [], max = 10) {
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
function shortHash(text = '') { return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10); }

export function inferTaskAttemptIntent(taskText = '', { runtime = null, memoryImportIntent = null } = {}) {
  const text = clean(taskText).toLowerCase();
  const memoryImport = summarizeMemoryImportIntent(memoryImportIntent || inferMemoryImportIntent(taskText));
  const targetTeam = memoryImport.target_team !== 'general' ? memoryImport.target_team : inferTargetTeamFromText(text, 'general');
  const reasons = [];
  const dissatisfied = /마음에\s*안|별로|싫|다른\s*결과|not\s+happy|not\s+satisfied|bad\s+result|poor\s+result|별도\s*결과/.test(text);
  const retrySignal = /다시|재시도|retry|redo|rerun|새로\s*해|다시\s*맡/.test(text);
  const branchSignal = /다른\s*팀|논문작성팀|코딩팀|구현팀|발표팀|리뷰팀|맡겨|assign|delegate|branch|fork|다른\s*관점/.test(text);
  const parallelSignal = /둘\s*다|각자|병렬|동시에|parallel|both\s+teams/.test(text);
  if (dissatisfied) reasons.push('user_dissatisfied');
  if (targetTeam !== 'general') reasons.push('team_change');
  if (memoryImport.import_intent !== 'none') reasons.push('memory_import');
  if (/스타일|tone|format|형식|문체|짧게|길게/.test(text)) reasons.push('style_change');
  if (/context|memory|메모리|이전|같은\s*주제/.test(text)) reasons.push('context_change');
  const runMode = parallelSignal ? 'parallel_branch' : (branchSignal || (targetTeam !== 'general' && retrySignal) ? 'branch' : (retrySignal || dissatisfied ? 'retry' : 'new'));
  let previousResultPolicy = memoryImport.previous_result_policy || 'optional';
  if (dissatisfied || /무시|버리고|exclude|without\s+previous|from\s+scratch|처음부터/.test(text)) previousResultPolicy = 'exclude';
  else if (/참고만|요약만|summarize\s*only|summary\s*only/.test(text)) previousResultPolicy = 'summarize_only';
  else if (/이어서|continue|based\s+on\s+previous|이전\s*결과\s*기반/.test(text)) previousResultPolicy = 'include';
  return {
    run_mode: runMode,
    retry_reason: reasons[0] || (runMode === 'new' ? 'new_task' : 'user_requested_retry'),
    reason_codes: uniq(reasons.length ? reasons : [runMode === 'new' ? 'new_task' : 'user_requested_retry'], 8),
    target_team: targetTeam,
    previous_result_policy: previousResultPolicy,
    requires_goc: ['branch', 'parallel_branch'].includes(runMode) || memoryImport.import_intent === 'explicit',
  };
}

export function buildAttemptContextPolicy({ attemptIntent = {}, memoryImportIntent = {}, workModeConfig = {} } = {}) {
  const intent = asObject(attemptIntent);
  const memory = summarizeMemoryImportIntent(memoryImportIntent);
  const workMode = summarizeWorkModeConfig(workModeConfig);
  const previous = cleanId(intent.previous_result_policy || memory.previous_result_policy || 'optional') || 'optional';
  return {
    include_original_user_request: true,
    include_user_feedback: ['retry', 'branch', 'parallel_branch'].includes(cleanId(intent.run_mode || 'new')),
    include_previous_result: previous === 'include',
    previous_result_policy: previous,
    include_previous_result_summary: previous === 'summarize_only',
    include_full_chat_tail: false,
    include_memory_package: memory.import_intent !== 'none',
    memory_package_mode: memory.mode,
    memory_projection_profile: memory.projection_profile,
    memory_scope: memory.scope,
    work_mode: workMode.work_mode,
    context_depth: workMode.context_depth,
    loop_budget: workMode.loop_budget,
    stop_condition: workMode.stop_condition,
    review_policy: workMode.review_policy,
    memory_mode: workMode.memory_mode,
    goc_mode: workMode.goc_mode,
  };
}

export function buildTaskAttemptPlan({ request = '', runtime = null, userOrchestrationIntent = null, memoryImportIntent = null } = {}) {
  const runtimeRow = asObject(runtime);
  const memory = summarizeMemoryImportIntent(memoryImportIntent || inferMemoryImportIntent(request));
  const attemptIntent = inferTaskAttemptIntent(request, { runtime, memoryImportIntent: memory });
  const workMode = buildWorkModeConfig({ request, runtime, userOrchestrationIntent, memoryImportIntent: memory });
  const cyclePolicy = buildCyclePolicyForWorkMode(workMode);
  const threadId = clean(runtimeRow.threadId || runtimeRow.map?.threadId || runtimeRow.chatId || 'local');
  const parentAttemptId = clean(runtimeRow.currentAttemptId || runtimeRow.attemptId || runtimeRow.current_attempt_id || '');
  const taskId = clean(runtimeRow.currentTaskId || runtimeRow.taskId || runtimeRow.current_task_id || `task_${shortHash(`${threadId}:${clean(request).slice(0, 300)}`)}`);
  const attemptId = clean(runtimeRow.nextAttemptId || runtimeRow.next_attempt_id || `attempt_${shortHash(`${taskId}:${attemptIntent.run_mode}:${attemptIntent.target_team}:${clean(request).slice(0, 400)}`)}`);
  const contextPolicy = buildAttemptContextPolicy({ attemptIntent, memoryImportIntent: memory, workModeConfig: workMode });
  return {
    kind: 'task_attempt_plan_v1',
    task_id: taskId,
    attempt_id: attemptId,
    parent_attempt_id: parentAttemptId || null,
    run_mode: attemptIntent.run_mode,
    retry_reason: attemptIntent.retry_reason,
    reason_codes: attemptIntent.reason_codes,
    target_team: attemptIntent.target_team,
    previous_result_policy: attemptIntent.previous_result_policy,
    context_policy: contextPolicy,
    work_mode: workMode,
    cycle_policy: cyclePolicy,
    memory_import: memory,
    user_orchestration_intent: userOrchestrationIntent || null,
    goc: {
      recommended: attemptIntent.requires_goc || ['required', 'recommended'].includes(workMode.goc_mode),
      action: (attemptIntent.requires_goc || workMode.goc_mode === 'required') ? 'open_task_attempt_studio' : 'optional_review',
      reason: attemptIntent.requires_goc ? 'branch_or_memory_import_requires_structured_context_selection' : (workMode.goc_mode === 'required' ? 'work_mode_requires_goc_checkpoint' : (workMode.goc_mode === 'recommended' ? 'work_mode_recommends_goc_review' : 'simple_attempt_can_run_from_chat')),
    },
  };
}

export function summarizeTaskAttemptPlan(plan = {}) {
  const row = asObject(plan);
  const memory = summarizeMemoryImportIntent(row.memory_import || {});
  const workMode = summarizeWorkModeConfig(row.work_mode || row.workMode || {});
  const runMode = cleanId(row.run_mode || 'new') || 'new';
  return {
    kind: 'task_attempt_plan_v1',
    task_id: clean(row.task_id || ''),
    attempt_id: clean(row.attempt_id || ''),
    parent_attempt_id: clean(row.parent_attempt_id || '') || null,
    run_mode: ['new', 'retry', 'branch', 'parallel_branch'].includes(runMode) ? runMode : 'new',
    retry_reason: cleanId(row.retry_reason || (runMode === 'new' ? 'new_task' : 'user_requested_retry')) || 'new_task',
    reason_codes: uniq(row.reason_codes || [], 8),
    target_team: cleanId(row.target_team || memory.target_team || 'general') || 'general',
    previous_result_policy: cleanId(row.previous_result_policy || row.context_policy?.previous_result_policy || memory.previous_result_policy || 'optional') || 'optional',
    context_policy: buildAttemptContextPolicy({ attemptIntent: row, memoryImportIntent: memory, workModeConfig: workMode }),
    work_mode: workMode,
    cycle_policy: row.cycle_policy || buildCyclePolicyForWorkMode(workMode),
    memory_import: memory,
    goc: {
      recommended: row.goc?.recommended === true || ['branch', 'parallel_branch'].includes(runMode) || memory.import_intent === 'explicit' || ['required', 'recommended'].includes(workMode.goc_mode),
      action: cleanId(row.goc?.action || (['branch', 'parallel_branch'].includes(runMode) || memory.import_intent === 'explicit' || workMode.goc_mode === 'required' ? 'open_task_attempt_studio' : 'optional_review')),
      reason: clean(row.goc?.reason || ''),
    },
  };
}

export function candidateSatisfiesTaskAttempt(candidate = {}, plan = {}) {
  const attempt = summarizeTaskAttemptPlan(plan || candidate.task_attempt_plan || {});
  const target = cleanId(attempt.target_team || 'general');
  if (!target || target === 'general') return { satisfied: true, reason: 'no_target_team', target_team: 'general' };
  const candidateTarget = cleanId(candidate.target_team || candidate.memory_import_intent?.target_team || '');
  const tags = uniq([...(candidate.tags || []), ...(candidate.coverage_tags || []), candidate.source, candidate.motif_id], 32);
  const roleSet = new Set(uniq(candidate.roles || candidate.role_ids || [], 16));
  const inferred = candidateTarget || (roleSet.has('builder') ? 'coding' : (tags.includes('paper') || tags.includes('target_paper') ? 'paper' : ''));
  const satisfied = inferred === target || tags.includes(`target_${target}`) || tags.includes(`mem_profile_${target}`);
  return {
    satisfied,
    reason: satisfied ? 'target_team_satisfied' : 'target_team_mismatch',
    target_team: target,
    candidate_target_team: inferred || 'unknown',
  };
}
