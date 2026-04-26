import fs from "node:fs";
import path from "node:path";

import {
  sendTextWithOptionalGocButton as sendTextWithOptionalGocButtonAdapter,
} from "../adapters/telegram/send.js";
import { isTelegramWebAppHttpsError } from "../adapters/telegram/context_links.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  buildPreviewAgentDisplayIndex,
  formatChatAgentDisplayName,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { clip } from "../textutil.js";
import { buildExecutionInsightSnapshot } from "./team_execution_insights.js";
import { loadExecutionFeedbackSummary } from "./execution_feedback.js";
import {
  agentRegistry,
  bindGocActor,
  queue,
  jobAbortControllers,
  activeJobByChat,
  lastChatJobByChat,
  jobs,
  memory,
  MEMORY_MODE,
  gocInitError,
  memoryModeWithFallback,
  requireGocClient,
  resolveCurrentJobIdForChat,
  getAwait,
  chatSessionStore,
  tracking,
} from "./telegram_runtime_state.js";
import {
  buildContextInfo,
  loadArtifactIndex,
  sendLong,
  formatArtifactIndexText,
  resolveArtifactDeliveryContract,
  formatArtifactDeliveryContractLines,
} from "./telegram_runtime_io.js";
import {
  composeCapabilitiesForRun,
  loadSupervisorRuntime,
  openAgentsUiInfo,
  refreshAgentRegistry,
  summarizeSelectionState,
  recordMembershipMutationDiagnostic,
} from "./telegram_goc_runtime.js";
import { chatActionLabel } from "./telegram_route_planning.js";
import { runConversationAgentTeamCommand } from "./agent_team_commands.js";
import {
  buildRunAuthority,
  buildRunAuthorityPatch,
} from "./run_authority.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { formatSkillLabels, formatRoleOverlayProfile, humanizeModel, resolveAgencyOverlayMeta, roleLabel } from "./team_presentation.js";
import { summarizeRoleMemoryEnforcement } from "../knowledge_base/runtime.js";
import { resolveRoutingContractSummary, formatRouteReadiness } from "./route_contract.js";
import {
  buildSkillDraftFromRequest,
  buildSkillDraftApprovalState,
  formatSkillDraftApprovalMessage,
} from "./skill_draft_approval.js";

async function sendTextWithOptionalGocButton(
  bot,
  chatId,
  text,
  {
    miniAppLink = "",
    browserLink = "",
    miniAppLabel = "Open GoC (Mini App)",
    browserLabel = "Open GoC (Browser)",
  } = {}
) {
  return sendTextWithOptionalGocButtonAdapter(bot, chatId, text, {
    miniAppLink,
    browserLink,
    miniAppLabel,
    browserLabel,
    isTelegramWebAppHttpsError,
  });
}



function formatRelativeAge(tsValue = "") {
  const ms = Date.parse(String(tsValue || ""));
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 10) return "방금 전";
  if (diffSec < 60) return `${diffSec}초 전`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}일 전`;
}

function normalizeActivitySnippet(value = "", max = 160) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter((line) => line && !/^#/.test(line) && !/^>/.test(line) && !/^```/.test(line) && !/^\*\*20\d{2}-/.test(line));
  if (lines.length === 0) return "";
  return clip(lines.slice(-4).join(" ").replace(/\s+/g, " "), max);
}

