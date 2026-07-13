function clean(value = '', max = 320) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trim()}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function dedupe(values = [], limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = clean(value, 500);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function latestTurn(session = {}, role = '') {
  const rows = asArray(session.recent_room_turns || session.recentRoomTurns);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] || {};
    if (role && String(row.role || '').toLowerCase() !== role) continue;
    const text = clean(row.text || row.content || '', 500);
    if (text) return { ...row, text };
  }
  return null;
}

function summarizeBranch(row = {}) {
  const title = clean(row.title || row.direction || row.goal || '', 160);
  const status = clean(row.status || 'proposed', 40);
  return title ? `${title} · ${status}` : '';
}

export function buildRoomContinuitySnapshot({
  roomProfile = null,
  companionState = null,
  session = null,
  currentJobId = '',
  watchSummary = null,
} = {}) {
  const profile = roomProfile && typeof roomProfile === 'object' ? roomProfile : {};
  const companion = companionState && typeof companionState === 'object' ? companionState : {};
  const state = session && typeof session === 'object' ? session : {};
  const contextControls = companion.context_controls && typeof companion.context_controls === 'object'
    ? companion.context_controls
    : {};
  const activeCompanion = companion.active_companion && typeof companion.active_companion === 'object'
    ? companion.active_companion
    : {};

  const goal = clean(
    profile.current_goal
      || profile.goal
      || profile.task_brief
      || state.pending_task_control?.goal
      || latestTurn(state, 'user')?.text
      || '',
    500,
  );

  const activeJob = clean(currentJobId || state.jobId || state.last_job_id || '', 160);
  const watchStatus = clean(watchSummary?.status || '', 80);
  const stage = watchStatus
    ? `loop:${watchStatus}`
    : activeJob
      ? 'active work'
      : goal
        ? 'ready to continue'
        : 'not configured';

  const runtimeRules = asArray(state.runtime_rules)
    .filter((row) => row?.enabled !== false)
    .map((row) => clean(row?.text || row, 500))
    .filter(Boolean);
  const corrections = asArray(companion.recent_corrections)
    .map((row) => clean(row?.correction_text || row?.text || row?.summary || '', 500))
    .filter(Boolean);
  const acceptedProposals = asArray(companion.merge_proposals)
    .filter((row) => String(row?.status || '').toLowerCase() === 'accepted')
    .map((row) => clean(row?.payload?.correction_text || row?.summary || '', 500))
    .filter(Boolean);

  const includedSources = asArray(activeCompanion.memory_connections)
    .map((row) => clean(row?.source || row?.id || row, 120))
    .filter(Boolean);
  const excludedSources = dedupe([
    ...asArray(activeCompanion.excluded_by_default),
    ...asArray(contextControls.excluded_sources),
  ], 20);

  const pendingTask = state.pending_task_control && typeof state.pending_task_control === 'object'
    ? state.pending_task_control
    : null;
  const nextAction = clean(
    pendingTask?.goal
      || (watchSummary && watchStatus && !['done', 'completed', 'stopped'].includes(watchStatus.toLowerCase())
        ? `Continue ${watchSummary.workflow_kind || 'active loop'} iteration ${watchSummary.current_iteration || 0}/${watchSummary.max_iterations || '?'}`
        : '')
      || (activeJob ? `Continue job ${activeJob}` : '')
      || (goal ? 'Send the next instruction for this Room.' : 'Set a Room goal with /room apply <goal>.'),
    500,
  );

  const branches = asArray(state.room_branches).slice(-5).map(summarizeBranch).filter(Boolean);
  const recentUser = latestTurn(state, 'user');
  const recentAssistant = latestTurn(state, 'assistant');

  return {
    kind: 'room_continuity_snapshot_v1',
    goal,
    stage,
    active_job_id: activeJob || null,
    next_action: nextAction,
    source_policy: {
      mode: clean(contextControls.mode || 'default', 80),
      included_sources: dedupe(includedSources, 20),
      excluded_sources: excludedSources,
    },
    rules: dedupe(runtimeRules, 12),
    corrections: dedupe([...acceptedProposals, ...corrections], 12),
    branches,
    recent: {
      user: recentUser?.text || '',
      assistant: recentAssistant?.text || '',
    },
    pending: {
      reviews: asArray(companion.merge_proposals).filter((row) => String(row?.status || 'pending').toLowerCase() === 'pending').length,
      memory_exchanges: asArray(companion.memory_exchange_proposals).filter((row) => String(row?.status || 'pending').toLowerCase() === 'pending').length,
    },
  };
}

