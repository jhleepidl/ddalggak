import { getCredentialBindingState } from './credential_binding.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function clip(value = '', max = 280) {
  const raw = clean(value);
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw;
}

function summarizeTeam(team = {}) {
  const row = asObject(team);
  const agents = asArray(row.agents).map((entry) => asObject(entry));
  return {
    team_name: clean(row.team_name || row.teamName || row.name || 'team') || 'team',
    agent_count: agents.length,
    attached_skill_ids: agents.flatMap((agent) => asArray(agent.attached_skill_ids || agent.attachedSkillIds || agent.skills)).map((entry) => clean(entry)).filter(Boolean).slice(0, 24),
    roles: agents.map((agent) => clean(agent.role || agent.role_id || agent.roleId || agent.name)).filter(Boolean).slice(0, 24),
  };
}

export function buildRawHistorySnapshot({
  chatId = '',
  session = {},
  runtime = null,
  teamState = null,
  credentialBindingState = null,
} = {}) {
  const normalizedSession = asObject(session);
  const boundState = credentialBindingState || getCredentialBindingState({ get: () => normalizedSession }, chatId);
  const recentUserMessages = asArray(normalizedSession.pending_user_messages).slice(-12).map((entry) => ({
    ts: clean(entry.ts),
    text: clip(entry.text, 500),
    force_mode: clean(entry.force_mode || entry.forceMode),
  })).filter((entry) => entry.text);
  const recentAgentTurns = asArray(normalizedSession.recent_agent_turns).slice(-12).map((entry) => ({
    ts: clean(entry.ts),
    agent_id: clean(entry.agent_id || entry.agentId),
    agent_name: clean(entry.agent_name || entry.agentName || entry.agent_id || entry.agentId),
    role: clean(entry.role),
    model: clean(entry.model),
    provider: clean(entry.provider),
    goal: clip(entry.goal, 220),
    output: clip(entry.output, 800),
  })).filter((entry) => entry.output || entry.goal);
  const answerCapsules = asArray(normalizedSession.answer_capsules).slice(-8).map((entry) => ({
    ts: clean(entry.ts),
    label: clean(entry.label || entry.title || entry.kind || 'answer'),
    text: clip(entry.text || entry.summary || entry.content, 500),
  })).filter((entry) => entry.text);

  const activeTeamSummary = summarizeTeam(asObject(teamState?.active_team || teamState?.activeTeam));
  const pendingTeamSummary = summarizeTeam(asObject(teamState?.pending_team || teamState?.pendingTeam));
  const runtimeInfo = {
    thread_id: clean(runtime?.map?.threadId || runtime?.threadId),
    context_set_id: clean(runtime?.map?.ctxSharedId || runtime?.contextSetId),
    memory_mode: clean(runtime?.memoryMode || runtime?.memory_mode || runtime?.map?.memoryMode),
    execution_mode: clean(runtime?.executionMode || runtime?.execution_mode),
  };

  const extractedArtifacts = [];
  const pushedSkillIds = new Set();
  if (activeTeamSummary.agent_count > 0) {
    extractedArtifacts.push({
      kind: 'team_blueprint_reference',
      label: `active:${activeTeamSummary.team_name}`,
      agent_count: activeTeamSummary.agent_count,
      roles: activeTeamSummary.roles.slice(0, 12),
      attached_skill_ids: activeTeamSummary.attached_skill_ids.slice(0, 12),
    });
  }
  if (pendingTeamSummary.agent_count > 0) {
    extractedArtifacts.push({
      kind: 'team_blueprint_reference',
      label: `pending:${pendingTeamSummary.team_name}`,
      agent_count: pendingTeamSummary.agent_count,
      roles: pendingTeamSummary.roles.slice(0, 12),
      attached_skill_ids: pendingTeamSummary.attached_skill_ids.slice(0, 12),
    });
  }
  for (const skillId of [...activeTeamSummary.attached_skill_ids, ...pendingTeamSummary.attached_skill_ids]) {
    const cleanSkillId = clean(skillId);
    if (!cleanSkillId || pushedSkillIds.has(cleanSkillId)) continue;
    pushedSkillIds.add(cleanSkillId);
    extractedArtifacts.push({
      kind: 'skill_package_reference',
      skill_id: cleanSkillId,
      source_phase: activeTeamSummary.attached_skill_ids.includes(cleanSkillId) ? 'active' : 'pending',
      reason: 'attached to observed team',
    });
  }

  const lines = [
    '# ddalggak raw history snapshot',
    '',
    `chat_id: ${clean(chatId) || '-'}`,
    `updated_at: ${clean(normalizedSession.updated_at) || '-'}`,
    `state: ${clean(normalizedSession.state) || 'idle'}`,
    `active_run_id: ${clean(normalizedSession.active_run_id || normalizedSession.activeRunId) || '-'}`,
    `thread_id: ${runtimeInfo.thread_id || '-'}`,
    `context_set_id: ${runtimeInfo.context_set_id || '-'}`,
    `memory_mode: ${runtimeInfo.memory_mode || '-'}`,
    `execution_mode: ${runtimeInfo.execution_mode || '-'}`,
    `credential_bindings: ${Number(boundState?.summary?.bound_count || 0)}`,
    '',
    '## active team',
    `- name: ${activeTeamSummary.team_name}`,
    `- agents: ${activeTeamSummary.agent_count}`,
    `- roles: ${activeTeamSummary.roles.join(', ') || '-'}`,
    `- attached_skills: ${activeTeamSummary.attached_skill_ids.join(', ') || '-'}`,
    '',
    '## pending team',
    `- name: ${pendingTeamSummary.team_name}`,
    `- agents: ${pendingTeamSummary.agent_count}`,
    `- roles: ${pendingTeamSummary.roles.join(', ') || '-'}`,
    `- attached_skills: ${pendingTeamSummary.attached_skill_ids.join(', ') || '-'}`,
    '',
    '## recent user messages',
    ...(recentUserMessages.length > 0
      ? recentUserMessages.map((entry) => `- [${entry.ts || '-'}] ${entry.text}${entry.force_mode ? ` (${entry.force_mode})` : ''}`)
      : ['- none']),
    '',
    '## recent agent turns',
    ...(recentAgentTurns.length > 0
      ? recentAgentTurns.flatMap((entry) => [
          `- [${entry.ts || '-'}] ${entry.agent_name || entry.agent_id || 'agent'}${entry.role ? ` · role=${entry.role}` : ''}${entry.provider ? ` · provider=${entry.provider}` : ''}${entry.model ? ` · model=${entry.model}` : ''}`,
          `  goal: ${entry.goal || '-'}`,
          `  output: ${entry.output || '-'}`,
        ])
      : ['- none']),
    '',
    '## answer capsules',
    ...(answerCapsules.length > 0
      ? answerCapsules.map((entry) => `- [${entry.ts || '-'}] ${entry.label}: ${entry.text}`)
      : ['- none']),
    '',
    '## runtime events',
    `- last_recovery: ${clip(normalizedSession?.last_recovery_event?.category || normalizedSession?.lastRecoveryEvent?.category || '-', 180) || '-'}`,
    `- last_fork: ${clip(normalizedSession?.last_fork_event?.forked_agent_id || normalizedSession?.lastForkEvent?.forkedAgentId || '-', 180) || '-'}`,
    `- last_rejoin: ${clip(normalizedSession?.last_rejoin_event?.agent_id || normalizedSession?.lastRejoinEvent?.agentId || '-', 180) || '-'}`,
  ];

  const summary = [
    `state=${clean(normalizedSession.state) || 'idle'}`,
    `recent_turns=${recentAgentTurns.length}`,
    `pending_user_messages=${recentUserMessages.length}`,
    `active_team_agents=${activeTeamSummary.agent_count}`,
  ].join(' · ');

  return {
    title: `Runtime history · chat ${clean(chatId) || 'unknown'}`,
    summary,
    raw_text: lines.join('\n'),
    stream_key: `chat:${clean(chatId) || 'unknown'}`,
    uri: `ddalggak://chat/${encodeURIComponent(clean(chatId) || 'unknown')}/history`,
    chat_id: clean(chatId) || undefined,
    job_id: clean(normalizedSession.jobId || normalizedSession.job_id) || undefined,
    run_id: clean(normalizedSession.active_run_id || normalizedSession.activeRunId) || undefined,
    session_id: clean(chatId) || undefined,
    source: 'ddalggak',
    tags: ['ddalggak', 'telegram', 'raw-history'],
    provenance: {
      runtime: runtimeInfo,
      credential_binding_summary: asObject(boundState?.summary),
      active_team: activeTeamSummary,
      pending_team: pendingTeamSummary,
    },
    extracted_artifacts: extractedArtifacts,
    auto_activate: false,
    update_latest: true,
  };
}

export async function syncRawHistoryToGoC({
  client = null,
  threadId = '',
  chatId = '',
  chatSessionStore = null,
  runtime = null,
  teamState = null,
} = {}) {
  const cleanThreadId = clean(threadId);
  if (!client || typeof client.upsertRawHistory !== 'function') {
    throw new Error('syncRawHistoryToGoC requires client.upsertRawHistory');
  }
  if (!cleanThreadId) throw new Error('syncRawHistoryToGoC requires threadId');
  const session = chatSessionStore?.get?.(chatId) || {};
  const snapshot = buildRawHistorySnapshot({
    chatId,
    session,
    runtime,
    teamState,
    credentialBindingState: chatSessionStore ? getCredentialBindingState(chatSessionStore, chatId) : null,
  });
  const saved = await client.upsertRawHistory(cleanThreadId, snapshot);
  return {
    snapshot,
    saved,
  };
}
