import { clip } from '../textutil.js';
import { hasImplementationLikeIntent } from '../shared/work_intent.js';

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


const ROOM_JOURNEY_CONTEXT_OPEN = '[ROOM_JOURNEY_AUTHORITATIVE_CONTEXT';
const ROOM_JOURNEY_CONTEXT_CLOSE = '[/ROOM_JOURNEY_AUTHORITATIVE_CONTEXT]';

function splitBenchmarkAuthoritativeContext(message = '') {
  const text = String(message || '').trim();
  const start = text.indexOf(ROOM_JOURNEY_CONTEXT_OPEN);
  if (start < 0) return { evidence: '', request: text };
  const closeStart = text.indexOf(ROOM_JOURNEY_CONTEXT_CLOSE, start);
  if (closeStart < 0) return { evidence: '', request: text };
  const end = closeStart + ROOM_JOURNEY_CONTEXT_CLOSE.length;
  const evidence = text.slice(start, end).trim();
  const request = `${text.slice(0, start)}
${text.slice(end)}`.trim();
  return { evidence, request };
}

function appendBenchmarkAuthoritativeContext(goal = '', message = '') {
  const base = String(goal || '').trim();
  const { evidence } = splitBenchmarkAuthoritativeContext(message);
  if (!evidence || base.includes(ROOM_JOURNEY_CONTEXT_OPEN)) return base;
  return `${base}

${evidence}`.trim();
}

function isGenericRawGoal(goal = '') {
  const text = String(goal || '').trim();
  if (!text) return true;
  return /^(사용자 요청을 계획하고 필요한 agent 작업을 제안\/수행|요청된 코드\/노트북 산출물을 구현|기존 agent를 재사용해 요청 처리)\s*[:：]/i.test(text);
}

export function isImplementationLikeRequest(message = '', { taskInterpretation = null, taskArchetype = '' } = {}) {
  const text = String(message || '').trim();
  const taskType = cleanId(taskInterpretation?.task_type || taskInterpretation?.taskType || '');
  const deliverableType = cleanId(taskInterpretation?.deliverable_type || taskInterpretation?.deliverableType || '');
  const archetype = cleanId(taskArchetype || '');
  if (taskType === 'code_change' || deliverableType === 'software_delivery') return true;
  if (['implementation', 'iterative_improvement', 'review_repair'].includes(archetype)) return true;
  if (!text) return false;
  return hasImplementationLikeIntent(text);
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
      model_role: cleanId(row.model_role || row.modelRole),
      collaboration_lane: row.collaboration_lane && typeof row.collaboration_lane === 'object'
        ? row.collaboration_lane
        : (row.collaborationLane && typeof row.collaborationLane === 'object' ? row.collaborationLane : {}),
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
  const { evidence, request: requestWithoutEvidence } = splitBenchmarkAuthoritativeContext(message);
  const request = clip(requestWithoutEvidence, 180);
  const requestLine = request ? ` 요청 요약: ${request}` : '';
  let goal = '';
  switch (cleanId(roleId)) {
    case 'researcher':
      goal = `구현을 바로 진행할 수 있도록 핵심 요구사항, 제품 흐름, 외부 제약/리스크를 짧게 정리하고 builder에게 handoff를 남겨라.${requestLine}`;
      break;
    case 'builder':
      goal = `upstream handoff와 mission_brief/working_memory를 source of truth로 삼아 실제 구현 산출물을 만들어라. raw user request를 되풀이하지 말고, 연구 결과를 실행 가능한 작업 단계와 파일 변경으로 변환하라. 설계 설명만으로 끝내지 말고 가능한 파일 생성/수정, 구현 초안, 실행 방법, implementation_notes를 남겨라.${requestLine}`;
      break;
    case 'reviewer':
      goal = `현재 구현 산출물과 upstream handoff를 함께 검토하고 blocker, 빠진 테스트, 리스크, 수정 제안을 우선순위와 함께 review_findings에 남겨라.${requestLine}`;
      break;
    case 'synthesizer':
      goal = `upstream 결과와 검토 결과를 합쳐 사용자에게 전달 가능한 최종 구현 요약, 생성된 산출물, 실행 방법, 남은 리스크를 정리하라.${requestLine}`;
      break;
    default:
      goal = request;
      break;
  }
  return evidence ? `${goal}

${evidence}`.trim() : goal;
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
      model_role: cleanId(agent.model_role || agent.modelRole) || undefined,
      collaboration_lane: agent.collaboration_lane && typeof agent.collaboration_lane === 'object'
        ? agent.collaboration_lane
        : undefined,
      lane_id: cleanId(agent?.collaboration_lane?.lane_id || agent?.collaborationLane?.laneId || '') || undefined,
      attached_skill_ids: asArray(agent.attached_skill_ids || agent.attachedSkillIds).filter(Boolean),
      final_synthesis: finalSynthesis === true || roleId === 'synthesizer' ? true : undefined,
    },
    scope: { mode: 'shared_only' },
  };
}

