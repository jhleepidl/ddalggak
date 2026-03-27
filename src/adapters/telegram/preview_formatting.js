import { clip } from '../../textutil.js';
import { formatSkillLabels, humanizeModel } from '../../application/team_presentation.js';
import { buildTeamInstallProposal } from '../../application/install_proposal.js';
import {
  buildPreviewAgentDisplayIndex,
  formatChatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from '../../shared/agent_labels.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asMap(value) {
  return value instanceof Map ? value : new Map();
}

function isAgentActionType(type = '') {
  return ['run_agent', 'agent_run', 'synthesize_final'].includes(type);
}

function isMostlyBackendOnlyAction(type = '') {
  return ['summarize', 'checkpoint', 'supervisor_decision', 'gate_wait', 'human_checkpoint', 'tool_proxy_call', 'memory_sync', 'committee_consensus'].includes(String(type || '').trim().toLowerCase())
}


function compactRoleGoalLabel(roleId = '', { finalSynthesis = false } = {}) {
  const key = String(roleId || '').trim().toLowerCase();
  if (finalSynthesis || key === 'synthesizer') return '최종 결과를 정리하고 사용자 전달 형식으로 마감';
  if (key === 'builder') return '실제 구현 산출물을 만들고 실행 가능한 결과를 남김';
  if (key === 'reviewer') return '구현 결과를 검토하고 blocker/리스크를 정리';
  if (key === 'researcher') return '구현 전 핵심 요구사항·가정·리스크를 정리';
  return '';
}

function summarizeActionGoalForTelegram(action = {}, goalClipMax = 160) {
  const inputs = action && typeof action.inputs === 'object' ? action.inputs : {};
  const roleId = String(inputs.role_id || inputs.roleId || '').trim().toLowerCase();
  const finalSynthesis = inputs.final_synthesis === true || inputs.finalSynthesis === true;
  const compact = compactRoleGoalLabel(roleId, { finalSynthesis });
  const rawGoal = String(getActionGoal(action) || '').trim();
  if (compact && (!rawGoal || rawGoal.length > 140 || /^(사용자 요청을 계획하고 필요한 agent 작업을 제안\/수행|요청된 코드\/노트북 산출물을 구현|기존 agent를 재사용해 요청 처리|구현을 바로 진행할 수 있도록|원 요청과 upstream handoff를 바탕으로|현재 구현 산출물을 검토하고|upstream 결과와 검토 결과를 합쳐)/i.test(rawGoal))) {
    return compact;
  }
  return clip(rawGoal || compact || '(goal 없음)', Math.min(goalClipMax, 110));
}

function formatActionMeta(action = {}) {
  const inputs = action && typeof action.inputs === 'object' ? action.inputs : {}
  const skillIds = asArray(inputs.attached_skill_ids || inputs.attachedSkillIds).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3)
  const skillLabels = formatSkillLabels(skillIds, { max: 3 })
  const model = humanizeModel(String(inputs.provider || '').trim(), String(inputs.model || '').trim())
  const parts = []
  if (skillLabels.length > 0) parts.push(`skills=${skillLabels.join(', ')}`)
  if (model && model !== '(미지정)') parts.push(`model=${model}`)
  return parts.join(' · ')
}

export function getActionGoal(action = {}) {
  if (!action || typeof action !== 'object') return '';
  return String(action.goal || action.prompt || action.task || '').trim();
}

export function formatActionAgentLabel(action = {}, {
  agentIndex = new Map(),
  fallback = 'unknown',
} = {}) {
  const index = asMap(agentIndex);
  const rawHint = resolveActionAgentNameHint(action);
  const nameHint = ['Agent', 'Runtime Agent'].includes(String(rawHint || '').trim()) ? '' : rawHint;
  const agentId = resolveActionAgentId(action);
  if (nameHint) return formatChatAgentDisplayName(agentId || nameHint, index, { nameHint });
  if (!agentId) return fallback;
  return formatChatAgentDisplayName(agentId, index, { nameHint });
}

