import { summarizeTeamWorkflowContract } from './team_workflow_contract.js';
import { buildRoomProfileFromGoal, inferRoomDomain } from './room_package.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 400, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function splitRoleList(value = '') {
  return String(value || '')
    .split(/[ ,，、\/|]+/g)
    .map((row) => cleanText(row, { lower: true, maxLen: 80 }).replace(/^@+/, ''))
    .filter(Boolean)
    .map((role) => {
      if (role === 'designer' || role === 'architect' || role === '설계자') return 'planner';
      if (role === 'implementer' || role === 'coder' || role === '개발자' || role === '구현자') return 'builder';
      if (role === 'qa' || role === 'tester' || role === '검증자') return 'verifier';
      if (role === '검토자' || role === '리뷰어') return 'reviewer';
      return role;
    })
    .filter(Boolean)
    .filter((role, index, arr) => arr.indexOf(role) === index);
}

export function normalizeRoomAgentRoles(input = []) {
  const source = Array.isArray(input) ? input : splitRoleList(input);
  const out = [];
  for (const raw of source) {
    const role = cleanText(raw, { lower: true, maxLen: 80 }).replace(/^@+/, '');
    if (!role || out.includes(role)) continue;
    out.push(role);
  }
  return out;
}

export function inferAgentRoomArchetype(goal = '', { explicitRoles = [] } = {}) {
  const text = cleanText(goal, { lower: true, maxLen: 2000 });
  const roles = normalizeRoomAgentRoles(explicitRoles);
  const roomDomain = inferRoomDomain(goal);
  const domainProfile = buildRoomProfileFromGoal({ goal, source: 'agent_room_archetype_inference' });
  const loop = /(loop|watch|iterate|iteration|continuous|continue|계속|반복|무한|개선\s*loop|루프)/i.test(text);
  const review = /(review|verify|test|검토|리뷰|검증|테스트|품질|모순|consistency|continuity)/i.test(text);
  const build = roomDomain.domain_label === 'code_review' || /(implement|build|code|webapp|repo|repository|구현|개발|코드|웹앱|사이트|레포)/i.test(text);
  const risk = roomDomain.domain_label === 'portfolio_research' || /(risk|approval|approve|finance|stock|주식|금융|리스크|승인|위험|큰\s*변경)/i.test(text);
  const evidence = ['quick_search', 'portfolio_research', 'research_paper'].includes(roomDomain.domain_label) || /(news|price|source|evidence|latest|뉴스|가격|근거|최신|출처)/i.test(text);

  const recommended = [];
  if (domainProfile.default_agents?.length) recommended.push(...domainProfile.default_agents);
  if (loop || review || roles.includes('planner')) recommended.push('planner');
  if (build || roles.includes('builder')) recommended.push('builder');
  if (review || loop || roles.includes('reviewer')) recommended.push('reviewer');
  if ((review || build) && roomDomain.domain_label === 'code_review') recommended.push('verifier');
  if (risk || roles.includes('risk_reviewer')) recommended.push('risk_reviewer');
  if (evidence || roles.includes('researcher')) recommended.push('researcher');
  if (recommended.length === 0) recommended.push('planner', 'researcher', 'reviewer');

  return {
    archetype: roomDomain.setup_only ? 'room_setup_workspace' : (loop ? 'iterative_agent_workspace' : (review ? 'review_gated_workspace' : 'agent_room_workspace')),
    default_workflow: loop ? 'bounded_review_improve_loop' : (domainProfile.default_workflow || (review ? 'review_gated_pipeline' : 'task_adaptive')),
    default_depth: domainProfile.default_depth,
    domain_label: roomDomain.domain_label,
    domain_confidence: roomDomain.confidence,
    setup_only: roomDomain.setup_only,
    recommended_roles: normalizeRoomAgentRoles([...roles, ...recommended]),
    autonomy_policy: {
      ...domainProfile.autonomy_policy,
      small_safe_changes: domainProfile.autonomy_policy?.small_safe_changes || 'auto',
      risky_or_large_changes: risk ? 'approval_required' : (domainProfile.autonomy_policy?.risky_or_large_changes || 'review_required'),
      deployment: 'forbidden_without_explicit_approval',
      credential_or_external_api_binding: 'approval_required',
    },
    reasons: [
      `domain:${roomDomain.domain_label}`,
      roomDomain.setup_only ? 'setup_only_room_preparation' : '',
      loop ? 'loop_or_watch_intent' : '',
      review ? 'review_or_verification_intent' : '',
      build ? 'implementation_task' : '',
      risk ? 'risk_or_approval_boundary' : '',
      evidence ? 'evidence_or_freshness_pressure' : '',
    ].filter(Boolean),
  };
}