function repairExistingGoals(actions = [], teamAgents = [], message = '', { finalOwnerAgent = null } = {}) {
  return asArray(actions).map((action) => {
    const type = cleanId(action?.type);
    if (type !== 'run_agent' && type !== 'agent_run' && type !== 'synthesize_final') return action;
    const roleId = roleIdForAction(action, teamAgents);
    const goal = String(action?.goal || action?.prompt || action?.task || '').trim();
    const agentId = cleanId(action?.agent_id || action?.agent);
    const matched = teamAgents.find((row) => cleanId(row.agent_id) === agentId) || {};
    const rewrittenBase = (!goal || goal === String(message || '').trim() || isGenericRawGoal(goal))
      ? buildRoleGoal(roleId || matched.role_id, message)
      : goal;
    const rewritten = appendBenchmarkAuthoritativeContext(rewrittenBase, message);
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
        model_role: cleanId(action?.inputs?.model_role || action?.inputs?.modelRole || finalOwnerOverride?.model_role || matched.model_role) || undefined,
        collaboration_lane: action?.inputs?.collaboration_lane && typeof action.inputs.collaboration_lane === 'object'
          ? action.inputs.collaboration_lane
          : (finalOwnerOverride?.collaboration_lane || matched.collaboration_lane || undefined),
        lane_id: cleanId(
          action?.inputs?.lane_id
          || action?.inputs?.laneId
          || finalOwnerOverride?.collaboration_lane?.lane_id
          || matched?.collaboration_lane?.lane_id
          || ''
        ) || undefined,
      },
      scope: action?.scope && typeof action.scope === 'object' ? action.scope : { mode: 'shared_only' },
    };
  });
}

