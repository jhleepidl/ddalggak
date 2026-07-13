import { buildRoomPackage, buildRoomProfileFromGoal } from './room_package.js';
import { buildRoomComponentsFromPackage, createBorrowedAgentInvocation } from './ai_room_components.js';
import { buildWorkModeConfig, summarizeWorkModeConfig } from './work_mode.js';
import { buildRoomTurnRoute } from './room_turn_router.js';
import { buildStarterSingleAgentTeamConfiguration, validateTeamConfiguration } from './team_configuration.js';
import { migrateProviderAwayFromGemini, sanitizeGeminiModelForProvider } from '../provider_migration.js';
import { buildCollaborationInteractionPatch, resolveRoomCollaborationProfile } from './collaboration_profile_catalog.js';
import { modelRoleForAgentRole, resolveRoomModelRole } from './room_model_role_router.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', { lower = false, maxLen = 1000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}

function cleanId(value = '', fallback = '') {
  const text = clean(value || fallback, { lower: true, maxLen: 180 })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function titleFromRole(role = '') {
  const key = cleanId(role, 'agent');
  return key
    .split(/[_:-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Room Agent';
}

function unique(values = [], max = 32) {
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

function isCodeLikeRequest(text = '') {
  return /\b(code|repo|repository|patch|bug|test|build|deploy|api|frontend|backend)\b|코드|레포|패치|버그|테스트|빌드|배포|구현|프론트|백엔드/i.test(String(text || ''));
}

function defaultProviderForRole(role = '', { taskText = '', workMode = 'ask' } = {}) {
  const roleId = cleanId(role);
  if ((roleId.includes('builder') || roleId.includes('implementation')) && isCodeLikeRequest(taskText)) return 'codex';
  const requested = workMode === 'ask'
    ? (process.env.ROOM_ASK_PROVIDER || process.env.DDALGGAK_ASK_PROVIDER || process.env.DDALGGAK_DEFAULT_PROVIDER || 'codex')
    : (process.env.ROOM_AGENT_PROVIDER || process.env.DDALGGAK_DEFAULT_PROVIDER || 'codex');
  return migrateProviderAwayFromGemini(requested, { fallback: 'codex' }).provider;
}

function roleRankForAsk(role = '', taskText = '') {
  const key = cleanId(role);
  const text = clean(taskText, { lower: true, maxLen: 2000 });
  let score = 0;
  if (['researcher', 'synthesizer', 'story_planner', 'canon_reviewer', 'continuity_checker', 'novelty_critic'].includes(key)) score += 5;
  if (key.includes('builder') || key.includes('implementation') || key.includes('operator')) score -= 20;
  if (/캐릭터|character|canon|설정|모순|팬픽|fiction|story|plot|continuity/.test(text) && /canon|continuity|story|character|writer|planner/.test(key)) score += 5;
  if (/논문|paper|research|novelty|related/.test(text) && /research|novelty|reviewer|synthesizer/.test(key)) score += 5;
  if (/요약|정리|summarize|explain|설명/.test(text) && /synthesizer|researcher/.test(key)) score += 3;
  return score;
}

function rolesForRoomWorkMode({ roomPackage = {}, workMode = 'ask', taskText = '' } = {}) {
  const pkg = asObject(roomPackage);
  const library = buildRoomComponentsFromPackage(pkg);
  const packageRoles = unique(asArray(library.agents).map((agent) => agent.local_id || agent.role), 24);
  const domain = cleanId(pkg.domain_label || library.domain_label || 'general_workbench');

  if (workMode === 'ask') {
    const ranked = packageRoles
      .map((role) => ({ role, score: roleRankForAsk(role, taskText) }))
      .sort((a, b) => b.score - a.score);
    const chosen = ranked.find((row) => row.score > -10)?.role || (domain === 'creative_writing' ? 'canon_reviewer' : 'researcher');
    return [chosen === 'builder' || chosen.includes('builder') ? 'researcher' : chosen];
  }

  if (workMode === 'team_task') {
    if (domain === 'creative_writing') return unique(['story_planner', 'draft_writer', 'canon_reviewer', 'continuity_checker', 'revision_synthesizer'].filter((role) => packageRoles.includes(role) || packageRoles.length === 0), 8);
    if (domain === 'research_paper') return unique(['researcher', 'novelty_critic', 'method_reviewer', 'synthesizer', 'reviewer'].filter((role) => packageRoles.includes(role) || packageRoles.length === 0), 8);
    if (domain === 'code_review') return unique(['implementation_planner', 'builder', 'reviewer', 'verifier', 'delivery_synthesizer'].filter((role) => packageRoles.includes(role) || packageRoles.length === 0), 8);
    const base = packageRoles.filter((role) => !['operator'].includes(role)).slice(0, 4);
    return unique(base.length >= 2 ? base : ['researcher', 'reviewer', 'synthesizer'], 8);
  }

  if (workMode === 'team_loop_task') {
    if (domain === 'code_review') return unique(['operator', 'implementation_planner', 'builder', 'reviewer', 'verifier', 'delivery_synthesizer'], 8);
    if (domain === 'creative_writing') return unique(['operator', 'story_planner', 'draft_writer', 'canon_reviewer', 'continuity_checker', 'revision_synthesizer'], 8);
    if (domain === 'research_paper') return unique(['operator', 'researcher', 'novelty_critic', 'method_reviewer', 'synthesizer', 'reviewer'], 8);
    return unique(['operator', ...packageRoles.slice(0, 4), 'reviewer', 'synthesizer'], 8);
  }

  return ['researcher'];
}

function findAgentCard(library = {}, role = '') {
  const key = cleanId(role);
  return asArray(library.agents).find((agent) => {
    const row = asObject(agent);
    return cleanId(row.local_id || row.role || row.title) === key
      || cleanId(String(row.component_id || '').split(':').pop()) === key;
  }) || null;
}

function makeAgentFromCard({ card = null, role = '', index = 0, taskText = '', workMode = 'ask', roomPackage = null, roomProfile = null } = {}) {
  const row = asObject(card);
  const roleId = cleanId(row.local_id || row.role || role || 'researcher', 'researcher');
  const modelRole = modelRoleForAgentRole(roleId);
  const modelResolution = resolveRoomModelRole({
    modelRole,
    roomPackage,
    profile: roomProfile,
  });
  const provider = modelResolution.provider || clean(row.provider, { lower: true, maxLen: 80 }) || defaultProviderForRole(roleId, { taskText, workMode });
  const model = modelResolution.model || clean(row.model, { maxLen: 160 });
  return {
    agent_id: roleId,
    id: roleId,
    name: clean(row.title || titleFromRole(roleId), { maxLen: 120 }) || titleFromRole(roleId),
    role: roleId,
    purpose: clean(row.description || `${roleId} for this AI Room turn`, { maxLen: 500 }) || `${roleId} for this AI Room turn`,
    provider,
    model,
    model_role: modelRole,
    model_role_resolution: {
      source: modelResolution.source,
      preferred_tier: modelResolution.preferred_tier,
      fallback_tier: modelResolution.fallback_tier,
      node_id: modelResolution.node_id || '',
      route_footer: modelResolution.route_footer,
    },
    order: index,
    component_ref: row.component_id || undefined,
    memory_access: {
      read_private_source_room_memory: false,
      read_target_room_projection: true,
      write_memory_directly: false,
      allow_propose_update: true,
      ...asObject(row.memory_access),
    },
    tool_policy: {
      external_side_effects: workMode === 'ask' ? 'none' : 'approval_required',
      ...asObject(row.tool_policy),
    },
  };
}

function expandAgentsForCollaboration({ agents = [], profile = null } = {}) {
  const rows = asArray(agents).map((agent) => ({ ...asObject(agent) }));
  const collaboration = asObject(profile);
  const pattern = cleanId(collaboration.execution_pattern || '');
  if (!['parallel_research_then_review_then_synthesize', 'multi_research_adjudication'].includes(pattern)) return rows;

  const existingResearchers = rows.filter((agent) => cleanId(agent.role) === 'researcher');
  const source = existingResearchers[0] || rows.find((agent) => !/review|critic|synthesizer|operator/.test(cleanId(agent.role)));
  if (!source) return rows;
  const dimensions = asArray(asObject(collaboration.diversity_contract).dimensions)
    .map((item) => cleanId(item))
    .filter(Boolean);
  const participantCap = Math.max(rows.length, Number(collaboration.max_participants || rows.length || 4));
  const availableSlots = Math.max(0, participantCap - rows.length);
  const desiredResearchers = Math.max(2, Math.min(3, existingResearchers.length + availableSlots));
  const additions = [];
  for (let index = existingResearchers.length; index < desiredResearchers; index += 1) {
    const dimension = dimensions[index] || dimensions[index % Math.max(1, dimensions.length)] || `independent_angle_${index + 1}`;
    additions.push({
      ...source,
      agent_id: `researcher_lane_${index + 1}`,
      id: `researcher_lane_${index + 1}`,
      name: `Independent Research Lane ${index + 1}`,
      role: 'researcher',
      purpose: `Explore an independent contribution lane focused on ${dimension}; do not duplicate other lanes.`,
      order: rows.length + additions.length,
      collaboration_lane: {
        lane_id: `lane_${index + 1}`,
        diversity_dimension: dimension,
        initial_visibility: collaboration.initial_visibility || 'isolated_until_submission',
      },
    });
  }
  return [...rows, ...additions].map((agent, index) => ({ ...agent, order: index }));
}

function buildInteractionSpec({ workMode = 'ask', roles = [], agents = [], roomProfile = null } = {}) {
  const roster = asArray(agents);
  const collaborationProfile = resolveRoomCollaborationProfile(roomProfile || {});
  const collaborationPatch = collaborationProfile?.runtime_support === 'native'
    ? buildCollaborationInteractionPatch(collaborationProfile)
    : {};
  const ownerName = clean(roster[roster.length - 1]?.name || roles[roles.length - 1] || 'Agent', { maxLen: 160 });
  if (workMode === 'ask') {
    return {
      execution_pattern: 'single_specialist',
      collaboration_profile_id: collaborationProfile?.id || 'auto',
      final_answer_owner: clean(roster[0]?.name || roles[0] || 'Room Answerer', { maxLen: 160 }),
      handoffs: [],
      policies: {
        reviewer_visibility: 'summary_only',
        synthesizer_visibility: 'upstream_outputs_only',
        builder_direct_response: false,
        require_reviewer_before_final: false,
        room_awareness: collaborationProfile?.room_awareness || 'shared_goal_only',
      },
      selection_reason: 'Room Router kept this turn lightweight and used a single reusable component',
    };
  }
  const basePattern = workMode === 'team_loop_task' && roles.includes('operator') ? 'operator_gated_workflow' : 'sequential_pipeline';
  return {
    execution_pattern: collaborationPatch.execution_pattern || basePattern,
    collaboration_profile_id: collaborationProfile?.id || 'auto',
    collaboration_contract: collaborationPatch.collaboration_contract,
    final_answer_owner: ownerName,
    handoffs: [],
    policies: {
      reviewer_visibility: 'summaries_plus_selected_evidence',
      synthesizer_visibility: 'upstream_outputs_only',
      builder_direct_response: false,
      require_reviewer_before_final: roles.some((role) => /review|critic|checker|verifier/.test(role)),
      room_awareness: collaborationProfile?.room_awareness || 'shared_goal_and_roles',
      initial_visibility: collaborationProfile?.initial_visibility || 'adaptive',
      diversity_contract: Object.keys(asObject(collaborationProfile?.diversity_contract)).length ? collaborationProfile.diversity_contract : undefined,
    },
    selection_reason: `Room Router selected ${workMode}; collaboration=${collaborationProfile?.id || 'auto'}; components: ${roles.join(' -> ')}`,
  };
}

export function buildRoomFirstRuntimeSelection({
  taskText = '',
  workMode = '',
  roomProfile = null,
  roomPackage = null,
  chatId = '',
  source = 'room_first_runtime_selection',
} = {}) {
  const initialMode = summarizeWorkModeConfig(buildWorkModeConfig({ request: taskText, explicitMode: workMode || '' })).work_mode;
  const profile = asObject(roomProfile);
  const collaborationProfile = resolveRoomCollaborationProfile(profile);
  const pkg = asObject(roomPackage).kind
    ? asObject(roomPackage)
    : buildRoomPackage({ profile: profile.kind ? profile : buildRoomProfileFromGoal({ chatId, goal: taskText, source }), goal: taskText, chatId, source });
  const roomRoute = buildRoomTurnRoute({
    taskText,
    explicitMode: workMode || initialMode || '',
    inputKind: workMode || initialMode || '',
    roomPackage: pkg,
    chatId,
    source: 'room_turn_router',
  });
  const mode = roomRoute.depth || initialMode;
  const library = buildRoomComponentsFromPackage(pkg);
  const baseRoles = rolesForRoomWorkMode({ roomPackage: pkg, workMode: mode, taskText });
  const baseAgents = baseRoles.map((role, index) => makeAgentFromCard({ card: findAgentCard(library, role), role, index, taskText, workMode: mode, roomPackage: pkg, roomProfile: profile }));
  const agents = mode === 'ask'
    ? baseAgents
    : expandAgentsForCollaboration({ agents: baseAgents, profile: collaborationProfile });
  const roles = agents.map((agent) => cleanId(agent.role)).filter(Boolean);
  const borrowed = [];
  for (const role of unique(roles)) {
    const card = findAgentCard(library, role);
    if (!card) continue;
    const invocation = createBorrowedAgentInvocation({
      sourceRoomPackage: pkg,
      agentId: role,
      targetRoomId: String(chatId || profile.room_id || 'telegram_room'),
      targetRoomPackageId: pkg.package_id || profile.package_id || 'current_room_package',
      scope: mode === 'ask' ? 'single_turn' : 'single_attempt',
      contextProjection: mode === 'ask' ? 'ask_minimal_room_projection' : 'target_room_task_projection',
      reason: `room-first ${mode} selected ${role}`,
    });
    if (invocation) borrowed.push(invocation);
  }
  return {
    kind: 'ai_room_runtime_selection_v1',
    source,
    work_mode: mode,
    room: {
      room_id: String(chatId || profile.room_id || ''),
      package_id: pkg.package_id || '',
      title: pkg.title || profile.name || 'AI Room',
      domain_label: pkg.domain_label || profile.domain_label || 'general_workbench',
    },
    room_turn_route: roomRoute,
    room_router: roomRoute.room_router,
    roles,
    agents,
    component_summary: library.summary || {},
    borrowed_agent_invocations: borrowed,
    collaboration_profile: collaborationProfile,
    policies: {
      source_room_private_memory_read: false,
      target_room_projection_only: true,
      direct_memory_write: false,
      memory_update: 'proposal_only',
      component_lineage_recorded: true,
    },
  };
}

export function buildRoomFirstTeamConfiguration({
  taskText = '',
  workMode = '',
  roomProfile = null,
  roomPackage = null,
  chatId = '',
  runtime = null,
  source = 'room_first_runtime_selection',
} = {}) {
  const selection = buildRoomFirstRuntimeSelection({ taskText, workMode, roomProfile, roomPackage, chatId, source });
  if (selection.work_mode === 'ask') {
    const role = selection.roles[0] || 'researcher';
    const starter = buildStarterSingleAgentTeamConfiguration({
      taskText,
      runtime,
      preferredRole: role.includes('builder') ? 'researcher' : role,
      source,
    });
    const selectedAgent = selection.agents[0] || {};
    const agent = {
      ...(asArray(starter.agents)[0] || {}),
      ...selectedAgent,
      role: selectedAgent.role || role,
      provider: migrateProviderAwayFromGemini(selectedAgent.provider || asArray(starter.agents)[0]?.provider || 'codex', { fallback: 'codex' }).provider,
      model: sanitizeGeminiModelForProvider(selectedAgent.model || asArray(starter.agents)[0]?.model || '', selectedAgent.provider || asArray(starter.agents)[0]?.provider || 'codex'),
    };
    const normalized = validateTeamConfiguration({
      ...starter,
      team_name: `room_ask_${cleanId(selection.room.domain_label || 'room')}`,
      agents: [agent],
      interaction_spec: buildInteractionSpec({ workMode: 'ask', roles: [agent.role || role], agents: [agent], roomProfile }),
      lock_after_apply: false,
      task_archetype: selection.room.domain_label || starter.task_archetype || 'research',
      planner_metadata: {
        ...(starter.planner_metadata || {}),
        planner_type: 'ai_room_component_policy',
        planning_source: source,
        room_first: true,
        room_router_enabled: true,
        room_router_depth: selection.room_turn_route?.depth || selection.work_mode,
        room_package_id: selection.room.package_id,
        room_domain_label: selection.room.domain_label,
        collaboration_profile_id: selection.collaboration_profile?.id || 'auto',
        reasoning_summary: [
          `room-first /ask selected one reusable agent component: ${agent.role || role}`,
          'ask uses a single-turn component projection; active room team is not overwritten',
          'private source-room memory is never copied; memory writes are proposal-only',
        ],
      },
    }, { runtime });
    return {
      ...normalized,
      team_name: `room_ask_${cleanId(selection.room.domain_label || 'room')}`,
      composition_mode: 'room_components',
      room_runtime_selection: selection,
      ai_room_selection: selection,
      ephemeral: true,
      planner_metadata: {
        ...(normalized.planner_metadata || {}),
        planner_type: 'ai_room_component_policy',
        planning_source: source,
        room_first: true,
        room_router_enabled: true,
        room_router_depth: selection.room_turn_route?.depth || selection.work_mode,
        room_package_id: selection.room.package_id,
        room_domain_label: selection.room.domain_label,
      },
    };
  }

  const roles = selection.roles;
  const normalized = validateTeamConfiguration({
    team_name: `room_${selection.work_mode}_${cleanId(selection.room.domain_label || 'room')}`,
    mode: 'scoped_context',
    composition_mode: 'room_components',
    proposal_mode: 'apply',
    lock_after_apply: selection.work_mode !== 'ask',
    ephemeral: false,
    agents: selection.agents,
    interaction_spec: buildInteractionSpec({ workMode: selection.work_mode, roles, agents: selection.agents, roomProfile }),
    shortcut_policy: { max_recent_turns: 6, followup_mode: 'room_component_handoff' },
    status: 'active',
    task_brief: clean(taskText, { maxLen: 1000 }),
    design_prompt: clean(taskText, { maxLen: 2000 }),
    task_archetype: selection.room.domain_label || 'room_task',
    room_runtime_selection: selection,
    ai_room_selection: selection,
    runtime_execution: {
      execution_mode: selection.work_mode === 'team_loop_task' ? 'bounded_room_loop' : 'room_team_pass',
      execution_mode_hint: 'ai_room_component_policy',
      room_package_id: selection.room.package_id,
      component_lineage_recorded: true,
    },
    planner_metadata: {
      planner_type: 'ai_room_component_policy',
      planning_source: source,
      room_first: true,
      room_router_enabled: true,
      room_router_depth: selection.room_turn_route?.depth || selection.work_mode,
      room_package_id: selection.room.package_id,
      room_domain_label: selection.room.domain_label,
      collaboration_profile_id: selection.collaboration_profile?.id || 'auto',
      selected_component_ids: selection.agents.map((agent) => agent.component_ref).filter(Boolean),
      reasoning_summary: [
        `room-first ${selection.work_mode} selected reusable room components`,
        `roles: ${roles.join(' → ')}`,
        'legacy workspace builder/reviewer fallback is not used unless the active room/package is code_review or the user asks for code/workspace mutation',
        'borrowed agents receive only target-room context projections and can only propose memory updates',
      ],
    },
  }, { runtime });
  return {
    ...normalized,
    team_name: `room_${selection.work_mode}_${cleanId(selection.room.domain_label || 'room')}`,
    composition_mode: 'room_components',
    room_runtime_selection: selection,
    ai_room_selection: selection,
    ephemeral: false,
    planner_metadata: {
      ...(normalized.planner_metadata || {}),
      planner_type: 'ai_room_component_policy',
      planning_source: source,
      room_first: true,
      room_router_enabled: true,
      room_router_depth: selection.room_turn_route?.depth || selection.work_mode,
      room_package_id: selection.room.package_id,
      room_domain_label: selection.room.domain_label,
      collaboration_profile_id: selection.collaboration_profile?.id || 'auto',
      selected_component_ids: selection.agents.map((agent) => agent.component_ref).filter(Boolean),
    },
  };
}