export function buildAgentRoomProfile({ chatId = '', roomName = '', goal = '', roles = [], workflowContract = null, team = null, source = 'telegram_agents_command' } = {}) {
  const inferred = inferAgentRoomArchetype(goal, { explicitRoles: roles });
  const domainProfile = buildRoomProfileFromGoal({ chatId, goal, roomName, source });
  const now = new Date().toISOString();
  const teamObj = asObject(team);
  const teamAgents = asArray(teamObj.agents || teamObj.items || teamObj.members)
    .map((row) => row?.role || row?.role_id || row?.id || row?.agent_id || row?.label)
    .filter(Boolean);
  const defaultAgents = normalizeRoomAgentRoles([...inferred.recommended_roles, ...teamAgents]);
  return {
    ...domainProfile,
    kind: 'agent_room_profile_v1',
    room_id: String(chatId || 'telegram_room'),
    name: cleanText(roomName || domainProfile.name || 'AI Work Room', { maxLen: 120 }),
    status: 'active',
    source,
    domain_label: inferred.domain_label || domainProfile.domain_label,
    domain_confidence: inferred.domain_confidence || domainProfile.domain_confidence,
    setup_only: inferred.setup_only || domainProfile.setup_only || false,
    default_agents: defaultAgents,
    default_workflow: inferred.default_workflow,
    default_depth: inferred.default_depth || domainProfile.default_depth,
    autonomy_policy: inferred.autonomy_policy,
    active_rules: [],
    installed_skills: [],
    memory_scope: 'room',
    current_goal: cleanText(goal, { maxLen: 800 }),
    workflow_contract_summary: workflowContract ? summarizeTeamWorkflowContract(workflowContract) : '',
    reasons: inferred.reasons,
    created_at: now,
    updated_at: now,
  };
}

export function upsertAgentRoomProfile(sessionStore, chatId, patch = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function') return null;
  let saved = null;
  sessionStore.upsert(chatId, (session = {}) => {
    const current = asObject(session.agent_room_profile);
    const now = new Date().toISOString();
    saved = {
      ...current,
      ...asObject(patch),
      kind: 'agent_room_profile_v1',
      room_id: String(chatId || current.room_id || 'telegram_room'),
      status: patch.status || current.status || 'active',
      created_at: current.created_at || patch.created_at || now,
      updated_at: now,
    };
    return { ...session, agent_room_profile: saved };
  });
  return saved;
}

export function getAgentRoomProfile(sessionStore, chatId) {
  if (!sessionStore || typeof sessionStore.get !== 'function') return null;
  const session = sessionStore.get(chatId) || {};
  return asObject(session.agent_room_profile);
}