function readJsonlTail(filePath = "", limit = 12) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const rows = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .slice(-Math.max(1, limit));
    return rows.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeRuntimeEvent(event = null) {
  const row = event && typeof event === "object" ? event : {};
  const type = String(row.event_type || row.type || "").trim().toLowerCase();
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  if (type === 'run.start') {
    return normalizeTextSummary(payload.userText || payload.user_text || 'run 시작', 160) || 'run 시작';
  }
  if (type === 'run.queue_steps') {
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const labels = actions
      .map((action) => String(action?.display_label || action?.agent_id || action?.agentId || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const suffix = labels.length > 0 ? ` · ${labels.join(', ')}` : '';
    return `steps queued (${actions.length})${suffix}`;
  }
  if (type === 'run.finish') {
    const status = String(payload.status || 'done').trim();
    const error = normalizeTextSummary(payload.error || '', 100);
    return error ? `run finish · ${status} · ${error}` : `run finish · ${status}`;
  }
  if (type === 'run.agent_start') {
    const label = String(payload.agent_id || payload.role_id || 'agent').trim();
    return `${label} started`;
  }
  if (type === 'run.agent_finish') {
    const label = String(payload.agent_id || payload.role_id || 'agent').trim();
    const chars = Number(payload.output_chars || 0);
    return `${label} finished${chars > 0 ? ` · ${chars} chars` : ''}`;
  }
  if (type === 'run.agent_error') {
    const label = String(payload.agent_id || payload.role_id || 'agent').trim();
    const error = normalizeTextSummary(payload.error || '', 100);
    return error ? `${label} error · ${error}` : `${label} error`;
  }
  if (type === 'run.metadata') {
    return 'run metadata updated';
  }
  return normalizeTextSummary(type || 'runtime event', 120) || 'runtime event';
}

function collectRuntimeActivity({ jobId = '', session = null } = {}) {
  const items = [];
  const cleanJobId = String(jobId || '').trim();
  const pushItem = (entry = {}) => {
    const ts = String(entry.ts || '').trim();
    const summary = normalizeTextSummary(entry.summary || '', 180);
    if (!summary) return;
    items.push({
      ts,
      summary,
      kind: String(entry.kind || 'activity').trim(),
      label: String(entry.label || '').trim(),
    });
  };

  if (cleanJobId) {
    let jobDir = '';
    try {
      jobDir = jobs.jobDir(cleanJobId);
    } catch {
      jobDir = '';
    }
    if (jobDir) {
      const eventFile = path.join(jobDir, 'runtime_events.jsonl');
      const events = readJsonlTail(eventFile, 16);
      for (const row of events.slice().reverse()) {
        pushItem({
          ts: String(row?.ts || '').trim(),
          kind: 'event',
          label: String(row?.event_type || '').trim(),
          summary: summarizeRuntimeEvent(row),
        });
      }
      for (const docName of ['progress', 'decisions', 'artifacts']) {
        try {
          const resolvedName = tracking.resolveDocName(cleanJobId, docName);
          const filePath = path.join(jobDir, 'shared', resolvedName);
          if (!fs.existsSync(filePath)) continue;
          const stat = fs.statSync(filePath);
          const body = fs.readFileSync(filePath, 'utf8');
          const snippet = normalizeActivitySnippet(body, 180);
          if (!snippet) continue;
          pushItem({
            ts: new Date(stat.mtimeMs).toISOString(),
            kind: 'doc',
            label: resolvedName,
            summary: `${docName} 업데이트 · ${snippet}`,
          });
        } catch {}
      }
    }
  }

  const recentTurns = Array.isArray(session?.recent_agent_turns) ? session.recent_agent_turns : [];
  for (const row of recentTurns) {
    const agentLabel = String(row?.agent_name || row?.agent_id || '').trim();
    const summary = normalizeTextSummary(row?.output || row?.goal || '', 170);
    if (!agentLabel || !summary) continue;
    pushItem({
      ts: String(row?.ts || '').trim(),
      kind: 'agent_turn',
      label: agentLabel,
      summary: `${agentLabel}: ${summary}`,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of items.sort((a, b) => Date.parse(String(b.ts || '')) - Date.parse(String(a.ts || '')))) {
    const key = `${row.kind}|${row.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= 8) break;
  }
  const last = deduped[0] || null;
  return {
    last_activity_ts: last?.ts || '',
    last_activity_summary: last?.summary || '',
    items: deduped,
  };
}

function summarizeHeartbeat(activity = null, { isRunning = false } = {}) {
  const ts = String(activity?.last_activity_ts || '').trim();
  const summary = normalizeTextSummary(activity?.last_activity_summary || '', 120);
  if (!ts) return isRunning ? '활동 기록 없음' : 'idle';
  return `${formatRelativeAge(ts)}${summary ? ` · ${summary}` : ''}`;
}

function activityAgeSec(activity = null) {
  const ts = String(activity?.last_activity_ts || '').trim();
  if (!ts) return null;
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

function humanizeSessionPhase(session = {}, { isRunning = false } = {}) {
  const state = String(session?.state || '').trim().toLowerCase();
  if (session?.interrupt?.requested) return '중단 요청 반영 중';
  if (session?.pending_approval) return '승인 대기';
  if (session?.pending_install_proposal) return '설치 제안 대기';
  if (session?.pending_user_request) return '새 요청 반영 대기';
  if (isRunning) return '실행 중';
  if (!state || state === 'idle') return '대기 중';
  if (['queued', 'pending', 'starting'].includes(state)) return '준비 중';
  if (['running', 'working', 'executing', 'in_progress'].includes(state)) return '실행 중';
  if (['awaiting_approval', 'waiting_approval', 'approval_pending'].includes(state)) return '승인 대기';
  if (['awaiting_user', 'waiting_user', 'blocked'].includes(state)) return '사용자 응답 대기';
  if (['completed', 'complete', 'done', 'succeeded'].includes(state)) return '완료';
  if (['failed', 'error'].includes(state)) return '실패';
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(state)) return '중단됨';
  return state;
}

function deriveRunSituation(session = {}, { isRunning = false, activity = null, pendingApproval = null, pendingInstallProposal = null, interrupt = null, pendingUserRequest = null } = {}) {
  if (interrupt?.requested) return '사용자 요청을 반영하기 위해 현재 실행을 정리하고 있습니다.';
  if (pendingApproval) return '위험하거나 중요한 작업 승인을 기다리고 있습니다.';
  if (pendingInstallProposal) return '필요한 도구 또는 자격 증명 준비를 기다리고 있습니다.';
  if (pendingUserRequest) return '새 사용자 입력을 반영하기 위해 다음 계획을 다시 계산하고 있습니다.';
  if (isRunning) {
    const age = activityAgeSec(activity);
    if (Number.isFinite(age) && age >= 900) return '오래 걸리는 작업을 계속 진행 중입니다.';
    if (Number.isFinite(age) && age >= 300) return '작업을 계속 진행 중입니다.';
    return '요청한 작업을 실행 중입니다.';
  }
  const state = String(session?.state || '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'succeeded'].includes(state)) return '직전 실행이 끝났습니다.';
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(state)) return '현재 실행은 중단된 상태입니다.';
  if (['failed', 'error'].includes(state)) return '실패 원인을 확인한 뒤 다음 행동을 기다리고 있습니다.';
  return '새 요청을 기다리고 있습니다.';
}

function formatMemoryWriteEvent(row = null) {
  const event = row && typeof row === "object" ? row : {};
  const resolved = String(event.resolved_doc || '').trim();
  const requested = String(event.requested_doc || '').trim();
  const status = String(event.status || '').trim().toLowerCase();
  const role = String(event.role_id || event.provider || event.source || '').trim();
  const reason = normalizeTextSummary(event.reason || '', 90);
  const pathText = requested && resolved && requested !== resolved
    ? `${requested} → ${resolved}`
    : (resolved || requested || '(unknown)');
  const statusText = status ? ` · ${status}` : '';
  const reasonText = reason ? ` · ${reason}` : '';
  return `${role || 'writer'} · ${pathText}${statusText}${reasonText}`;
}

function summarizeActiveAgents(agentStatus = {}, agentIndex = new Map()) {
  const rows = Object.entries(agentStatus && typeof agentStatus === 'object' ? agentStatus : {})
    .map(([agentId, status]) => ({ agentId, ...(status && typeof status === 'object' ? status : {}) }))
    .filter((row) => ['running', 'queued'].includes(String(row.state || '').trim().toLowerCase()));
  if (rows.length === 0) return '';
  return rows.slice(0, 3).map((row) => {
    const label = formatAgentRef(row.agentId, agentIndex);
    const state = String(row.state || '').trim().toLowerCase();
    const startedAt = String(row.started_at || row.startedAt || '').trim();
    const age = startedAt ? ` ${formatRelativeAge(startedAt)}` : '';
    return `${label}(${state}${age ? ` · ${age}` : ''})`;
  }).join(', ');
}

function summarizeRoleOverlayProfiles(agentRows = [], { max = 3 } = {}) {
  const rows = Array.isArray(agentRows) ? agentRows : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const overlayMeta = resolveAgencyOverlayMeta(row);
    if (!overlayMeta.title) continue;
    const label = String(row?.display_label || row?.displayLabel || row?.name || row?.agent_name || row?.agentName || row?.agent_id || row?.agentId || row?.participant_id || row?.participantId || row?.slot_id || row?.slotId || '').trim() || 'Agent';
    const profile = formatRoleOverlayProfile(row?.role_id || row?.roleId || row?.role_label || row?.roleLabel || row?.role || '', row, { includeBaseLabel: true });
    const entry = `${label}(${profile})`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= Math.max(1, Number(max) || 3)) break;
  }
  return out;
}

function deriveQualityDeltaSummary({ recentProgress = '', criticSummary = '' } = {}) {
  const recent = normalizeTextSummary(recentProgress, 110);
  const critic = normalizeTextSummary(criticSummary, 110);
  if (!recent || !critic) return '';
  return `${recent} → ${critic}`;
}

function buildAgentDisplayIndex(registry = null, runtime = null) {
  return buildAgentDisplayIndexShared(registry, runtime);
}

function formatAgentRef(agentId, agentIndex = new Map()) {
  return formatChatAgentDisplayName(agentId, agentIndex);
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function summarizeAgentRuntimeRowsFromActions(actions = [], runtime = null, { limit = 8 } = {}) {
  const rows = [];
  const index = buildPreviewAgentDisplayIndex({ runtime, actions });
  const seen = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    const normalizedType = String(action?.type || '').trim().toLowerCase();
    const candidates = normalizedType === 'spawn_parallel' || normalizedType === 'spawn_agents'
      ? (Array.isArray(action?.agents) ? action.agents : [])
      : ([action]);
    for (const child of candidates) {
      const childType = String(child?.type || normalizedType).trim().toLowerCase();
      if (!['run_agent', 'agent_run', 'synthesize_final'].includes(childType)) continue;
      const inputs = child?.inputs && typeof child.inputs === 'object' ? child.inputs : {};
      const instanceId = String(inputs.runtime_instance_id || inputs.runtimeInstanceId || child?.agent_id || child?.agent || '').trim();
      const dedupeKey = instanceId || JSON.stringify([child?.agent, child?.goal, inputs.slot_id, inputs.role_id]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const label = String(
        inputs.display_label
        || inputs.displayLabel
        || resolveActionAgentNameHint(child)
        || formatChatAgentDisplayName(instanceId || child?.agent_id || child?.agent || '', index, { fallbackLabel: 'Agent' })
      ).trim() || 'Agent';
      const roleId = String(inputs.role_id || inputs.roleId || inputs.role_label || inputs.roleLabel || child?.agent || '').trim().toLowerCase();
      const roleText = roleId ? ` · ${roleLabel(roleId)}` : '';
      const skillIds = uniqStrings([
        ...(Array.isArray(inputs.attached_skill_ids) ? inputs.attached_skill_ids : []),
        ...(Array.isArray(inputs.attachedSkillIds) ? inputs.attachedSkillIds : []),
      ]).slice(0, 4);
      const goal = clip(String(child?.goal || child?.prompt || child?.task || '').trim(), 120);
      const parts = [`${label}${roleText}`];
      const overlayProfile = formatRoleOverlayProfile(roleId, inputs, { includeBaseLabel: true });
      const overlayMeta = resolveAgencyOverlayMeta(inputs);
      const skillLabels = formatSkillLabels(skillIds, { max: 3 });
      if (overlayMeta.title) parts.push(`profile=${overlayProfile}`);
      const modelLabel = humanizeModel(String(inputs.provider || '').trim(), String(inputs.model || '').trim());
      if (skillLabels.length > 0) parts.push(`skills=${skillLabels.join(', ')}`);
      if (modelLabel && modelLabel !== '(미지정)') parts.push(`model=${modelLabel}`);
      if (goal) parts.push(`goal=${goal}`);
      rows.push(parts.join(' · '));
      if (rows.length >= Math.max(1, Number(limit) || 8)) return rows;
    }
  }
  return rows;
}

function summarizeAgentRoster(runtime = null, { actions = [], limit = 8 } = {}) {
  const snapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === 'object'
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === 'object' ? runtime.runtime_team_snapshot : null);
  const rows = Array.isArray(snapshot?.runtime_agents) ? snapshot.runtime_agents : [];
  if (rows.length > 0) return rows;
  const actionRows = summarizeAgentRuntimeRowsFromActions(actions, runtime, { limit });
  return actionRows.map((summary, index) => ({
    display_label: summary,
    role_label: '',
    attached_skill_ids: [],
    __summary_only: true,
    instance_id: `planned_${index}`
  }));
}

function formatRosterRow(row = {}) {
  if (row?.__summary_only) return String(row.display_label || '').trim();
  const roleId = String(row?.role_id || row?.roleId || row?.role_label || row?.roleLabel || '').trim().toLowerCase();
  const label = String(row?.display_label || row?.displayLabel || formatChatAgentDisplayName(row?.instance_id || row?.agent_id || roleId || '', new Map(), { fallbackLabel: 'Agent' })).trim() || 'Agent';
  const skillIds = uniqStrings([
    ...(Array.isArray(row?.attached_skill_ids) ? row.attached_skill_ids : []),
    ...(Array.isArray(row?.attachedSkillIds) ? row.attachedSkillIds : []),
    ...(Array.isArray(row?.attached_skills) ? row.attached_skills.map((entry) => entry?.skill_id || entry?.id || entry) : []),
    ...(Array.isArray(row?.attachedSkills) ? row.attachedSkills.map((entry) => entry?.skill_id || entry?.id || entry) : []),
  ]).slice(0, 5);
  const personality = String(row?.personality_profile?.stance || row?.personalityProfile?.stance || '').trim();
  const parts = [label];
  if (roleId) parts.push(roleLabel(roleId));
  const overlayProfile = formatRoleOverlayProfile(roleId, row, { includeBaseLabel: true });
  const overlayMeta = resolveAgencyOverlayMeta(row);
  const skillLabels = formatSkillLabels(skillIds, { max: 3 });
  if (overlayMeta.title) parts.push(`profile=${overlayProfile}`);
  const modelLabel = humanizeModel(String(row?.provider || '').trim(), String(row?.model || '').trim());
  if (modelLabel && modelLabel !== '(미지정)') parts.push(`model=${modelLabel}`);
  if (skillLabels.length > 0) parts.push(`skills=${skillLabels.join(', ')}`);
  if (personality) parts.push(`tone=${personality}`);
  return parts.join(' · ');
}

function formatRosterRowVerbose(row = {}) {
  if (row?.__summary_only) return `  • ${String(row.display_label || '').trim()}`;
  const line = formatRosterRow(row);
  return `  • ${line.replace(/ · /g, '\n    ')}`;
}

function skillListFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.skills)) return response.skills;
  if (Array.isArray(response?.rows)) return response.rows;
  return [];
}

function formatSkillCatalogRows(rows = [], { query = '', limit = 40 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const filtered = q
    ? rows.filter((row) => [
        row?.id,
        row?.skill_id,
        row?.name,
        row?.title,
        row?.description,
        ...(Array.isArray(row?.tags) ? row.tags : []),
        ...(Array.isArray(row?.capability_tags) ? row.capability_tags : []),
      ].some((v) => String(v || '').toLowerCase().includes(q)))
    : rows;
  const lines = ['Skill catalog', `- count: ${filtered.length}${q ? ` (filter: ${q})` : ''}`];
  for (const row of filtered.slice(0, limit)) {
    const id = String(row?.id || row?.skill_id || row?.skillId || '').trim();
    const name = String(row?.name || row?.title || id || 'skill').trim();
    const sideEffect = String(row?.side_effect_level || row?.sideEffectLevel || row?.side_effect || '').trim();
    const trust = String(row?.trust_level || row?.trustLevel || '').trim();
    const desc = String(row?.description || row?.summary || '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${name}${id ? ` [${id}]` : ''}${sideEffect ? ` · side_effect=${sideEffect}` : ''}${trust ? ` · trust=${trust}` : ''}`);
    if (desc) lines.push(`  ${clip(desc, 260)}`);
  }
  if (filtered.length === 0) lines.push('- (none)');
  lines.push('', '명령:', '/skills catalog [검색어]', '/skills show <skill_id>', '/skills install <skill_id>', '/skills propose <원하는 skill 설명>');
  return lines.join('\n');
}

function formatSkillDetail(pkg = {}) {
  const row = pkg?.package && typeof pkg.package === 'object' ? pkg.package : (pkg?.item && typeof pkg.item === 'object' ? pkg.item : pkg);
  const id = String(row?.id || row?.skill_id || row?.skillId || '').trim();
  const name = String(row?.name || row?.title || id || 'skill').trim();
  const desc = String(row?.description || row?.summary || '').trim();
  const requirements = Array.isArray(row?.credential_requirements || row?.credentialRequirements) ? (row?.credential_requirements || row?.credentialRequirements) : [];
  const adapters = row?.execution_adapter || row?.executionAdapter || row?.adapter || {};
  return [
    `Skill: ${name}`,
    id ? `id=${id}` : '',
    desc ? `description=${clip(desc, 1200)}` : '',
    `side_effect=${String(row?.side_effect_level || row?.sideEffectLevel || 'unknown')}`,
    `trust=${String(row?.trust_level || row?.trustLevel || 'unknown')}`,
    requirements.length ? `credentials=${requirements.map((r) => String(r?.id || r?.key || r?.name || r)).join(', ')}` : 'credentials=(none declared)',
    Object.keys(adapters || {}).length ? `adapter=${JSON.stringify(adapters).slice(0, 900)}` : '',
  ].filter(Boolean).join('\n');
}


export function formatMemorySummary() {
  const s = memory.getSummary();
  const role = memory.getAgentRoleSummary();
  return [
    "🧠 현재 메모리 기반 설정",
    `memory.mode=${MEMORY_MODE}`,
    `memory.effective=${memoryModeWithFallback()}`,
    ...(gocInitError ? [`memory.goc_error=${gocInitError}`] : []),
    `memory.file=${s.filePath}`,
    "",
    "Auto-Suggest Reflection Prompt (preview):",
    s.policyPreview || "(empty)",
    "",
    "Agent Routing Prompt (preview):",
    s.routerPreview || "(empty)",
    "",
    "Default Agent Roles (preview):",
    `[Gemini]\n${role.geminiPreview}`,
    "",
    `[Codex]\n${role.codexPreview}`,
    "",
    `[ChatGPT]\n${role.chatgptPreview}`,
    "",
    `operator_notes=${s.noteCount}`,
    `recent_lessons=${s.lessonCount}`,
    "",
    "명령:",
    "/memory show",
    "/memory md",
    "/memory kb",
    "/memory policy <자연어 프롬프트>",
    "/memory routing <자연어 프롬프트>",
    "/memory role <gemini|codex|chatgpt> <자연어 역할>",
    "/memory agents",
    "/memory note <메모>",
    "/memory lesson <교훈>",
    "/memory reset",
    "",
    "호환 alias:",
    "/settings ...  (=/memory ...)",
  ].join("\n");
}

export function formatRunningJobs(chatId) {
  const chatKey = String(chatId);
  const active = activeJobByChat.get(chatKey) || "";
  const awaitingJob = getAwait(chatId)?.jobId || "";
  const lastChatJob = lastChatJobByChat.get(chatKey) || "";
  const running = Array.from(jobAbortControllers.keys());
  const queued = queue
    .map((item) => String(item?.jobId || "").trim())
    .filter(Boolean);
  const dedup = (list) => Array.from(new Set(list.filter(Boolean)));

  const lines = [
    "🏃 Running jobs",
    `chat_active=${active || "(none)"}`,
    `chat_gptawait=${awaitingJob || "(none)"}`,
    `chat_last=${lastChatJob || "(none)"}`,
    `running_count=${running.length}`,
    ...dedup(running).map((id) => `- running: ${id}`),
    `queue_count=${queued.length}`,
    ...dedup(queued).map((id) => `- queued: ${id}`),
    "",
    "중단: /stop <jobId>",
  ];
  return lines.join("\n");
}

function listPendingManualApprovals(jobId) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  let approvalsDir = "";
  try {
    approvalsDir = path.join(jobs.jobDir(cleanJobId), "approvals");
  } catch {
    return [];
  }
  if (!approvalsDir || !fs.existsSync(approvalsDir)) return [];
  const files = fs.readdirSync(approvalsDir, { withFileTypes: true })
    .filter((row) => row.isFile() && row.name.endsWith(".json"))
    .map((row) => row.name)
    .slice(0, 40);
  const pending = [];
  for (const name of files) {
    try {
      const filePath = path.join(approvalsDir, name);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (String(parsed?.status || "").trim().toLowerCase() !== "pending") continue;
      pending.push({
        token: String(parsed?.token || "").trim(),
        purpose: String(parsed?.purpose || "").trim(),
        summary: String(parsed?.summary || "").trim(),
      });
    } catch {}
  }
  return pending.slice(0, 5);
}

function normalizeTextSummary(value = "", max = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return clip(text, max);
}

function inferTeamArchetype(activeTeam = null, runtimeTeamSnapshot = null) {
  const team = activeTeam && typeof activeTeam === "object" ? activeTeam : {};
  const snapshot = runtimeTeamSnapshot && typeof runtimeTeamSnapshot === "object" ? runtimeTeamSnapshot : {};
  return String(
    team.task_archetype
    || team.archetype
    || team.archetype_id
    || snapshot.task_archetype
    || snapshot.archetype
    || snapshot.archetype_id
    || ""
  ).trim();
}

function findRecentProgressSummary(session = null) {
  const recentTurns = Array.isArray(session?.recent_agent_turns) ? session.recent_agent_turns : [];
  for (const row of recentTurns) {
    const label = String(row?.agent_name || row?.agent_id || "").trim();
    const summary = normalizeTextSummary(row?.output || row?.goal || "", 160);
    if (label && summary) return `${label}: ${summary}`;
  }
  const capsules = Array.isArray(session?.answer_capsules) ? session.answer_capsules : [];
  for (const row of capsules) {
    const summary = normalizeTextSummary(row?.answer_summary || row?.answer_excerpt || "", 160);
    if (summary) return summary;
  }
  return "";
}

function findCriticSummary(session = null) {
  const recentTurns = Array.isArray(session?.recent_agent_turns) ? session.recent_agent_turns : [];
  for (const row of recentTurns) {
    const role = String(row?.role || "").trim().toLowerCase();
    const agentId = String(row?.agent_id || "").trim().toLowerCase();
    const agentName = String(row?.agent_name || "").trim().toLowerCase();
    if (![role, agentId, agentName].some((value) => /critic|review|reviewer|qa|audit|검토/.test(value))) continue;
    const summary = normalizeTextSummary(row?.output || row?.goal || "", 150);
    if (summary) return summary;
  }
  return "";
}

function deriveNextHumanAction({ session = null, pendingApproval = null, pendingInstallProposal = null, pendingUserRequest = null, activeJobId = "", artifactCount = 0 } = {}) {
  if (pendingApproval) return `승인 필요 · ${normalizeTextSummary(pendingApproval.reason || 'approval required', 100)}`;
  if (pendingInstallProposal) return `install 검토 필요 · gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)}`;
  if (pendingUserRequest?.followup_hint || pendingUserRequest?.reason || pendingUserRequest?.prompt) {
    const prefix = pendingUserRequest?.request_kind ? `${pendingUserRequest.request_kind}: ` : '';
    return normalizeTextSummary(`${prefix}${pendingUserRequest.followup_hint || pendingUserRequest.reason || pendingUserRequest.prompt}`, 120);
  }
  if (session?.state === 'awaiting_user' || session?.last_route?.await_user === true) {
    return normalizeTextSummary(session?.last_route?.followup_hint || '추가 입력 필요', 120);
  }
  if (activeJobId) return '진행 중 · /status full 또는 더 보기';
  if (artifactCount > 0) return '산출물 확인 · /artifacts 또는 버튼';
  return '대기 중';
}


function formatSignedPct(value = 0) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0%';
  return `${num > 0 ? '+' : ''}${num}%`;
}

function summarizePromptComponents(rows = []) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const component of Array.isArray(row?.components) ? row.components : []) {
      const key = String(component?.key || '').trim();
      if (!key) continue;
      totals.set(key, (totals.get(key) || 0) + Number(component?.tokens || 0));
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, tokens]) => ({ key, avg_tokens: Math.round(tokens / Math.max(1, Array.isArray(rows) ? rows.length : 1)) }));
}