export function formatRoomContinuityBrief(snapshot = {}) {
  const row = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const lines = [
    '🧭 Room Brief',
    `- 목표: ${row.goal || '아직 설정되지 않음'}`,
    `- 현재 단계: ${row.stage || 'unknown'}`,
    row.active_job_id ? `- active job: ${row.active_job_id}` : '',
    `- 다음 행동: ${row.next_action || '다음 지시를 기다리는 중'}`,
    `- 적용 규칙: ${asArray(row.rules).length}개`,
    `- 반영된 정정: ${asArray(row.corrections).length}개`,
    `- 제외된 source: ${asArray(row.source_policy?.excluded_sources).length}개`,
    `- 검토 대기: ${(row.pending?.reviews || 0) + (row.pending?.memory_exchanges || 0)}개`,
  ].filter(Boolean);
  if (asArray(row.branches).length) lines.push('', '최근 branch:', ...row.branches.map((entry) => `- ${entry}`));
  lines.push('', '이어가기: /continue', '근거 범위: /sources', '현재 규칙: /rules', '방향 분기: /branch <새 방향>');
  return lines.join('\n');
}

export function formatRoomSourceBoundary(snapshot = {}) {
  const policy = snapshot?.source_policy || {};
  const included = asArray(policy.included_sources);
  const excluded = asArray(policy.excluded_sources);
  return [
    '📚 Room Sources & Boundaries',
    `- context mode: ${policy.mode || 'default'}`,
    '',
    '기본 연결 source:',
    ...(included.length ? included.map((item) => `- ${item}`) : ['- 명시된 source 없음']),
    '',
    '제외 source:',
    ...(excluded.length ? excluded.map((item) => `- ${item}`) : ['- 없음']),
    '',
    '변경: /context project-only | clean-slate | exclude <source> | reset',
  ].join('\n');
}

export function formatRoomRulesAndCorrections(snapshot = {}) {
  const rules = asArray(snapshot?.rules);
  const corrections = asArray(snapshot?.corrections);
  return [
    '📌 Room Rules & Corrections',
    '',
    '현재 규칙:',
    ...(rules.length ? rules.map((item, index) => `${index + 1}. ${item}`) : ['- 없음']),
    '',
    '반영된 정정:',
    ...(corrections.length ? corrections.map((item, index) => `${index + 1}. ${item}`) : ['- 없음']),
    '',
    '추가: /rule <지침>',
    '정정: /correct <반복하지 않아야 할 내용>',
  ].join('\n');
}

export function createRoomBranch({ sessionStore, chatId = '', direction = '', parentJobId = '' } = {}) {
  const text = clean(direction, 800);
  if (!text || !sessionStore || typeof sessionStore.upsert !== 'function') return null;
  const now = new Date().toISOString();
  const branch = {
    branch_id: `room_branch_${Date.now().toString(36)}`,
    direction: text,
    title: clean(text, 140),
    parent_job_id: clean(parentJobId, 160) || null,
    status: 'proposed',
    created_at: now,
  };
  sessionStore.upsert(chatId, (session = {}) => ({
    ...session,
    room_branches: [...asArray(session.room_branches), branch].slice(-12),
    updated_at: now,
  }));
  return branch;
}

export function formatRoomBranchProposal(branch = {}) {
  if (!branch?.branch_id) return 'branch 방향을 만들지 못했습니다.';
  return [
    '🌿 Room branch proposal',
    `- id: ${branch.branch_id}`,
    `- 방향: ${branch.direction}`,
    branch.parent_job_id ? `- parent job: ${branch.parent_job_id}` : '- parent job: 현재 Room 상태',
    '- 상태: proposed',
    '',
    '기존 방향은 유지됩니다. 새 방향으로 실제 작업을 시작하려면 아래처럼 요청하세요.',
    `/c branch ${branch.branch_id}: ${branch.direction}`,
  ].join('\n');
}