export function formatAgentRoomProfile(profile = null, { includeHelp = true } = {}) {
  const row = asObject(profile);
  if (!row.kind) {
    return [
      'Agent Room이 아직 설정되지 않았어요.',
      '',
      '추천:',
      '- /agents suggest <목표>: 이 방에 맞는 agent 구성을 추천',
      '- /task loop <목표>: 반복 작업을 시작하면서 agent room을 자동 구성',
    ].join('\n');
  }
  const lines = [
    `Agent Room: ${row.name || 'Agent Workspace'}`,
    `- status: ${row.status || 'active'}`,
    `- domain: ${row.domain_label || 'general_workbench'}`,
    `- default depth: ${row.default_depth || 'adaptive'}`,
    `- default workflow: ${row.default_workflow || 'task_adaptive'}`,
    row.preset_id ? `- default preset: ${row.preset_id}` : '',
    `- agents: ${asArray(row.default_agents).join(', ') || '-'}`,
    `- skills: ${asArray(row.installed_skills || row.skills).join(', ') || '-'}`,
    `- memory scope: ${row.memory_scope || 'room'}`,
    `- memory hierarchy: ${asArray(row.memory_hierarchy || asObject(row.memory_schema).hierarchy).join(' → ') || '-'}`,
    `- memory schema: ${asArray(asObject(row.memory_schema).object_types).join(', ') || '-'}`,
    `- package: ${row.package_id || '(not exported)'}`,
  ].filter(Boolean);
  const loop = asObject(row.loop_policy);
  if (Object.keys(loop).length) {
    lines.push('- loop policy:');
    if (loop.default_iterations) lines.push(`  - default iterations: ${loop.default_iterations}`);
    if (loop.staged_iterations) lines.push(`  - staged iterations: ${loop.staged_iterations}`);
    if (typeof loop.verify_each_iteration !== 'undefined') lines.push(`  - verify each iteration: ${loop.verify_each_iteration !== false}`);
    if (asArray(loop.stop_when).length) lines.push(`  - stop when: ${asArray(loop.stop_when).join(', ')}`);
  }
  const policy = asObject(row.autonomy_policy);
  if (Object.keys(policy).length) {
    lines.push('- autonomy:');
    if (policy.small_safe_changes) lines.push(`  - small safe changes: ${policy.small_safe_changes}`);
    if (policy.risky_or_large_changes) lines.push(`  - risky/large changes: ${policy.risky_or_large_changes}`);
    if (policy.deployment) lines.push(`  - deployment: ${policy.deployment}`);
    if (policy.credential_or_external_api_binding) lines.push(`  - credentials/API: ${policy.credential_or_external_api_binding}`);
  }
  if (row.room_purpose) lines.push(`- purpose: ${row.room_purpose}`);
  if (row.current_goal) lines.push(`- current goal: ${row.current_goal}`);
  if (row.workflow_contract_summary) lines.push(`- workflow contract: ${row.workflow_contract_summary}`);
  if (asArray(row.reasons).length) lines.push(`- reasons: ${asArray(row.reasons).join(', ')}`);
  if (includeHelp) {
    lines.push('', 'Commands:', '- /room suggest <goal>', '- /room apply <goal>', '- /room export', '- /agents use planner,builder,reviewer', '- /task loop <goal>', '- /review');
  }
  return lines.join('\n');
}

export function buildAgentRoomSuggestionMessage({ goal = '', profile = null } = {}) {
  const row = profile || buildAgentRoomProfile({ goal, source: 'agent_room_suggestion' });
  return [
    '추천 AI Room 구성입니다.',
    '',
    formatAgentRoomProfile(row, { includeHelp: false }),
    '',
    '적용하려면:',
    `/room apply ${cleanText(goal || row.current_goal || '<목표>', { maxLen: 200 })}`,
    '',
    'ROOM.md로 내보내려면:',
    '/room export',
    '',
    '반복 작업까지 바로 시작하려면:',
    `/task loop ${cleanText(goal || row.current_goal || '<목표>', { maxLen: 200 })}`,
  ].join('\n');
}

export function isOperationalControlText(text = '') {
  const clean = cleanText(text, { lower: true, maxLen: 1200 });
  if (!clean) return false;
  const hasControl = /(agent\s*team|agents?|team|workflow|loop|watch|pause|resume|stop|approve|approval|reviewer|builder|planner|에이전트|팀|작업\s*방식|워크플로|루프|무한|계속\s*개선|승인|일시정지|재개|중단)/i.test(clean);
  const hasWorkContent = /(implement|build|fix|write|create|analyze|summarize|구현|개발|수정|작성|분석|요약|만들)/i.test(clean);
  const mostlyControl = /(agent\s*team|agents?|team|workflow|loop|watch|에이전트|팀|작업\s*방식|워크플로|루프|무한)/i.test(clean)
    && !/(website|webapp|app|site|문서|파일|코드베이스|웹앱|사이트|기능)/i.test(clean);
  return hasControl && (!hasWorkContent || mostlyControl);
}

export function buildOperationalControlRedirectMessage(text = '') {
  const goal = cleanText(text, { maxLen: 240 });
  return [
    '이 메시지는 일회성 /chat 작업보다 Agent Room 또는 Task 운영 설정에 가까워 보여요.',
    '',
    '추천 명령:',
    `- /agents suggest ${goal || '<목표>'}`,
    `- /task loop ${goal || '<목표>'}`,
    '',
    '/chat은 질문이나 이번 한 번의 작업에 사용하고, 반복 실행·agent 구성·승인/중단 조건은 /task 또는 /agents에서 설정합니다.',
  ].join('\n');
}