export function formatChatActionLabel(action = {}, {
  agentIndex = new Map(),
  needMoreDetailFallback = 'ctx',
  publishFallbackMode = 'unknown',
  openContextFallback = 'current',
} = {}) {
  const index = asMap(agentIndex);
  const type = String(action?.type || '').trim().toLowerCase();
  if (!type) return '(unknown)';
  if (type === 'run_agent' || type === 'agent_run') return `run_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'synthesize_final') return `synthesize_final:${formatActionAgentLabel(action, { agentIndex: index, fallback: 'Synthesizer' })}`;
  if (type === 'propose_agent') return `propose_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'need_more_detail') return `need_more_detail:${action.context_set_id || needMoreDetailFallback}`;
  if (type === 'search_public_agents') return `search_public_agents:${action.query || ''}`;
  if (type === 'install_agent_blueprint') return `install_agent_blueprint:${action.blueprint_id || action.public_node_id || ''}`;
  if (type === 'publish_agent') {
    const fallback = publishFallbackMode === 'agent_node_id'
      ? String(action.agent_node_id || 'unknown')
      : 'unknown';
    return `publish_agent:${formatActionAgentLabel(action, { agentIndex: index, fallback })}`;
  }
  if (type === 'add_agent_to_conversation') return `add_agent_to_conversation:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'remove_agent_from_conversation') return `remove_agent_from_conversation:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'create_agent_definition') return `create_agent_definition:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'fork_agent') return `fork_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'disable_agent') return `disable_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'enable_agent') return `enable_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'disable_tool') return `disable_tool:${action.tool_id || 'unknown'}`;
  if (type === 'enable_tool') return `enable_tool:${action.tool_id || 'unknown'}`;
  if (type === 'list_agents') return 'list_agents';
  if (type === 'list_tools') return 'list_tools';
  if (type === 'create_agent') return `create_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'update_agent') return `update_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === 'get_status') return 'get_status';
  if (type === 'interrupt') return `interrupt:${action.mode || 'replan'}`;
  if (type === 'spawn_agents' || type === 'spawn_parallel') return `${type}:${Array.isArray(action.agents) ? action.agents.length : 0}`;
  if (type === 'checkpoint') return `checkpoint:${action.label || action.inputs?.checkpoint_id || 'pending'}`;
  if (type === 'supervisor_decision') return `supervisor_decision:${action.label || 'Supervisor'}`;
  if (type === 'gate_wait') return `gate_wait:${action.label || action.inputs?.slot_id || 'gate'}`;
  if (type === 'human_checkpoint') return `human_checkpoint:${action.label || action.inputs?.slot_id || 'human'}`;
  if (type === 'tool_proxy_call') return `tool_proxy_call:${action.label || action.inputs?.slot_id || 'tool_proxy'}`;
  if (type === 'memory_sync') return `memory_sync:${action.label || action.inputs?.slot_id || 'memory'}`;
  if (type === 'committee_consensus') return `committee_consensus:${action.label || action.inputs?.consensus_mode || 'committee'}`;
  if (type === 'open_context') return `open_context:${action.scope || openContextFallback}`;
  return type;
}

export function buildPlanPreviewLines(actions = [], {
  agentIndex = new Map(),
  actionLabel = null,
  goalClipMax = 160,
} = {}) {
  const index = asMap(agentIndex);
  const labelFn = typeof actionLabel === 'function'
    ? actionLabel
    : (action) => formatChatActionLabel(action, { agentIndex: index });
  const lines = [];
  const systemNotes = [];
  for (const action of asArray(actions)) {
    const type = String(action?.type || '').trim().toLowerCase();
    if (isAgentActionType(type)) {
      const agentId = formatActionAgentLabel(action, { agentIndex: index });
      const goal = summarizeActionGoalForTelegram(action, goalClipMax);
      const meta = formatActionMeta(action);
      lines.push(`- ${agentId}${meta ? ` · ${meta}` : ''}: ${goal}`);
      continue;
    }
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      const children = asArray(action?.agents);
      for (const child of children) {
        const childId = formatActionAgentLabel(child, { agentIndex: index });
        const goal = summarizeActionGoalForTelegram(child, goalClipMax);
        const meta = formatActionMeta(child);
        lines.push(`- ${childId}${meta ? ` · ${meta}` : ''}: ${goal}`);
      }
      continue;
    }
    if (isMostlyBackendOnlyAction(type)) {
      systemNotes.push(labelFn(action));
      continue;
    }
    systemNotes.push(labelFn(action));
  }
  if (lines.length === 0) lines.push('- 실행할 agent action이 아직 없습니다');
  if (systemNotes.length > 0) lines.push(`- system: ${systemNotes.slice(0, 2).join(', ')}`);
  return lines;
}

