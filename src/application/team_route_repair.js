import { clip } from '../textutil.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function unique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function isGenericRawGoal(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return true;
  return /^(사용자 요청을 계획하고 필요한 agent 작업을 제안\/수행|요청된 코드\/노트북 산출물을 구현|기존 agent를 재사용해 요청 처리)\s*[:：]/i.test(text);
}

export function isImplementationLikeRequest(message = '', { taskInterpretation = null, taskArchetype = '' } = {}) {
  const text = String(message || '').trim().toLowerCase();
  const taskType = cleanId(taskInterpretation?.task_type || taskInterpretation?.taskType || '');
  const deliverableType = cleanId(taskInterpretation?.deliverable_type || taskInterpretation?.deliverableType || '');
  const archetype = cleanId(taskArchetype || '');
  if (taskType === 'code_change' || deliverableType === 'software_delivery') return true;
  if (['implementation', 'iterative_improvement', 'review_repair'].includes(archetype)) return true;
  if (!text) return false;
  return /(구현|개발|만들어|만들어줘|코드|노트북|ipynb|jupyter|주피터|python|script|스크립트|웹\s*서비스|웹앱|web\s*service|web\s*app|frontend|backend|api|server|client|react|next(?:\.js)?|node|express|fastapi|flask|django|서비스\s*이름|서비스\s*구현|프로그램\s*개발|앱\s*개발)/i.test(text);
}