function normalizedActionFingerprint(action = {}) {
  const inputs = action?.inputs && typeof action.inputs === 'object' ? action.inputs : {};
  const scope = action?.scope && typeof action.scope === 'object' ? action.scope : {};
  const laneId = cleanId(inputs.lane_id || inputs.laneId || inputs?.collaboration_lane?.lane_id || inputs?.collaborationLane?.laneId || '');
  return [
    cleanId(action.type),
    cleanId(action.agent_id || action.agent),
    cleanId(inputs.model_role || inputs.modelRole),
    String(action.goal || action.prompt || action.task || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    cleanId(scope.mode || scope.scope || ''),
    laneId,
  ].join('|');
}

function dedupeSpawnChildren(action = {}) {
  if (!['spawn_agents', 'spawn_parallel'].includes(cleanId(action?.type))) return action;
  const seen = new Set();
  const agents = asArray(action.agents).filter((child) => {
    const key = normalizedActionFingerprint({ ...child, type: 'run_agent' });
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...action, agents };
}

export function dedupeRoutePlanActions(routePlan = {}) {
  const row = routePlan && typeof routePlan === 'object' ? routePlan : {};
  const seen = new Set();
  const actions = asArray(row.actions)
    .map(dedupeSpawnChildren)
    .filter((action) => {
      const key = normalizedActionFingerprint(action);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    ...row,
    actions,
    deduplicated_action_count: Math.max(0, asArray(row.actions).length - actions.length),
  };
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
  const preferredPattern = inferPreferredPattern(runtime, row, runtimeTeamSnapshot);
  const collaborationProfileId = cleanId(
    runtime?.teamInteractionSpec?.collaboration_profile_id
    || runtime?.activeTeamConfig?.interaction_spec?.collaboration_profile_id
    || runtime?.activeTeamConfig?.planner_metadata?.collaboration_profile_id
    || runtime?.activeTeamConfig?.room_runtime_selection?.collaboration_profile?.id
    || runtime?.activeTeamConfig?.ai_room_selection?.collaboration_profile?.id
    || row?.interaction_spec?.collaboration_profile_id
    || row?.planner_metadata?.collaboration_profile_id
    || runtimeTeamSnapshot?.interaction_spec?.collaboration_profile_id
    || runtimeTeamSnapshot?.team_plan?.interaction_spec?.collaboration_profile_id
    || runtimeTeamSnapshot?.team_plan?.planner_metadata?.collaboration_profile_id
    || ''
  );
  const explicitBuilderReviewer = collaborationProfileId === 'builder_reviewer';
  const explicitParallelCollaboration = ['parallel_ideation', 'evidence_panel'].includes(collaborationProfileId)
    || ['parallel_research_then_review_then_synthesize', 'multi_research_adjudication'].includes(preferredPattern);
  const implementationLike = isImplementationLikeRequest(message, { taskInterpretation, taskArchetype });
  const builder = findRoleAgent(teamAgents, 'builder');
  const finalOwnerAgent = resolveFinalOwnerAgent(runtime, runtimeTeamSnapshot, teamAgents);

  if ((explicitBuilderReviewer || !implementationLike) && preferredPattern === 'builder_reviewer_loop' && builder) {
    const reviewer = findRoleAgent(teamAgents, 'reviewer');
    const synthesizer = finalOwnerAgent || findRoleAgent(teamAgents, 'synthesizer') || reviewer;
    if (reviewer) {
      const ordered = [builder, reviewer];
      if (synthesizer && !ordered.some((agent) => cleanId(agent.agent_id) === cleanId(synthesizer.agent_id))) ordered.push(synthesizer);
      const actions = ordered.slice(0, 3).map((agent, index, rows) => {
        const built = buildRunAction(agent, message, { finalSynthesis: index === rows.length - 1 });
        if (index === rows.length - 1) {
          built.type = 'synthesize_final';
          built.agent = built.agent_id;
        }
        return built;
      });
      return {
        ...row,
        reason: `${String(row.reason || 'supervisor route').trim() || 'supervisor route'}; repaired_builder_reviewer_collaboration`,
        actions,
        done: false,
        await_user: false,
      };
    }
  }

  if (explicitParallelCollaboration && ['parallel_research_then_review_then_synthesize', 'multi_research_adjudication'].includes(preferredPattern)) {
    const researchers = teamAgents.filter((agent) => cleanId(agent.role_id) === 'researcher').slice(0, 3);
    const reviewer = findRoleAgent(teamAgents, 'reviewer');
    const finalAgent = finalOwnerAgent || findRoleAgent(teamAgents, 'synthesizer') || reviewer;
    // These named collaboration patterns are explicit execution contracts, not hints.
    // Rebuild them deterministically even when the supervisor produced a superficially
    // plausible single-agent or out-of-order plan.
    if (researchers.length >= 2) {
      const spawn = {
        type: 'spawn_agents',
        summary: `Independent lanes for ${preferredPattern}`,
        agents: researchers.map((agent, index) => {
          const built = buildRunAction(agent, `${message}\n독립 lane ${index + 1}로 다른 lane과 중복되지 않는 관점이나 근거를 제출하라.`);
          return {
            agent_id: built.agent_id,
            goal: built.goal,
            risk: built.risk,
            inputs: built.inputs,
            scope: built.scope,
          };
        }),
        risk: 'L1',
      };
      const actions = [spawn];
      if (reviewer && cleanId(reviewer.agent_id) !== cleanId(finalAgent?.agent_id)) {
        actions.push(buildRunAction(reviewer, `${message}\n독립 lane 결과의 중복, 근거 부족, 누락된 반대 관점을 검토해 review findings를 남겨라.`));
      }
      if (finalAgent) {
        const final = buildRunAction(finalAgent, `${message}\n독립 lane 결과를 비교하고 근거가 약한 주장을 제거한 뒤 최종안을 합성하라.`, { finalSynthesis: true });
        final.type = 'synthesize_final';
        final.agent = final.agent_id;
        actions.push(final);
      }
      return {
        ...row,
        reason: `${String(row.reason || 'supervisor route').trim() || 'supervisor route'}; repaired_parallel_collaboration`,
        actions,
        done: false,
        await_user: false,
      };
    }
  }

  if (!implementationLike || !builder) {
    return {
      ...row,
      actions: repairExistingGoals(row.actions, teamAgents, message, { finalOwnerAgent }),
    };
  }

  const reviewer = findRoleAgent(teamAgents, 'reviewer');
  const researcher = findRoleAgent(teamAgents, 'researcher');
  const synthesizer = findRoleAgent(teamAgents, 'synthesizer');
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