export function buildQueuedAgentStatusFromActions(actions = []) {
  const out = {};
  for (const action of asArray(actions)) {
    const type = String(action?.type || '').trim().toLowerCase();
    if (type === 'run_agent' || type === 'agent_run' || type === 'synthesize_final') {
      const agentId = String(resolveActionAgentId(action) || '').trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: 'queued',
        goal: getActionGoal(action),
        display_label: resolveActionAgentNameHint(action) || undefined,
      };
      continue;
    }
    if (type !== 'spawn_agents' && type !== 'spawn_parallel') continue;
    for (const child of asArray(action?.agents)) {
      const agentId = String(resolveActionAgentId(child) || '').trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: 'queued',
        goal: String(child?.goal || child?.prompt || child?.task || '').trim(),
        display_label: resolveActionAgentNameHint(child) || undefined,
      };
    }
  }
  return out;
}

export function buildAgentStatusLines(agentStatusMap = {}, { agentIndex = new Map() } = {}) {
  const map = agentStatusMap && typeof agentStatusMap === 'object' ? agentStatusMap : {};
  const index = asMap(agentIndex);
  const entries = Object.entries(map);
  if (entries.length === 0) return ['- (agent 없음)'];
  const stateEmoji = {
    queued: '⏳',
    running: '🏃',
    done: '✅',
    error: '❌',
  };
  return entries
    .map(([agentIdRaw, rowRaw]) => {
      const agentId = String(agentIdRaw || '').trim().toLowerCase();
      if (!agentId) return '';
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const state = String(row.state || '').trim().toLowerCase();
      const normalizedState = ['queued', 'running', 'done', 'error'].includes(state)
        ? state
        : 'queued';
      const emoji = stateEmoji[normalizedState] || '⏳';
      const agentDisplay = formatChatAgentDisplayName(agentId, index, {
        nameHint: String(row.display_label || row.displayLabel || row.label || row.name || '').trim(),
      });
      return `- ${agentDisplay} ${emoji} ${normalizedState}`;
    })
    .filter(Boolean);
}

export function buildRoutedDashboardText({ actions = [], agentStatus = {}, actionLabel = null, agentIndex = new Map() } = {}) {
  const planLines = buildPlanPreviewLines(actions, {
    actionLabel,
    agentIndex,
  });
  const statusLines = buildAgentStatusLines(agentStatus, { agentIndex });
  return [
    '🧭 분담 · 이번 턴 팀 구성',
    '🧭 핵심 agent',
    ...planLines,
    '',
    '📡 상태',
    ...statusLines,
  ].join('\n');
}