function summarizePromptSurfaces(rows = []) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.surface_id || row?.kind || row?.provider || '').trim();
    if (!key) continue;
    totals.set(key, (totals.get(key) || 0) + Number(row?.actual_prompt_tokens || 0));
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, tokens]) => ({ key, avg_tokens: Math.round(tokens / Math.max(1, Array.isArray(rows) ? rows.length : 1)) }));
}

function deriveOverlayPromptMemo(overlayStats = null, averages = null) {
  if (!overlayStats || !overlayStats.overlay_prompt_count) return 'overlay 없음 · 기본 role memo만 사용 중';
  const avgOverlayTokens = Number(overlayStats.avg_overlay_tokens || 0);
  const avgSharePct = Number(overlayStats.avg_overlay_share_pct || 0);
  const deltaVsPlain = Number(overlayStats.delta_vs_plain_prompt_tokens || 0);
  const savingsVsFull = Number(averages?.savings_vs_conversation_pct || 0);
  if (avgSharePct <= 8 && savingsVsFull >= 85) return `overlay 비용이 작음 · 평균 +${avgOverlayTokens} tok`;
  if (avgSharePct <= 15 && deltaVsPlain <= 120) return `overlay 유지 가능 · 평균 +${avgOverlayTokens} tok`;
  if (avgSharePct > 20 || deltaVsPlain > 180) return 'overlay가 무거움 · mission/rule bullet 압축 권장';
  return `overlay 비용 보통 · 평균 +${avgOverlayTokens} tok`;
}