function collectTeamAgents(runtime = {}) {
  const out = [];
  const seen = new Set();
  const pushRow = (row = {}) => {
    const agentId = cleanId(row.agent_id || row.agentId || row.id || row.instance_id || row.instanceId || row.template_id || row.templateId);
    const roleId = cleanId(row.role || row.role_id || row.roleId);
    if (!agentId && !roleId) return;
    const key = `${agentId}|${roleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      agent_id: agentId || roleId,
      role_id: roleId || agentId,
      name: String(row.name || row.display_label || row.displayLabel || row.label || row.agent_id || row.id || '').trim() || undefined,
      provider: cleanId(row.provider),
      model: String(row.model || '').trim() || undefined,
      attached_skill_ids: asArray(row.attached_skill_ids || row.attachedSkillIds || row.skills),
    });
  };
  for (const row of asArray(runtime?.activeTeamConfig?.agents)) pushRow(row);
  for (const row of asArray(runtime?.agents)) pushRow(row);
  for (const row of asArray(runtime?.runtimeTeamSnapshot?.runtime_agents)) pushRow(row);
  return out;
}

function findRoleAgent(teamAgents = [], roleId = '') {
  const target = cleanId(roleId);
  if (!target) return null;
  const byRole = teamAgents.find((row) => cleanId(row.role_id) === target);
  if (byRole) return byRole;
  if (target === 'builder') return teamAgents.find((row) => cleanId(row.provider) === 'codex') || null;
  if (target === 'researcher') return teamAgents.find((row) => cleanId(row.provider) === 'gemini') || null;
  if (target === 'reviewer') return teamAgents.find((row) => cleanId(row.provider) === 'chatgpt') || null;
  return null;
}

function resolveFinalOwnerAgent(runtime = {}, runtimeTeamSnapshot = null, teamAgents = []) {
  const activeTeam = runtime?.activeTeamConfig && typeof runtime.activeTeamConfig === 'object' ? runtime.activeTeamConfig : {};
  const structure = activeTeam?.structure_v2 && typeof activeTeam.structure_v2 === 'object' ? activeTeam.structure_v2 : {};
  const finalOwnerId = cleanId(
    structure?.control_policy?.final_answer_owner_participant_id
    || structure?.control_policy?.finalAnswerOwnerParticipantId
    || structure?.topology?.final_participant_id
    || structure?.topology?.finalParticipantId
    || runtimeTeamSnapshot?.structure_v2?.control_policy?.final_answer_owner_participant_id
    || runtimeTeamSnapshot?.structure_v2?.topology?.final_participant_id
    || ''
  );
  const finalOwnerName = String(activeTeam?.interaction_spec?.final_answer_owner || runtimeTeamSnapshot?.team_plan?.interaction_spec?.final_answer_owner || '').trim();
  if (finalOwnerId) {
    const byId = teamAgents.find((row) => cleanId(row.agent_id) === finalOwnerId);
    if (byId) return byId;
  }
  if (finalOwnerName) {
    const byName = teamAgents.find((row) => String(row.name || '').trim() === finalOwnerName);
    if (byName) return byName;
  }
  return null;
}

function inferPreferredPattern(runtime = {}, routePlan = {}, runtimeTeamSnapshot = null) {
  return cleanId(
    runtime?.teamInteractionSpec?.execution_pattern
    || runtime?.activeTeamConfig?.interaction_spec?.execution_pattern
    || routePlan?.interaction_spec?.execution_pattern
    || runtimeTeamSnapshot?.team_plan?.execution_graph?.pattern
    || runtime?.teamTopologyPattern
    || runtime?.activeTeamConfig?.structure_v2?.topology?.pattern
    || ''
  );
}

function extractActionAgentIds(actions = []) {
  const out = [];
  for (const action of asArray(actions)) {
    const type = cleanId(action?.type);
    if (type === 'run_agent' || type === 'agent_run' || type === 'synthesize_final') {
      const agentId = cleanId(action?.agent_id || action?.agent);
      if (agentId) out.push(agentId);
      continue;
    }
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      for (const child of asArray(action?.agents)) {
        const agentId = cleanId(child?.agent_id || child?.agent);
        if (agentId) out.push(agentId);
      }
    }
  }
  return unique(out);
}

function roleIdForAction(action = {}, teamAgents = []) {
  const inputRole = cleanId(action?.inputs?.role_id || action?.inputs?.roleId);
  if (inputRole) return inputRole;
  const agentId = cleanId(action?.agent_id || action?.agent);
  const matched = teamAgents.find((row) => cleanId(row.agent_id) === agentId);
  return cleanId(matched?.role_id || '');
}

function buildRoleGoal(roleId = '', message = '') {
  const request = clip(String(message || '').trim(), 180);
  const requestLine = request ? ` 요청 요약: ${request}` : '';
  switch (cleanId(roleId)) {
    case 'researcher':
      return `구현을 바로 진행할 수 있도록 핵심 요구사항, 제품 흐름, 외부 제약/리스크를 짧게 정리하고 builder에게 handoff를 남겨라.${requestLine}`;
    case 'builder':
      return `upstream handoff와 mission_brief/working_memory를 source of truth로 삼아 실제 구현 산출물을 만들어라. raw user request를 되풀이하지 말고, 연구 결과를 실행 가능한 작업 단계와 파일 변경으로 변환하라. 설계 설명만으로 끝내지 말고 가능한 파일 생성/수정, 구현 초안, 실행 방법, implementation_notes를 남겨라.${requestLine}`;
    case 'reviewer':
      return `현재 구현 산출물과 upstream handoff를 함께 검토하고 blocker, 빠진 테스트, 리스크, 수정 제안을 우선순위와 함께 review_findings에 남겨라.${requestLine}`;
    case 'synthesizer':
      return `upstream 결과와 검토 결과를 합쳐 사용자에게 전달 가능한 최종 구현 요약, 생성된 산출물, 실행 방법, 남은 리스크를 정리하라.${requestLine}`;
    default:
      return request;
  }
}

function buildRunAction(agent = {}, message = '', { finalSynthesis = false } = {}) {
  const roleId = cleanId(agent.role_id || agent.role);
  const goal = buildRoleGoal(roleId, message);
  return {
    type: 'run_agent',
    agent_id: cleanId(agent.agent_id || agent.id || roleId),
    goal,
    risk: roleId === 'builder' ? 'L2' : 'L1',
    inputs: {
      display_label: String(agent.name || '').trim() || undefined,
      agent_name: String(agent.name || '').trim() || undefined,
      role_id: roleId || undefined,
      provider: cleanId(agent.provider) || undefined,
      model: String(agent.model || '').trim() || undefined,
      attached_skill_ids: asArray(agent.attached_skill_ids || agent.attachedSkillIds).filter(Boolean),
      final_synthesis: finalSynthesis === true || roleId === 'synthesizer' ? true : undefined,
    },
    scope: { mode: 'shared_only' },
  };
}

function repairExistingGoals(actions = [], teamAgents = [], message = '') {
  return asArray(actions).map((action) => {
    const type = cleanId(action?.type);
    if (type !== 'run_agent' && type !== 'agent_run' && type !== 'synthesize_final') return action;
    const roleId = roleIdForAction(action, teamAgents);
    const goal = String(action?.goal || action?.prompt || action?.task || '').trim();
    const agentId = cleanId(action?.agent_id || action?.agent);
    const matched = teamAgents.find((row) => cleanId(row.agent_id) === agentId) || {};
    const rewritten = (!goal || goal === String(message || '').trim() || isGenericRawGoal(goal))
      ? buildRoleGoal(roleId || matched.role_id, message)
      : goal;
    const finalOwnerOverride = type === 'synthesize_final' && finalOwnerAgent ? finalOwnerAgent : null;
    const effectiveAgentId = cleanId(finalOwnerOverride?.agent_id || agentId || matched.agent_id || roleId);
    return {
      ...action,
      agent_id: effectiveAgentId,
      agent: type === 'synthesize_final' ? effectiveAgentId : (action?.agent || effectiveAgentId),
      goal: rewritten,
      inputs: {
        ...(action?.inputs && typeof action.inputs === 'object' ? action.inputs : {}),
        display_label: String(action?.inputs?.display_label || finalOwnerOverride?.name || matched.name || '').trim() || undefined,
        agent_name: String(action?.inputs?.agent_name || finalOwnerOverride?.name || matched.name || '').trim() || undefined,
        role_id: cleanId(finalOwnerOverride?.role_id || roleId || matched.role_id) || undefined,
        provider: String(action?.inputs?.provider || finalOwnerOverride?.provider || matched.provider || '').trim() || undefined,
        model: String(action?.inputs?.model || finalOwnerOverride?.model || matched.model || '').trim() || undefined,
      },
      scope: action?.scope && typeof action.scope === 'object' ? action.scope : { mode: 'shared_only' },
    };
  });
}

export function repairRoutePlanForTeamExecution(routePlan = {}, {
  message = '',
  runtime = {},
  runtimeTeamSnapshot = null,
} = {}) {
  const row = routePlan && typeof routePlan === 'object' ? routePlan : {};
  const teamLocked = row.team_locked === true || runtime?.teamLocked === true;
  if (!teamLocked) return row;
  const teamAgents = collectTeamAgents(runtime);
  if (teamAgents.length === 0) return row;
  const taskInterpretation = runtimeTeamSnapshot?.task_interpretation || row?.runtime_team_snapshot?.task_interpretation || null;
  const taskArchetype = runtime?.activeTeamConfig?.task_archetype || runtimeTeamSnapshot?.blueprint_summary?.task_archetype || '';
  const implementationLike = isImplementationLikeRequest(message, { taskInterpretation, taskArchetype });
  const builder = findRoleAgent(teamAgents, 'builder');
  const finalOwnerAgent = resolveFinalOwnerAgent(runtime, runtimeTeamSnapshot, teamAgents);
  if (!implementationLike || !builder) {
    return {
      ...row,
      actions: repairExistingGoals(row.actions, teamAgents, message, { finalOwnerAgent }),
    };
  }

  const reviewer = findRoleAgent(teamAgents, 'reviewer');
  const researcher = findRoleAgent(teamAgents, 'researcher');
  const synthesizer = findRoleAgent(teamAgents, 'synthesizer');
  const preferredPattern = inferPreferredPattern(runtime, row, runtimeTeamSnapshot);
  const currentAgentIds = extractActionAgentIds(row.actions);
  const currentRoleIds = new Set(
    asArray(row.actions)
      .map((action) => roleIdForAction(action, teamAgents))
      .filter(Boolean)
  );
  const currentBuilderPresent = currentAgentIds.includes(cleanId(builder.agent_id)) || currentRoleIds.has('builder');
  const onlyResearcher = currentRoleIds.size === 1 && currentRoleIds.has('researcher');
  const tooShortForPipeline = currentAgentIds.length <= 1;
  const wantsPipeline = ['builder_reviewer_loop', 'sequential_pipeline', 'workflow', 'continuous_improvement'].includes(preferredPattern) || Boolean(reviewer) || Boolean(synthesizer);

  const shouldRebuildPipeline = !currentBuilderPresent || onlyResearcher || (wantsPipeline && tooShortForPipeline);
  if (!shouldRebuildPipeline) {
    return {
      ...row,
      actions: repairExistingGoals(row.actions, teamAgents, message, { finalOwnerAgent }),
      done: row.done === true && !currentBuilderPresent ? false : row.done,
    };
  }

  const orderedAgents = [];
  if (researcher) orderedAgents.push(researcher);
  orderedAgents.push(builder);
  if (reviewer) orderedAgents.push(reviewer);
  const finalSynthesisAgent = finalOwnerAgent || synthesizer;
  if (finalSynthesisAgent) {
    if (!orderedAgents.find((row) => cleanId(row.agent_id) === cleanId(finalSynthesisAgent.agent_id))) orderedAgents.push(finalSynthesisAgent);
  } else if (synthesizer) {
    orderedAgents.push(synthesizer);
  }
  const rebuiltActions = orderedAgents.slice(0, 4).map((agent, index, rows) => {
    const isLast = index === rows.length - 1;
    const isFinalOwner = finalSynthesisAgent && cleanId(agent.agent_id) === cleanId(finalSynthesisAgent.agent_id);
    const built = buildRunAction(agent, message, { finalSynthesis: isLast || isFinalOwner || cleanId(agent.role_id) === 'synthesizer' });
    if (isLast || isFinalOwner) {
      built.type = 'synthesize_final';
      built.agent = built.agent_id;
    }
    return built;
  });
  const nextDeliverables = unique([
    ...asArray(row.deliverables),
    '구현 산출물',
    reviewer ? '검토 결과' : '',
    synthesizer ? '최종 전달 요약' : '',
  ]);
  return {
    ...row,
    reason: `${String(row.reason || 'supervisor route').trim() || 'supervisor route'}; repaired_locked_team_pipeline`,
    actions: rebuiltActions,
    done: false,
    await_user: false,
    deliverables: nextDeliverables,
    completed_deliverables: asArray(row.completed_deliverables || row.completedDeliverables),
    final_response_style: row.final_response_style || 'concise',
  };
}