export function buildCompactRoutedDashboardText({ actions = [], agentStatus = {}, agentIndex = new Map(), routeReadiness = "", routeReason = "" } = {}) {
  const index = asMap(agentIndex);
  const agentLabels = [];
  const seen = new Set();
  let backendOnlyCount = 0;
  let parallelCount = 0;
  for (const action of asArray(actions)) {
    const type = String(action?.type || '').trim().toLowerCase();
    if (isAgentActionType(type)) {
      const label = formatActionAgentLabel(action, { agentIndex: index });
      if (label && !seen.has(label)) {
        seen.add(label);
        agentLabels.push(label);
      }
      continue;
    }
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      const children = asArray(action?.agents);
      parallelCount += children.length;
      for (const child of children) {
        const label = formatActionAgentLabel(child, { agentIndex: index });
        if (label && !seen.has(label)) {
          seen.add(label);
          agentLabels.push(label);
        }
      }
      continue;
    }
    if (isMostlyBackendOnlyAction(type)) backendOnlyCount += 1;
  }
  const statusLines = buildAgentStatusLines(agentStatus, { agentIndex: index });
  const runningCount = statusLines.filter((line) => /🏃\s+running/.test(String(line || ''))).length;
  const queuedCount = statusLines.filter((line) => /⏳\s+queued/.test(String(line || ''))).length;
  const doneCount = statusLines.filter((line) => /✅\s+done/.test(String(line || ''))).length;
  const pattern = parallelCount > 1 ? 'parallel' : (agentLabels.length > 1 ? 'sequential' : 'single');
  const compactAgents = agentLabels.slice(0, 4).join(', ');
  const overflow = Math.max(0, agentLabels.length - 4);
  const statusSummaryParts = [];
  if (runningCount > 0) statusSummaryParts.push(`running ${runningCount}`);
  if (queuedCount > 0) statusSummaryParts.push(`queued ${queuedCount}`);
  if (doneCount > 0) statusSummaryParts.push(`done ${doneCount}`);
  const lines = [
    '🧭 이번 턴 계획',
    `- 핵심 agent: ${compactAgents || '(none)'}${overflow > 0 ? ` 외 ${overflow}` : ''}`,
    `- 실행 방식: ${pattern}`,
    `- 단계 수: ${asArray(actions).length}`,
    `- 상태: ${statusSummaryParts.join(' · ') || 'queued'}`,
  ];
  if (backendOnlyCount > 0) lines.push(`- 내부 준비 단계: ${backendOnlyCount}`);
  if (String(routeReadiness || '').trim()) lines.push(`- 라우팅 준비: ${String(routeReadiness || '').trim()}`);
  if (String(routeReason || '').trim()) lines.push(`- 선택 근거: ${String(routeReason || '').trim()}`);
  lines.push('- 세부 단계는 버튼 또는 /status full');
  return lines.join('\n');
}

export function buildPreviewAgentIndex(options = {}) {
  return buildPreviewAgentDisplayIndex(options);
}

export function inferApprovalPreviewReason(pending = {}) {
  const explicit = String(pending?.preview_reason || pending?.reason || '').trim();
  if (explicit) return explicit;
  const type = String(pending?.action?.type || '').trim().toLowerCase();
  if ([
    'create_agent',
    'create_agent_definition',
    'update_agent',
    'propose_agent',
    'enable_agent',
    'disable_agent',
    'enable_tool',
    'disable_tool',
  ].includes(type)) return 'agent/tool 설정 변경';
  if (['publish_agent', 'install_agent_blueprint'].includes(type)) return 'publish/install';
  return '외부 상태 변경 가능성';
}

export function buildApprovalActionSummaryLines(pending = {}, {
  actionLabel = () => '(unknown)',
} = {}) {
  if (Array.isArray(pending?.actions_summary) && pending.actions_summary.length > 0) {
    return pending.actions_summary
      .map((row) => String(row || '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => (row.startsWith('- ') ? row : `- ${row}`));
  }
  if (Array.isArray(pending?.preview_lines) && pending.preview_lines.length > 0) {
    return pending.preview_lines
      .map((row) => String(row || '').trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => (row.startsWith('- ') ? row : `- ${row}`));
  }
  const remaining = asArray(pending?.remaining_actions);
  if (remaining.length > 0) {
    return remaining
      .slice(0, 8)
      .map((action) => `- ${actionLabel(action)}`);
  }
  return [`- ${actionLabel(pending?.action)}`];
}

function normalizeDeliverableList(raw, { max = 24 } = {}) {
  const rows = asArray(raw);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = String(row || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Math.floor(max))) break;
  }
  return out;
}