function collectPromptTelemetry(jobId = '') {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return { rows: [], averages: null, overlay: null };
  let jobDir = '';
  try {
    jobDir = jobs.jobDir(cleanJobId);
  } catch {
    jobDir = '';
  }
  const rows = readJsonlTail(jobDir ? path.join(jobDir, 'prompt_metrics.jsonl') : '', 24)
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => Date.parse(String(b.ts || '')) - Date.parse(String(a.ts || '')));
  if (rows.length === 0) return { rows: [], averages: null, overlay: null };
  const recent = rows.slice(0, 5);
  const avgActual = Math.round(recent.reduce((sum, row) => sum + Number(row?.actual_prompt_tokens || 0), 0) / recent.length);
  const avgConversation = Math.round(recent.reduce((sum, row) => sum + Number(row?.baseline?.conversation_only_tokens || 0), 0) / recent.length);
  const avgShared = Math.round(recent.reduce((sum, row) => sum + Number(row?.baseline?.conversation_plus_shared_tokens || 0), 0) / recent.length);
  const overlayRows = recent.filter((row) => Number(row?.overlay?.tokens || 0) > 0 || String(row?.overlay?.overlay_id || row?.metadata?.agency_overlay_id || '').trim());
  const plainRows = recent.filter((row) => !overlayRows.includes(row));
  const avgOverlayTokens = overlayRows.length > 0 ? Math.round(overlayRows.reduce((sum, row) => sum + Number(row?.overlay?.tokens || 0), 0) / overlayRows.length) : 0;
  const avgOverlaySharePct = overlayRows.length > 0 ? Math.round((overlayRows.reduce((sum, row) => sum + Number(row?.overlay?.share_pct || 0), 0) / overlayRows.length) * 10) / 10 : 0;
  const avgPromptWithOverlay = overlayRows.length > 0 ? Math.round(overlayRows.reduce((sum, row) => sum + Number(row?.actual_prompt_tokens || 0), 0) / overlayRows.length) : 0;
  const avgPromptWithoutOverlay = plainRows.length > 0 ? Math.round(plainRows.reduce((sum, row) => sum + Number(row?.actual_prompt_tokens || 0), 0) / plainRows.length) : 0;
  const deltaVsPlain = overlayRows.length > 0 && plainRows.length > 0 ? Math.max(0, avgPromptWithOverlay - avgPromptWithoutOverlay) : avgOverlayTokens;
  const averages = {
    actual_prompt_tokens: avgActual,
    conversation_only_tokens: avgConversation,
    conversation_plus_shared_tokens: avgShared,
    savings_vs_conversation_pct: avgConversation > 0 ? Math.round((1 - (avgActual / avgConversation)) * 1000) / 10 : 0,
    savings_vs_shared_pct: avgShared > 0 ? Math.round((1 - (avgActual / avgShared)) * 1000) / 10 : 0,
  };
  const topComponents = summarizePromptComponents(recent);
  const topSurfaces = summarizePromptSurfaces(recent);
  const overlay = overlayRows.length > 0 ? {
    overlay_prompt_count: overlayRows.length,
    avg_overlay_tokens: avgOverlayTokens,
    avg_overlay_share_pct: avgOverlaySharePct,
    avg_prompt_tokens_with_overlay: avgPromptWithOverlay || undefined,
    avg_prompt_tokens_without_overlay: avgPromptWithoutOverlay || undefined,
    delta_vs_plain_prompt_tokens: deltaVsPlain,
    titles: Array.from(new Set(overlayRows.map((row) => String(row?.overlay?.overlay_title || row?.metadata?.agency_overlay_title || row?.overlay?.overlay_id || '').trim()).filter(Boolean))).slice(0, 3),
    memo: deriveOverlayPromptMemo({
      overlay_prompt_count: overlayRows.length,
      avg_overlay_tokens: avgOverlayTokens,
      avg_overlay_share_pct: avgOverlaySharePct,
      delta_vs_plain_prompt_tokens: deltaVsPlain,
    }, averages),
  } : null;
  return { rows: recent, averages, overlay, top_components: topComponents, top_surfaces: topSurfaces };
}


function formatPromptTelemetryRow(row = {}) {
  const provider = String(row?.provider || 'agent').trim();
  const model = String(row?.model || '').trim();
  const actor = String(row?.agent_id || row?.role_id || provider || 'agent').trim();
  const surface = String(row?.surface_label || row?.surface_id || row?.kind || '').trim();
  const actual = Number(row?.actual_prompt_tokens || 0);
  const baseline = Number(row?.baseline?.conversation_plus_shared_tokens || row?.baseline?.conversation_only_tokens || 0);
  const savedPct = baseline > 0 ? Math.round((1 - (actual / baseline)) * 1000) / 10 : 0;
  const suffix = model ? `/${model}` : '';
  const overlayTokens = Number(row?.overlay?.tokens || 0);
  const overlayTitle = String(row?.overlay?.overlay_title || row?.metadata?.agency_overlay_title || '').trim();
  const overlaySuffix = overlayTokens > 0 ? ` · +overlay ${overlayTokens} tok${overlayTitle ? ` (${overlayTitle})` : ''}` : '';
  return `${surface ? `[${surface}] ` : ''}${actor} · ${provider}${suffix} · ${actual} tok${overlaySuffix}${baseline > 0 ? ` · ${formatSignedPct(savedPct)} vs conv+shared` : ''}`;
}


function buildChatStatusKeyboard({ detail = 'compact', artifactCount = 0, showRecent = false, showPrompt = false } = {}) {
  const normalizedDetail = String(detail || '').trim().toLowerCase();
  const isFull = normalizedDetail === 'full';
  const isRecent = normalizedDetail === 'recent';
  const primary = [];
  primary.push({ text: isFull ? '요약 보기' : '더 보기', callback_data: isFull ? 'chat_status:summary' : 'chat_status:full' });
  if (showRecent) primary.push({ text: '최근 작업', callback_data: 'chat_status:recent' });
  if (showPrompt) primary.push({ text: 'Prompt', callback_data: 'chat_status:prompt' });
  if (artifactCount > 0) primary.push({ text: '산출물', callback_data: 'chat_status:artifacts' });
  if (isRecent && primary.length > 0) primary[0] = { text: '요약 보기', callback_data: 'chat_status:summary' };
  return primary.length > 0 ? { inline_keyboard: [primary] } : null;
}