export function buildAutopilotProgressSummary({
  turn = 1,
  maxTurns = 1,
  deliverables = [],
  completedDeliverables = [],
  results = [],
  outputs = [],
  suggestedActions = [],
  followupHint = '',
  actionLabel = () => '(unknown)',
} = {}) {
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase()),
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const okCount = asArray(results).filter((row) => String(row?.status || '') === 'ok').length;
  const errorCount = asArray(results).filter((row) => String(row?.status || '') === 'error').length;
  const outputPreview = asArray(outputs)
    .slice(-3)
    .map((row) => `- ${String(row?.agentId || 'system')}: ${clip(String(row?.output || ''), 120)}`)
    .filter(Boolean)
    .join('\n');
  const suggestedPreview = asArray(suggestedActions)
    .slice(0, 6)
    .map((action) => `- ${actionLabel(action)}`)
    .join('\n');
  return [
    `autopilot_turn=${turn}/${maxTurns}`,
    allDeliverables.length > 0 ? `deliverables=${allDeliverables.join(' | ')}` : 'deliverables=(none)',
    doneSet.size > 0 ? `completed=${Array.from(doneSet).join(' | ')}` : 'completed=(none)',
    remaining.length > 0 ? `remaining=${remaining.join(' | ')}` : 'remaining=(none)',
    `last_results: ok=${okCount}, error=${errorCount}`,
    followupHint ? `last_followup_hint=${followupHint}` : '',
    outputPreview ? `last_outputs:\n${outputPreview}` : '',
    suggestedPreview ? `agent_suggested_actions:\n${suggestedPreview}` : '',
  ].filter(Boolean).join('\n');
}

export function buildAutopilotFollowupMessage({
  originalUserText = '',
  deliverables = [],
  completedDeliverables = [],
  followupHint = '',
  suggestedActions = [],
  actionLabel = () => '(unknown)',
} = {}) {
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase()),
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const suggestedLines = asArray(suggestedActions)
    .slice(0, 5)
    .map((action) => `- ${actionLabel(action)}`)
    .join('\n');
  return [
    '자동 연속 실행 지시: 이전 턴 결과를 이어서 남은 산출물을 진행하라.',
    `원 요청: ${String(originalUserText || '').trim()}`,
    remaining.length > 0 ? `남은 deliverables: ${remaining.join(' | ')}` : '남은 deliverables 없음(완료 검증 필요)',
    followupHint ? `followup_hint: ${followupHint}` : '',
    suggestedLines ? `agent_suggested_actions:\n${suggestedLines}` : '',
    '필요 시 연구->코드->검토 순으로 다음 step을 배치하라.',
  ].filter(Boolean).join('\n');
}

export function updateCompletedDeliverablesFromOutputs(deliverables = [], completed = [], outputs = []) {
  const all = normalizeDeliverableList(deliverables, { max: 24 });
  const done = new Set(
    normalizeDeliverableList(completed, { max: 24 }).map((row) => row.toLowerCase()),
  );
  const rows = asArray(outputs);
  const hasCoderOutput = rows.some((row) => String(row?.agentId || '').trim().toLowerCase() === 'coder');
  const hasResearchOutput = rows.some((row) => {
    const agentId = String(row?.agentId || '').trim().toLowerCase();
    return agentId === 'researcher' || agentId === 'planner';
  });
  const joinedText = rows.map((row) => String(row?.output || '')).join('\n').toLowerCase();

  for (const item of all) {
    const key = String(item || '').trim().toLowerCase();
    if (!key || done.has(key)) continue;
    if (/코드|ipynb|notebook|노트북|jupyter|실습|coding|python/.test(key)) {
      if (hasCoderOutput || /```python|\.ipynb|jupyter|notebook|코드/.test(joinedText)) done.add(key);
      continue;
    }
    if (/주제|아이디어|토픽|topic|proposal|제안/.test(key)) {
      if (hasResearchOutput || /주제|아이디어|토픽|proposal|추천/.test(joinedText)) done.add(key);
      continue;
    }
    if (/과제|assignment|문항|quiz|연습문제/.test(key)) {
      if (/문항|문제|과제|assignment|quiz/.test(joinedText)) done.add(key);
      continue;
    }
    if (joinedText.includes(key)) done.add(key);
  }

  return Array.from(done);
}

export function summarizeSpecialChatOutputs(outputs = []) {
  const rows = asArray(outputs);
  const artifacts = rows
    .map((row) => row && typeof row === 'object' ? row.artifacts : [])
    .flat()
    .filter(Boolean);
  if (artifacts.length === 0) return null;
  const bulletLines = artifacts
    .map((artifact) => {
      const title = String(artifact.title || artifact.path || artifact.url || '').trim();
      const value = String(artifact.url || artifact.path || '').trim();
      if (!title && !value) return '';
      return `- ${title || value}`;
    })
    .filter(Boolean);
  if (bulletLines.length === 0) return null;
  return ['생성된 결과물:', ...bulletLines].join('\n');
}


function isFinalLikeAgent(row = {}) {
  const agent = String(row?.agentId || row?.agent || row?.roleId || '').trim().toLowerCase();
  return /(synth|final|신서사이저|최종)/.test(agent);
}

function pickPreferredFallbackOutput(rows = []) {
  const list = asArray(rows).filter((row) => row && typeof row === 'object' && String(row.output || row.text || row.summary || '').trim());
  if (list.length === 0) return '';
  const preferred = list.find((row) => isFinalLikeAgent(row)) || list[list.length - 1];
  return clip(String(preferred.output || preferred.text || preferred.summary || '').trim(), 3800);
}

function detectCapabilityGapLines(executionLike = {}, { maxLines = 4, runtime = null } = {}) {
  const proposal = buildTeamInstallProposal({ execution: executionLike, runtime });
  return [
    ...proposal.gap_preview_lines.slice(0, Math.max(1, Number(maxLines) || 4)),
    ...((proposal.requirements?.install_hints || []).slice(0, Math.max(1, Number(maxLines) || 4)).map((entry) => `- hint: ${entry}`)),
    ...((proposal.suggested_commands || []).slice(0, 3).map((entry) => `- command: ${entry}`)),
  ].slice(0, Math.max(2, Number(maxLines) || 4) + 3);
}

export function buildChatSynthesisFallback(outputs = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const executionLike = (!Array.isArray(outputs) && outputs && typeof outputs === 'object' && Array.isArray(outputs.outputs))
    ? outputs
    : ((!Array.isArray(outputs) && opts && typeof opts === 'object' && Array.isArray(opts.outputs)) ? opts : null);
  const rowsSource = executionLike ? asArray(executionLike.outputs) : asArray(outputs);
  const maxLines = Number.isFinite(Number(opts.maxLines))
    ? Math.max(1, Math.floor(Number(opts.maxLines)))
    : 6;
  const rows = rowsSource
    .map((row) => {
      if (!row || typeof row !== 'object') return '';
      const agent = String(row.agentId || row.agent || '').trim() || 'system';
      const text = String(row.output || row.text || row.summary || '').trim();
      if (!text) return '';
      return `- ${agent}: ${clip(text, 260)}`;
    })
    .filter(Boolean)
    .slice(-maxLines);
  const capabilityGapLines = executionLike ? detectCapabilityGapLines(executionLike, { maxLines, runtime: opts.runtime }) : [];
  if (capabilityGapLines.length > 0) {
    return ['실행 중 필요한 도구/자격 정보가 부족했습니다.', ...capabilityGapLines].join('\n');
  }
  const preferredOutput = pickPreferredFallbackOutput(rowsSource);
  if (preferredOutput) return preferredOutput;
  if (rows.length > 0) return ['현재까지 결과 요약:', ...rows].join('\n');

  const resultRows = executionLike
    ? asArray(executionLike.results)
      .map((row) => {
        if (!row || typeof row !== 'object') return '';
        const status = String(row.status || '').trim().toLowerCase();
        if (!['error', 'blocked', 'skip'].includes(status)) return '';
        const label = String(row.label || row.agent || row.agentId || 'step').trim();
        const note = String(row.note || row.error || row.reason || '').trim();
        if (!note) return '';
        return `- ${label}: ${clip(note, 220)}`;
      })
      .filter(Boolean)
      .slice(-maxLines)
    : [];
  if (resultRows.length > 0) {
    return ['실행 중 일부 단계가 완료되지 않았습니다.', ...resultRows].join('\n');
  }

  return executionLike
    ? '실행 결과를 아직 확보하지 못했습니다. 다시 시도하거나 /status 로 상태를 확인해 주세요.'
    : '';
}