export function buildChatStatusCard(chatId, runtime = null, { detail = "compact" } = {}) {
  const chatKey = String(chatId || "");
  const session = chatSessionStore.get(chatId) || {};
  const activeJobId = activeJobByChat.get(chatKey) || "";
  const currentJobId = String(
    session.jobId
    || activeJobId
    || resolveCurrentJobIdForChat(chatId)
    || ""
  ).trim();
  const queueItems = queue.filter((item) => String(item?.jobId || "").trim() === currentJobId);
  const activeController = currentJobId ? jobAbortControllers.get(currentJobId) : null;
  const interrupt = session.interrupt && typeof session.interrupt === "object" ? session.interrupt : null;
  const pendingApproval = session.pending_approval && typeof session.pending_approval === "object"
    ? session.pending_approval
    : null;
  const pendingInstallProposal = session.pending_install_proposal && typeof session.pending_install_proposal === 'object'
    ? session.pending_install_proposal
    : null;
  const pendingUserRequest = session.pending_user_request && typeof session.pending_user_request === 'object'
    ? session.pending_user_request
    : null;
  const lastInstallProposal = session.last_install_proposal && typeof session.last_install_proposal === 'object'
    ? session.last_install_proposal
    : null;
  const credentialBindingState = session.credential_binding_state && typeof session.credential_binding_state === 'object'
    ? session.credential_binding_state
    : null;
  const patternConflict = session.pattern_conflict && typeof session.pattern_conflict === 'object'
    ? session.pattern_conflict
    : null;
  const temporaryExecutionOverride = session.temporary_execution_override && typeof session.temporary_execution_override === 'object'
    ? session.temporary_execution_override
    : null;
  const patternRecovery = session.pattern_recovery && typeof session.pattern_recovery === 'object'
    ? session.pattern_recovery
    : null;
  const pendingApprovalActionLabel = pendingApproval?.action
    ? (String(pendingApproval?.action_display_label || "").trim() || chatActionLabel(pendingApproval.action))
    : "";
  const lastRoute = session.last_route && typeof session.last_route === "object"
    ? session.last_route
    : null;
  const manualApprovals = listPendingManualApprovals(currentJobId);
  const teamConfig = session.team_config && typeof session.team_config === 'object' ? session.team_config : null;
  const activeTeam = teamConfig?.active_team && typeof teamConfig.active_team === 'object' ? teamConfig.active_team : null;
  const enabledAgents = runtime?.agentSelection?.enabled_ids || runtime?.enabledAgentIds || [];
  const enabledTools = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];
  const runtimeAuthority = buildRunAuthority(runtime);
  const agentIndex = buildAgentDisplayIndex(agentRegistry, runtime);
  const runtimeTeamSnapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === "object"
      ? runtime.runtime_team_snapshot
      : null);

  const artifactIndex = currentJobId ? loadArtifactIndex(currentJobId) : null;
  const artifactCount = Array.isArray(artifactIndex?.artifacts) ? artifactIndex.artifacts.length : 0;
  const teamArchetype = inferTeamArchetype(activeTeam, runtimeTeamSnapshot);
  const overlayProfileRows = summarizeRoleOverlayProfiles(
    Array.isArray(runtimeTeamSnapshot?.runtime_agents) && runtimeTeamSnapshot.runtime_agents.length > 0
      ? runtimeTeamSnapshot.runtime_agents
      : (Array.isArray(activeTeam?.agents) ? activeTeam.agents : []),
    { max: 3 }
  );
  const runtimeActivity = collectRuntimeActivity({ jobId: currentJobId, session });
  const recentProgress = findRecentProgressSummary(session) || runtimeActivity.last_activity_summary || '';
  const criticSummary = findCriticSummary(session);
  const qualityDelta = deriveQualityDeltaSummary({ recentProgress, criticSummary });
  const nextHumanAction = deriveNextHumanAction({
    session,
    pendingApproval,
    pendingInstallProposal,
    pendingUserRequest,
    activeJobId,
    artifactCount,
  });
  const iterationLabel = Number.isFinite(Number(lastRoute?.turn)) ? String(lastRoute.turn) : '';
  const heartbeatLabel = summarizeHeartbeat(runtimeActivity, { isRunning: !!activeJobId });
  const activeAgentsLabel = summarizeActiveAgents(session?.agent_status, agentIndex);
  const normalizedDetail = String(detail || '').trim().toLowerCase();
  const promptTelemetry = collectPromptTelemetry(currentJobId);
  const memoryWriteEvents = currentJobId ? tracking.readRecentWriteEvents(currentJobId, 6).slice().reverse() : [];
  const executionFeedbackSummary = lastRoute?.execution_feedback && typeof lastRoute.execution_feedback === 'object'
    ? lastRoute.execution_feedback
    : (() => {
      let jobDir = '';
      try { jobDir = currentJobId ? jobs.jobDir(currentJobId) : ''; } catch { jobDir = ''; }
      return loadExecutionFeedbackSummary(jobDir) || null;
    })();
  const executionInsights = lastRoute?.execution_insights && typeof lastRoute.execution_insights === 'object'
    ? lastRoute.execution_insights
    : buildExecutionInsightSnapshot({
      runtimeTeamSnapshot,
      actions: session?.last_route?.actions || [],
      outputs: [],
      recentTurns: session?.recent_agent_turns || [],
      currentJobId,
    });
  const phaseLabel = humanizeSessionPhase(session, { isRunning: !!activeJobId });
  const routeContractSummary = resolveRoutingContractSummary({ activeTeam, runtimeTeamSnapshot });
  const routeReadinessLabel = formatRouteReadiness(routeContractSummary, { compact: true });
  const situationLabel = deriveRunSituation(session, {
    isRunning: !!activeJobId,
    activity: runtimeActivity,
    pendingApproval,
    pendingInstallProposal,
    interrupt,
    pendingUserRequest,
  });
  if (normalizedDetail === 'prompt') {
    const lines = [
      '🧮 Prompt 상태',
      `- phase: ${phaseLabel}`,
      `- situation: ${situationLabel}`,
      `- heartbeat: ${heartbeatLabel}`,
    ];
    if (promptTelemetry.averages) {
      lines.push(`- avg_prompt_tokens: ${promptTelemetry.averages.actual_prompt_tokens}`);
      lines.push(`- baseline(conversation_only): ${promptTelemetry.averages.conversation_only_tokens}`);
      lines.push(`- baseline(conversation+shared_docs): ${promptTelemetry.averages.conversation_plus_shared_tokens}`);
      lines.push(`- delta_vs_conversation_only: ${formatSignedPct(promptTelemetry.averages.savings_vs_conversation_pct)}`);
      lines.push(`- delta_vs_conversation+shared: ${formatSignedPct(promptTelemetry.averages.savings_vs_shared_pct)}`);
      if (Array.isArray(promptTelemetry.top_surfaces) && promptTelemetry.top_surfaces.length > 0) {
        lines.push(`- prompt_surfaces: ${promptTelemetry.top_surfaces.map((row) => `${row.key}~${row.avg_tokens} tok`).join(', ')}`);
      }
      if (Array.isArray(promptTelemetry.top_components) && promptTelemetry.top_components.length > 0) {
        lines.push(`- biggest_components: ${promptTelemetry.top_components.map((row) => `${row.key}~${row.avg_tokens} tok`).join(', ')}`);
      }
      if (promptTelemetry.overlay) {
        lines.push(`- overlay_prompts: ${promptTelemetry.overlay.overlay_prompt_count}/${promptTelemetry.rows.length}`);
        lines.push(`- overlay_overhead_avg: +${promptTelemetry.overlay.avg_overlay_tokens} tok (${promptTelemetry.overlay.avg_overlay_share_pct}%)`);
        if (Number.isFinite(Number(promptTelemetry.overlay.avg_prompt_tokens_without_overlay))) {
          lines.push(`- overlay_vs_plain: +${promptTelemetry.overlay.delta_vs_plain_prompt_tokens} tok vs prompts without overlay`);
        }
        if (Array.isArray(promptTelemetry.overlay.titles) && promptTelemetry.overlay.titles.length > 0) {
          lines.push(`- overlay_titles: ${promptTelemetry.overlay.titles.join(', ')}`);
        }
        lines.push(`- overlay_memo: ${promptTelemetry.overlay.memo}`);
      }
      if (executionFeedbackSummary && Array.isArray(executionFeedbackSummary.patterns) && executionFeedbackSummary.patterns.length > 0) {
        const topPattern = executionFeedbackSummary.patterns[0];
        lines.push(`- pattern_feedback: ${topPattern.execution_pattern} · ${topPattern.run_count} runs · avg participation ${topPattern.avg_participation_pct}%`);
      }
      if (executionFeedbackSummary && Array.isArray(executionFeedbackSummary.overlays) && executionFeedbackSummary.overlays.length > 0) {
        lines.push(`- overlay_feedback: ${executionFeedbackSummary.overlays.slice(0, 3).map((row) => `${row.title || row.overlay_id}~${row.avg_overlay_tokens} tok/${row.avg_participation_pct}%`).join(', ')}`);
      }
    } else {
      lines.push('- prompt_metrics: (none yet)');
    }
    if (promptTelemetry.rows.length > 0) {
      lines.push('- recent_prompts:');
      for (const row of promptTelemetry.rows.slice(0, 5)) {
        lines.push(`  • ${formatRelativeAge(row.ts)} · ${formatPromptTelemetryRow(row)}`);
      }
    }
    return {
      text: lines.join("\n"),
      reply_markup: buildChatStatusKeyboard({ detail: 'prompt', artifactCount, showRecent: runtimeActivity.items.length > 0, showPrompt: promptTelemetry.rows.length > 0 }),
      status: {
        chat_id: chatKey,
        state: session.state || 'idle',
        phase_label: phaseLabel,
        situation_label: situationLabel,
        job_id: currentJobId || null,
        prompt_rows: promptTelemetry.rows.length,
      },
    };
  }
  if (normalizedDetail === 'recent') {
    const recentLines = [
      '🕒 최근 작업',
      `- phase: ${phaseLabel}`,
      `- situation: ${situationLabel}`,
      `- heartbeat: ${heartbeatLabel}`,
      routeReadinessLabel ? `- route_ready: ${routeReadinessLabel}` : '',
      activeAgentsLabel ? `- active: ${activeAgentsLabel}` : '',
      runtimeActivity.items.length > 0 ? '- recent_work:' : '- recent_work: (none)',
      ...runtimeActivity.items.slice(0, 6).map((row) => `  • ${formatRelativeAge(row.ts)} · ${row.summary}`),
      memoryWriteEvents.length > 0 ? `- recent_memory_writes: ${memoryWriteEvents.length}` : '',
      `- next: ${nextHumanAction}`,
    ].filter(Boolean);
    return {
      text: recentLines.join("\n"),
      reply_markup: buildChatStatusKeyboard({ detail: 'recent', artifactCount, showRecent: runtimeActivity.items.length > 0, showPrompt: promptTelemetry.rows.length > 0 }),
      status: {
        chat_id: chatKey,
        state: session.state || 'idle',
        phase_label: phaseLabel,
        situation_label: situationLabel,
        job_id: currentJobId || null,
        active_run_id: session.active_run_id || null,
        running: !!activeJobId,
        last_activity_ts: runtimeActivity.last_activity_ts || null,
        last_activity_summary: runtimeActivity.last_activity_summary || null,
      },
    };
  }
  if (normalizedDetail !== 'full') {
    const compactLines = [
      '📋 현재 상태',
      `- phase: ${phaseLabel}`,
      `- situation: ${situationLabel}`,
      `- team: ${String(activeTeam?.team_name || 'configured_team').trim() || '(none)'}${teamArchetype ? ` · ${teamArchetype}` : ''}`,
      overlayProfileRows.length > 0 ? `- role_profiles: ${overlayProfileRows.join(', ')}` : '',
      iterationLabel ? `- iteration: ${iterationLabel}` : '',
      `- heartbeat: ${heartbeatLabel}`,
      routeReadinessLabel ? `- route_ready: ${routeReadinessLabel}` : '',
      activeAgentsLabel ? `- active: ${activeAgentsLabel}` : '',
      recentProgress ? `- recent: ${recentProgress}` : '',
      criticSummary ? `- critic: ${criticSummary}` : '',
      qualityDelta ? `- delta: ${qualityDelta}` : '',
      `- next: ${nextHumanAction}`,
      `- artifacts: ${artifactCount}`,
    ].filter(Boolean);
    return {
      text: compactLines.join("\n"),
      reply_markup: buildChatStatusKeyboard({ detail: 'compact', artifactCount, showRecent: runtimeActivity.items.length > 0, showPrompt: promptTelemetry.rows.length > 0 }),
      status: {
        chat_id: chatKey,
        state: session.state || 'idle',
        phase_label: phaseLabel,
        situation_label: situationLabel,
        job_id: currentJobId || null,
        active_run_id: session.active_run_id || null,
        running: !!activeJobId,
        queue_for_job: queueItems.length,
        pending_interrupt: interrupt,
        pending_approval: pendingApproval,
        pending_user_messages: Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0,
        enabled_agents: Array.isArray(enabledAgents) ? enabledAgents : [],
        enabled_tools: Array.isArray(enabledTools) ? enabledTools : [],
        ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
      },
    };
  }

  const lines = [
    "📋 현재 상태",
    `- state: ${session.state || "idle"}`,
    `- phase: ${phaseLabel}`,
    `- situation: ${situationLabel}`,
    `- job_id: ${currentJobId || "(none)"}`,
    `- active_run_id: ${session.active_run_id || "(none)"}`,
    `- running: ${activeJobId ? "yes" : "no"}`,
    `- queue_for_job: ${queueItems.length}`,
    `- abort_signal: ${activeController ? (activeController.signal.aborted ? "aborted" : "active") : "none"}`,
    `- pending_interrupt: ${interrupt?.requested ? `${interrupt.mode}${interrupt.reason ? ` (${clip(interrupt.reason, 90)})` : ""}` : "none"}`,
    `- pending_approval: ${pendingApproval ? (pendingApproval.reason || "yes") : "none"}`,
    `- pending_user_request: ${pendingUserRequest ? (pendingUserRequest.reason || pendingUserRequest.followup_hint || 'yes') : 'none'}`,
    pendingApprovalActionLabel ? `- pending_approval_action: ${pendingApprovalActionLabel}` : "",
    `- pending_install_proposal: ${pendingInstallProposal ? `${String(pendingInstallProposal.status || 'awaiting_install_approval')} (gaps=${Number(pendingInstallProposal?.proposal?.gap_count || 0)})` : 'none'}`,
    (!pendingInstallProposal && lastInstallProposal) ? `- last_install_proposal: ${String(lastInstallProposal.status || 'done')}` : '',
    credentialBindingState ? `- bound_credentials: ${Number(credentialBindingState?.summary?.bound_count || 0)}` : '',
    patternConflict ? `- pattern_conflict: ${String(patternConflict.classification || 'detected')}${patternConflict.current_pattern ? ` (${patternConflict.current_pattern})` : ''}` : '',
    temporaryExecutionOverride ? `- temporary_execution_override: ${String(temporaryExecutionOverride.mode || 'active')}${temporaryExecutionOverride.effective_pattern ? ` -> ${temporaryExecutionOverride.effective_pattern}` : ''}` : '',
    patternRecovery ? `- pattern_recovery: ${String(patternRecovery.status || 'pending')}${patternRecovery.active_pattern ? ` (${patternRecovery.active_pattern})` : ''}` : '',
    lastRoute
      ? `- last_route: ${String(lastRoute.reason || "(none)")}, actions=${Array.isArray(lastRoute.actions) ? lastRoute.actions.length : 0}`
      : "",
    `- pending_user_messages: ${Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0}`,
    routeReadinessLabel ? `- route_ready: ${routeReadinessLabel}` : "",
    manualApprovals.length > 0 ? `- pending_manual_approvals: ${manualApprovals.length}` : "",
  ];
  if (manualApprovals.length > 0) {
    for (const row of manualApprovals) {
      lines.push(`  - ${row.purpose || "approval"}: ${clip(row.summary || row.token || "", 120)}`);
    }
  }
  if (Array.isArray(enabledAgents) && enabledAgents.length > 0) {
    lines.push(`- enabled_agents: ${enabledAgents.map((id) => formatAgentRef(id, agentIndex)).join(", ")}`);
  }
  if (Array.isArray(enabledTools) && enabledTools.length > 0) {
    lines.push(`- enabled_tools: ${enabledTools.join(", ")}`);
  }
  if (activeTeam) {
    lines.push(`- active_team: ${String(activeTeam.team_name || 'configured_team')}`);
    lines.push(`- team_mode: ${String(activeTeam.mode || 'scoped_context')}`);
    lines.push(`- team_agents: ${Array.isArray(activeTeam.agents) ? activeTeam.agents.length : 0}`);
    if (overlayProfileRows.length > 0) {
      lines.push('- role_profiles:');
      for (const row of overlayProfileRows) lines.push(`  • ${row}`);
    }
    const interactionSpec = activeTeam.interaction_spec && typeof activeTeam.interaction_spec === 'object' ? activeTeam.interaction_spec : null;
    if (interactionSpec) {
      lines.push(`- team_execution_pattern: ${String(interactionSpec.execution_pattern || '(none)')}`);
      lines.push(`- final_answer_owner: ${String(interactionSpec.final_answer_owner || '(none)')}`);
    }
    if (routeReadinessLabel) {
      lines.push(`- route_readiness: ${routeReadinessLabel}`);
      if (routeContractSummary?.summary_line) lines.push(`- route_contract_summary: ${String(routeContractSummary.summary_line)}`);
      if (Array.isArray(routeContractSummary?.artifact_publishers) && routeContractSummary.artifact_publishers.length > 0) {
        lines.push(`- route_artifact_publishers: ${routeContractSummary.artifact_publishers.join(', ')}`);
      }
    }
    try {
      const profile = currentJobId ? tracking.loadProfile(currentJobId) : null;
      if (profile && Array.isArray(activeTeam.agents) && activeTeam.agents.length > 0) {
        const enforcementRows = activeTeam.agents.slice(0, 4).map((agent) => {
          const summary = summarizeRoleMemoryEnforcement({
            profile,
            provider: String(agent?.provider || '').trim().toLowerCase(),
            roleId: String(agent?.role || '').trim().toLowerCase(),
          });
          return `${String(agent?.name || agent?.agent_id || agent?.role || 'agent').trim()}: read=${(summary.read_surface_ids || []).join(', ') || '(none)'} · write=${(summary.write_surface_ids || []).join(', ') || '(none)'} · publish=${(summary.publish_surface_ids || []).join(', ') || '(none)'}`;
        }).filter(Boolean);
        if (enforcementRows.length > 0) {
          const enforcement = summarizeRoleMemoryEnforcement({
            profile,
            provider: String(activeTeam.agents[0]?.provider || '').trim().toLowerCase(),
            roleId: String(activeTeam.agents[0]?.role || '').trim().toLowerCase(),
          });
          lines.push(`- memory_contract_enforcement: read=hard(role-scoped local) · write=hard(reroute) · publish=declared_only · final=${String(enforcement.final_publish_rule || 'final_owner_declared_surface_required')} · artifact=${String(enforcement.artifact_publish_rule || 'declared_artifact_surface_required')}`);
          for (const row of enforcementRows) lines.push(`  • ${clip(row, 220)}`);
          const artifactContract = resolveArtifactDeliveryContract(currentJobId, runtime);
          const artifactContractLines = formatArtifactDeliveryContractLines(artifactContract);
          if (artifactContractLines.length > 0) {
            lines.push(`- artifact_delivery_contract: ${clip(artifactContractLines[0], 220)}`);
            for (const row of artifactContractLines.slice(1, 3)) lines.push(`  • ${clip(row, 220)}`);
          }
        }
      }
    } catch {}
  }
  if (runtimeAuthority) {
    lines.push(`- mode: ${runtimeAuthority.mode}`);
    lines.push(`- plan_source: ${runtimeAuthority.plan_source}`);
    lines.push(`- context_source: ${runtimeAuthority.context_source}`);
    lines.push(`- agent_catalog_source: ${runtimeAuthority.agent_catalog_source}`);
    lines.push(`- conversation_team_source: ${runtimeAuthority.conversation_team_source}`);
    lines.push(`- skill_catalog_source: ${runtimeAuthority.skill_catalog_source}`);
    lines.push(`- degraded_mode: ${runtimeAuthority.degraded_mode ? "true" : "false"}`);
    if (runtimeAuthority.fallback_reason) {
      lines.push(`- fallback_reason: ${clip(runtimeAuthority.fallback_reason, 180)}`);
    }
  }
  lines.push(`- heartbeat: ${heartbeatLabel}`);
  if (activeAgentsLabel) {
    lines.push(`- active_agents: ${activeAgentsLabel}`);
  }
  if (runtimeActivity.last_activity_summary) {
    lines.push(`- last_activity: ${runtimeActivity.last_activity_summary}`);
  }
  if (qualityDelta) {
    lines.push(`- quality_delta: ${qualityDelta}`);
  }
  if (runtimeTeamSnapshot) {
    const snapshotLines = summarizeRuntimeTeamSnapshotLines(runtimeTeamSnapshot, {
      actionSource: session?.last_route?.action_source || "",
    });
    for (const line of snapshotLines.slice(0, 7)) {
      lines.push(line);
    }
  }
  const plannedRosterRows = summarizeAgentRuntimeRowsFromActions(session?.last_route?.actions || [], runtime, { limit: 4 });
  if (plannedRosterRows.length > 0) {
    lines.push('- team_preview:');
    for (const row of plannedRosterRows) lines.push(`  • ${row}`);
  }
  if (Array.isArray(executionInsights?.selection?.planner_facts) && executionInsights.selection.planner_facts.length > 0) {
    lines.push(`- planner_facts: ${executionInsights.selection.planner_facts.join(', ')}`);
  }
  if (Array.isArray(executionInsights?.selection?.selected) && executionInsights.selection.selected.length > 0) {
    lines.push('- team_selection:');
    for (const row of executionInsights.selection.selected.slice(0, 5)) lines.push(`  • ${row}`);
  }
  if (Array.isArray(executionInsights?.selection?.suppressed) && executionInsights.selection.suppressed.length > 0) {
    lines.push('- suppressed_roles:');
    for (const row of executionInsights.selection.suppressed.slice(0, 4)) lines.push(`  • ${row}`);
  }
  if (executionInsights?.execution) {
    const exec = executionInsights.execution;
    lines.push(`- agent_participation: planned=${Number(exec.planned_agent_count || 0)}, observed=${Number(exec.observed_agent_count || 0)}, participation=${Number(exec.participation_pct || 0)}%`);
    if (Array.isArray(exec.participation_by_role) && exec.participation_by_role.length > 0) {
      lines.push(`- participation_by_role: ${exec.participation_by_role.join(', ')}`);
    }
    if (Array.isArray(exec.missing_agents) && exec.missing_agents.length > 0) {
      lines.push(`- missing_agents: ${exec.missing_agents.join(', ')}`);
    }
  }
  if (executionFeedbackSummary && Array.isArray(executionFeedbackSummary.patterns) && executionFeedbackSummary.patterns.length > 0) {
    lines.push('- execution_pattern_feedback:');
    for (const row of executionFeedbackSummary.patterns.slice(0, 3)) {
      lines.push(`  • ${row.execution_pattern} · runs=${row.run_count} · avg participation=${row.avg_participation_pct}% · completion=${row.completion_rate_pct}%`);
    }
  }
  if (executionFeedbackSummary && Array.isArray(executionFeedbackSummary.overlays) && executionFeedbackSummary.overlays.length > 0) {
    lines.push('- overlay_feedback:');
    for (const row of executionFeedbackSummary.overlays.slice(0, 3)) {
      lines.push(`  • ${row.title || row.overlay_id} · runs=${row.run_count} · avg participation=${row.avg_participation_pct}% · prompt=${row.avg_overlay_tokens} tok (${row.avg_overlay_share_pct}%)`);
    }
  }
  if (runtimeActivity.items.length > 0) {
    lines.push('- recent_runtime_activity:');
    for (const row of runtimeActivity.items.slice(0, 5)) {
      lines.push(`  • ${formatRelativeAge(row.ts)} · ${row.summary}`);
    }
  }
  if (memoryWriteEvents.length > 0) {
    lines.push('- memory_write_contract:');
    for (const row of memoryWriteEvents.slice(0, 5)) {
      lines.push(`  • ${formatRelativeAge(row.ts)} · ${formatMemoryWriteEvent(row)}`);
    }
  }
  if (runtime?.jobConfigDebugSummary) {
    lines.push(`- job_config(debug): ${clip(String(runtime.jobConfigDebugSummary || ""), 240)}`);
  }
  return {
    text: lines.join("\n"),
    reply_markup: buildChatStatusKeyboard({ detail: 'full', artifactCount, showRecent: runtimeActivity.items.length > 0, showPrompt: promptTelemetry.rows.length > 0 }),
    status: {
      chat_id: chatKey,
      state: session.state || "idle",
      phase_label: phaseLabel,
      situation_label: situationLabel,
      job_id: currentJobId || null,
      active_run_id: session.active_run_id || null,
      running: !!activeJobId,
      queue_for_job: queueItems.length,
      pending_interrupt: interrupt,
      pending_approval: pendingApproval,
      pending_user_messages: Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0,
      enabled_agents: Array.isArray(enabledAgents) ? enabledAgents : [],
      enabled_tools: Array.isArray(enabledTools) ? enabledTools : [],
      ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
    },
  };
}

export function formatAgentMemorySummary() {
  const roles = memory.getAgentRoles();
  return [
    "🤖 Multi-Agent 역할 메모리",
    "",
    "Gemini",
    roles.gemini,
    "",
    "Codex",
    roles.codex,
    "",
    "ChatGPT",
    roles.chatgpt,
    "",
    "Router Prompt",
    memory.getRouterPrompt(),
  ].join("\n");
}

export async function sendChatStatus(bot, chatId, { telegramUserId = "", detail = "compact" } = {}) {
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  let runtime = null;
  if (currentJobId) {
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || "") },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch {
      runtime = null;
    }
  }
  const card = buildChatStatusCard(chatId, runtime, { detail });
  if (card.reply_markup) {
    await bot.sendMessage(chatId, card.text, { reply_markup: card.reply_markup });
    return;
  }
  await sendLong(bot, chatId, card.text);
}

export async function sendAgentOrToolListQuick(bot, chatId, kind = "agent", rawArgs = "", opts = {}) {
  const cleanKind = String(kind || "").trim().toLowerCase() === "tool" ? "tool" : "agent";
  const tokens = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const sub = String(tokens[0] || "").trim().toLowerCase();
  const targetAgentId = String(tokens[1] || "").trim().toLowerCase();
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const restoreActor = bindGocActor(telegramUserId);

  try {
    if (cleanKind === "agent" && (sub === "registry" || sub === "public")) {
      const authority = composeCapabilitiesForRun({ jobId: currentJobId || "" }).authority || {};
      const isGocAuthority = String(authority.mode || "").trim().toLowerCase() === "goc";
      if (sub === "public" && !isGocAuthority) {
        await bot.sendMessage(chatId, "❌ /agents public 는 GoC 모드에서만 지원됩니다.");
        return;
      }
      try {
        const scope = sub === "public" ? "public" : (isGocAuthority ? "my" : "local");
        const query = String(tokens.slice(1).join(" ") || "").trim().toLowerCase();
        const localRegistry = isGocAuthority ? null : await refreshAgentRegistry({ includeCompiled: true });
        const rows = isGocAuthority
          ? await requireGocClient().listAgents(scope === "local" ? "my" : scope)
          : (Array.isArray(localRegistry?.agents) ? localRegistry.agents : []);
        const filteredRows = query
          ? rows.filter((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const name = String(row?.name || "").trim().toLowerCase();
            const description = String(row?.description || "").trim().toLowerCase();
            return id.includes(query) || name.includes(query) || description.includes(query);
          })
          : rows;
        const lines = [
          sub === "public"
            ? "GoC Public Agent Catalog"
            : (isGocAuthority ? "GoC My Agent Catalog" : "Local Agent Catalog"),
          ...((Array.isArray(filteredRows) ? filteredRows : []).slice(0, 50).map((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const provider = String(row?.provider || "gemini").trim().toLowerCase();
            const model = String(row?.model || provider || "gemini").trim();
            const published = row?.published === true ? "published" : "private";
            const name = String(row?.name || id || "unknown").trim();
            return `- ${name} [${id || "unknown"}] (${provider}/${model}, ${published})`;
          })),
        ];
        if (query) lines.push(`- filter: ${query}`);
        if ((Array.isArray(filteredRows) ? filteredRows : []).length === 0) lines.push("- (none)");
        await sendLong(bot, chatId, lines.join("\n"));
      } catch (error) {
        await bot.sendMessage(chatId, `❌ ${sub} 조회 실패: ${String(error?.message ?? error)}`);
      }
      return;
    }

    if (cleanKind === "agent" && ["add", "remove", "enable", "disable"].includes(sub)) {
      if (!targetAgentId) {
        await bot.sendMessage(chatId, "Usage: /agents add|remove|enable|disable <preset_or_role_ref>");
        return;
      }
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어 conversation preset/preferences 를 변경할 수 없습니다.");
        return;
      }
      try {
        const runtime = await loadSupervisorRuntime(currentJobId, {
          chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
          includeContext: false,
          includeGlobal: false,
          telegramUserId,
        });
        const result = await runConversationAgentTeamCommand({
          command: sub,
          runtime,
          jobId: currentJobId,
          agentId: targetAgentId,
          source: "telegram_agents_command",
          agentRegistry,
          buildAgentDisplayIndex,
          formatAgentRef,
          refreshAgentRegistry,
          summarizeSelectionState,
          recordDiagnostic: recordMembershipMutationDiagnostic,
        });
        await sendLong(bot, chatId, result.message);
      } catch (error) {
        await bot.sendMessage(chatId, `❌ /agents ${sub} 실패: ${String(error?.message ?? error)}`);
      }
      return;
    }

    if (!currentJobId) {
      if (cleanKind === "agent") {
        const reg = await refreshAgentRegistry({ includeCompiled: true });
        const sampleRows = (Array.isArray(reg.agents) ? reg.agents : [])
          .filter((row) => String(row?.id || "").trim())
          .slice(0, 10);
        const agentIndex = buildAgentDisplayIndex(reg, null);
        const lines = [
          "현재 활성 job이 없습니다.",
          sampleRows.length > 0
            ? `등록된 agent(샘플): ${sampleRows.map((row) => formatAgentRef(row?.id, agentIndex)).join(", ")}`
            : "등록된 agent가 없습니다.",
          "팁: /team skills 로 기본 agent별 역할/스킬을 먼저 볼 수 있습니다.",
          "작업 지시를 보내면 chat별 job이 생성됩니다.",
        ];
        let fallbackAgentsUi = null;
        if (memoryModeWithFallback() === "goc") {
          try {
            fallbackAgentsUi = await openAgentsUiInfo({ chatId, userId: telegramUserId });
          } catch {
            fallbackAgentsUi = null;
          }
        }
        await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
          miniAppLink: fallbackAgentsUi?.miniAppLink || "",
          browserLink: fallbackAgentsUi?.browserLink || fallbackAgentsUi?.link || "",
          miniAppLabel: "Open Agents Catalog",
          browserLabel: "Open Agents Catalog",
        });
        return;
      }
      await bot.sendMessage(chatId, "현재 활성 job이 없어 tool 목록을 확인할 수 없습니다.");
      return;
    }

    let runtime = null;
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch (error) {
      await bot.sendMessage(chatId, `❌ 목록 조회 실패: ${String(error?.message ?? error)}`);
      return;
    }

    if (cleanKind === "agent" && sub === "skills") {
      const action = String(tokens[1] || '').trim().toLowerCase();
      const arg = String(tokens.slice(2).join(' ') || '').trim();
      if (["catalog", "list", "search", "defaults"].includes(action)) {
        try {
          const response = await requireGocClient().listSkills({ threadId: runtime?.threadId || runtime?.thread_id || runtime?.map?.threadId || '', includeDefaults: true });
          await sendLong(bot, chatId, formatSkillCatalogRows(skillListFromResponse(response), { query: arg, limit: 50 }));
        } catch (error) {
          await bot.sendMessage(chatId, `❌ skill catalog 조회 실패: ${String(error?.message ?? error)}`);
        }
        return;
      }
      if (["show", "detail", "details", "export"].includes(action)) {
        if (!arg) {
          await bot.sendMessage(chatId, "Usage: /skills show <skill_id>");
          return;
        }
        try {
          const response = await requireGocClient().getSkillPackage(arg, { threadId: runtime?.threadId || runtime?.thread_id || runtime?.map?.threadId || '', includeDefaults: true });
          await sendLong(bot, chatId, formatSkillDetail(response));
        } catch (error) {
          await bot.sendMessage(chatId, `❌ skill detail 조회 실패: ${String(error?.message ?? error)}`);
        }
        return;
      }
      if (["install", "add"].includes(action)) {
        if (!arg) {
          await bot.sendMessage(chatId, "Usage: /skills install <skill_id>");
          return;
        }
        try {
          const response = await requireGocClient().installSkillPackage({
            threadId: runtime?.threadId || runtime?.thread_id || runtime?.map?.threadId || '',
            skillId: arg,
            sourceThreadId: runtime?.threadId || runtime?.thread_id || runtime?.map?.threadId || '',
            contextSetId: runtime?.contextSetId || runtime?.context_set_id || runtime?.map?.ctxSharedId || '',
          });
          await sendLong(bot, chatId, [`✅ skill installed`, `skill_id=${arg}`, response?.node?.id ? `node=${response.node.id}` : ''].filter(Boolean).join('\n'));
        } catch (error) {
          await bot.sendMessage(chatId, `❌ skill install 실패: ${String(error?.message ?? error)}`);
        }
        return;
      }
      if (["propose", "draft", "create"].includes(action)) {
        if (!arg) {
          await bot.sendMessage(chatId, "Usage: /skills propose <원하는 skill 설명>");
          return;
        }
        const draft = buildSkillDraftFromRequest({ request: arg, source: 'telegram', createdBy: telegramUserId ? `telegram:${telegramUserId}` : 'telegram' });
        const state = buildSkillDraftApprovalState({ draft, chatId, userId: telegramUserId });
        chatSessionStore.upsert(chatId, { pending_skill_draft: state });
        await bot.sendMessage(chatId, formatSkillDraftApprovalMessage(state), {
          reply_markup: { inline_keyboard: [[
            { text: '✅ Approve skill', callback_data: `approve_skill:${state.token}` },
            { text: '❌ Reject', callback_data: `reject_skill:${state.token}` },
          ]] },
        });
        return;
      }
      const rosterRows = summarizeAgentRoster(runtime, {
        actions: runtime?.chatSession?.last_route?.actions || runtime?.last_route?.actions || chatSessionStore.get(chatId)?.last_route?.actions || [],
        limit: 12,
      });
      const textLines = [
        '현재 agent roster',
        `- job_id: ${currentJobId}`,
      ];
      if (rosterRows.length === 0) {
        textLines.push('- 아직 계획된 runtime agent가 없습니다.')
      } else {
        textLines.push('- agents:')
        for (const row of rosterRows.slice(0, 12)) textLines.push(formatRosterRowVerbose(row))
      }
      textLines.push('', 'skill 명령:', '/skills catalog [검색어]', '/skills show <skill_id>', '/skills install <skill_id>', '/skills propose <원하는 skill 설명>');
      await sendLong(bot, chatId, textLines.join('\n'));
      return;
    }

    if (cleanKind === "agent") {
      let threadTeamInfo = null;
      try {
        threadTeamInfo = await openAgentsUiInfo({ chatId, jobId: currentJobId, userId: telegramUserId });
      } catch {
        threadTeamInfo = null;
      }
      const result = await runConversationAgentTeamCommand({
        command: "list",
        runtime,
        jobId: currentJobId,
        source: "telegram_agents_command",
        agentRegistry,
        buildAgentDisplayIndex,
        formatAgentRef,
        refreshAgentRegistry,
        summarizeSelectionState,
        recordDiagnostic: recordMembershipMutationDiagnostic,
      });
      await sendTextWithOptionalGocButton(bot, chatId, result.message, {
        miniAppLink: threadTeamInfo?.miniAppLink || "",
        browserLink: threadTeamInfo?.browserLink || threadTeamInfo?.link || "",
        miniAppLabel: "Open Thread Team",
        browserLabel: "Open Thread Team",
      });
      return;
    }

    let info = null;
    try {
      info = await buildContextInfo(currentJobId, { chatId, userId: telegramUserId || undefined });
    } catch {
      info = null;
    }

    const enabled = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];
    const disabled = runtime?.toolSelection?.disabled_ids || [];
    const lines = [
      "현재 job tool 목록",
      `- job_id: ${currentJobId}`,
      enabled.length > 0
        ? `- enabled: ${enabled.slice(0, 10).join(", ")}`
        : "- enabled: (none)",
      disabled.length > 0
        ? `- disabled: ${disabled.slice(0, 10).join(", ")}`
        : "- disabled: (none)",
      "정밀 편집은 GoC UI에서 할 수 있습니다.",
    ];
    await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
      miniAppLink: info?.miniAppLink || info?.link || "",
      browserLink: info?.browserLink || "",
    });
  } finally {
    restoreActor();
  }
}
