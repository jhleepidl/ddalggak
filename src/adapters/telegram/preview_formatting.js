import { clip } from "../../textutil.js";
import {
  formatChatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from "../../shared/agent_labels.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asMap(value) {
  return value instanceof Map ? value : new Map();
}

export function getActionGoal(action = {}) {
  if (!action || typeof action !== "object") return "";
  return String(action.goal || action.prompt || action.task || "").trim();
}

export function formatActionAgentLabel(action = {}, {
  agentIndex = new Map(),
  fallback = "unknown",
} = {}) {
  const index = asMap(agentIndex);
  const agentId = resolveActionAgentId(action);
  const nameHint = resolveActionAgentNameHint(action);
  if (!agentId && !nameHint) return fallback;
  return formatChatAgentDisplayName(agentId || nameHint, index, { nameHint });
}

export function formatChatActionLabel(action = {}, {
  agentIndex = new Map(),
  needMoreDetailFallback = "ctx",
  publishFallbackMode = "unknown",
  openContextFallback = "current",
} = {}) {
  const index = asMap(agentIndex);
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) return "(unknown)";
  if (type === "run_agent") return `run_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "propose_agent") return `propose_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "need_more_detail") return `need_more_detail:${action.context_set_id || needMoreDetailFallback}`;
  if (type === "search_public_agents") return `search_public_agents:${action.query || ""}`;
  if (type === "install_agent_blueprint") return `install_agent_blueprint:${action.blueprint_id || action.public_node_id || ""}`;
  if (type === "publish_agent") {
    const fallback = publishFallbackMode === "agent_node_id"
      ? String(action.agent_node_id || "unknown")
      : "unknown";
    return `publish_agent:${formatActionAgentLabel(action, { agentIndex: index, fallback })}`;
  }
  if (type === "add_agent_to_conversation") return `add_agent_to_conversation:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "remove_agent_from_conversation") return `remove_agent_from_conversation:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "create_agent_definition") return `create_agent_definition:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "fork_agent") return `fork_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "disable_agent") return `disable_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "enable_agent") return `enable_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "disable_tool") return `disable_tool:${action.tool_id || "unknown"}`;
  if (type === "enable_tool") return `enable_tool:${action.tool_id || "unknown"}`;
  if (type === "list_agents") return "list_agents";
  if (type === "list_tools") return "list_tools";
  if (type === "create_agent") return `create_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "update_agent") return `update_agent:${formatActionAgentLabel(action, { agentIndex: index })}`;
  if (type === "get_status") return "get_status";
  if (type === "interrupt") return `interrupt:${action.mode || "replan"}`;
  if (type === "spawn_agents") return `spawn_agents:${Array.isArray(action.agents) ? action.agents.length : 0}`;
  if (type === "open_context") return `open_context:${action.scope || openContextFallback}`;
  return type;
}

export function buildPlanPreviewLines(actions = [], {
  agentIndex = new Map(),
  actionLabel = null,
  goalClipMax = 220,
} = {}) {
  const index = asMap(agentIndex);
  const labelFn = typeof actionLabel === "function"
    ? actionLabel
    : (action) => formatChatActionLabel(action, { agentIndex: index });
  const lines = [];
  for (const action of asArray(actions)) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const agentId = formatActionAgentLabel(action, { agentIndex: index });
      const goal = clip(getActionGoal(action) || "(goal 없음)", goalClipMax);
      lines.push(`- ${agentId}: ${goal}`);
      continue;
    }
    if (type === "spawn_agents") {
      const children = asArray(action?.agents);
      if (children.length === 0) {
        lines.push(`- (system) ${labelFn(action)}`);
        continue;
      }
      for (const child of children) {
        const childId = formatActionAgentLabel(child, { agentIndex: index });
        const goal = clip(String(child?.goal || child?.prompt || child?.task || "(goal 없음)"), goalClipMax);
        lines.push(`- ${childId}: ${goal}`);
      }
      continue;
    }
    lines.push(`- (system) ${labelFn(action)}`);
  }
  if (lines.length === 0) lines.push("- (system) no actions");
  return lines;
}

export function buildQueuedAgentStatusFromActions(actions = []) {
  const out = {};
  for (const action of asArray(actions)) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const agentId = String(action.agent_id || action.agent || "").trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: "queued",
        goal: getActionGoal(action),
      };
      continue;
    }
    if (type !== "spawn_agents") continue;
    for (const child of asArray(action?.agents)) {
      const agentId = String(child?.agent_id || child?.agent || "").trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: "queued",
        goal: String(child?.goal || child?.prompt || child?.task || "").trim(),
      };
    }
  }
  return out;
}

export function buildAgentStatusLines(agentStatusMap = {}, { agentIndex = new Map() } = {}) {
  const map = agentStatusMap && typeof agentStatusMap === "object" ? agentStatusMap : {};
  const index = asMap(agentIndex);
  const entries = Object.entries(map);
  if (entries.length === 0) return ["- (agent 없음)"];
  const stateEmoji = {
    queued: "⏳",
    running: "🏃",
    done: "✅",
    error: "❌",
  };
  return entries
    .map(([agentIdRaw, rowRaw]) => {
      const agentId = String(agentIdRaw || "").trim().toLowerCase();
      if (!agentId) return "";
      const row = rowRaw && typeof rowRaw === "object" ? rowRaw : {};
      const state = String(row.state || "").trim().toLowerCase();
      const normalizedState = ["queued", "running", "done", "error"].includes(state)
        ? state
        : "queued";
      const emoji = stateEmoji[normalizedState] || "⏳";
      const agentDisplay = formatChatAgentDisplayName(agentId, index);
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
    "🧭 분담(아래) + 상태판(아래)",
    "🧭 분담",
    ...planLines,
    "",
    "📡 상태",
    ...statusLines,
  ].join("\n");
}

export function inferApprovalPreviewReason(pending = {}) {
  const explicit = String(pending?.preview_reason || pending?.reason || "").trim();
  if (explicit) return explicit;
  const type = String(pending?.action?.type || "").trim().toLowerCase();
  if ([
    "create_agent",
    "create_agent_definition",
    "update_agent",
    "propose_agent",
    "enable_agent",
    "disable_agent",
    "enable_tool",
    "disable_tool",
  ].includes(type)) return "agent/tool 설정 변경";
  if (["publish_agent", "install_agent_blueprint"].includes(type)) return "publish/install";
  return "외부 상태 변경 가능성";
}

export function buildApprovalActionSummaryLines(pending = {}, {
  actionLabel = () => "(unknown)",
} = {}) {
  if (Array.isArray(pending?.actions_summary) && pending.actions_summary.length > 0) {
    return pending.actions_summary
      .map((row) => String(row || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => row.startsWith("- ") ? row : `- ${row}`);
  }
  if (Array.isArray(pending?.preview_lines) && pending.preview_lines.length > 0) {
    return pending.preview_lines
      .map((row) => String(row || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => row.startsWith("- ") ? row : `- ${row}`);
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
    const text = String(row || "").trim();
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
  followupHint = "",
  actionLabel = () => "(unknown)",
} = {}) {
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase())
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const okCount = asArray(results).filter((row) => String(row?.status || "") === "ok").length;
  const errorCount = asArray(results).filter((row) => String(row?.status || "") === "error").length;
  const outputPreview = asArray(outputs)
    .slice(-3)
    .map((row) => `- ${String(row?.agentId || "system")}: ${clip(String(row?.output || ""), 120)}`)
    .filter(Boolean)
    .join("\n");
  const suggestedPreview = asArray(suggestedActions)
    .slice(0, 6)
    .map((action) => `- ${actionLabel(action)}`)
    .join("\n");
  return [
    `autopilot_turn=${turn}/${maxTurns}`,
    allDeliverables.length > 0 ? `deliverables=${allDeliverables.join(" | ")}` : "deliverables=(none)",
    doneSet.size > 0 ? `completed=${Array.from(doneSet).join(" | ")}` : "completed=(none)",
    remaining.length > 0 ? `remaining=${remaining.join(" | ")}` : "remaining=(none)",
    `last_results: ok=${okCount}, error=${errorCount}`,
    followupHint ? `last_followup_hint=${followupHint}` : "",
    outputPreview ? `last_outputs:\n${outputPreview}` : "",
    suggestedPreview ? `agent_suggested_actions:\n${suggestedPreview}` : "",
  ].filter(Boolean).join("\n");
}

export function buildAutopilotFollowupMessage({
  originalUserText = "",
  deliverables = [],
  completedDeliverables = [],
  followupHint = "",
  suggestedActions = [],
  actionLabel = () => "(unknown)",
} = {}) {
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase())
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const suggestedLines = asArray(suggestedActions)
    .slice(0, 5)
    .map((action) => `- ${actionLabel(action)}`)
    .join("\n");
  return [
    "자동 연속 실행 지시: 이전 턴 결과를 이어서 남은 산출물을 진행하라.",
    `원 요청: ${String(originalUserText || "").trim()}`,
    remaining.length > 0 ? `남은 deliverables: ${remaining.join(" | ")}` : "남은 deliverables 없음(완료 검증 필요)",
    followupHint ? `followup_hint: ${followupHint}` : "",
    suggestedLines ? `agent_suggested_actions:\n${suggestedLines}` : "",
    "필요 시 연구->코드->검토 순으로 다음 step을 배치하라.",
  ].filter(Boolean).join("\n");
}

export function updateCompletedDeliverablesFromOutputs(deliverables = [], completed = [], outputs = []) {
  const all = normalizeDeliverableList(deliverables, { max: 24 });
  const done = new Set(
    normalizeDeliverableList(completed, { max: 24 }).map((row) => row.toLowerCase())
  );
  const rows = asArray(outputs);
  const hasCoderOutput = rows.some((row) => String(row?.agentId || "").trim().toLowerCase() === "coder");
  const hasResearchOutput = rows.some((row) => {
    const agentId = String(row?.agentId || "").trim().toLowerCase();
    return agentId === "researcher" || agentId === "planner";
  });
  const joinedText = rows.map((row) => String(row?.output || "")).join("\n").toLowerCase();

  for (const item of all) {
    const key = String(item || "").trim().toLowerCase();
    if (!key || done.has(key)) continue;
    if (/코드|ipynb|notebook|노트북|jupyter|실습|coding|python/.test(key)) {
      if (hasCoderOutput || /```python|\.ipynb|jupyter|notebook|코드/.test(joinedText)) done.add(key);
      continue;
    }
    if (/주제|아이디어|토픽|proposal|research|리서치/.test(key)) {
      if (hasResearchOutput || /주제|아이디어|토픽|research/.test(joinedText)) done.add(key);
      continue;
    }
    if (/과제|assignment|문항|quiz|연습문제/.test(key)) {
      if (/과제|assignment|문항|quiz|문제/.test(joinedText)) done.add(key);
      continue;
    }
  }

  const out = [];
  for (const item of all) {
    const key = String(item || "").trim().toLowerCase();
    if (done.has(key)) out.push(item);
  }
  return normalizeDeliverableList(out, { max: 24 });
}

export function pickPrimaryChatOutput(outputs = []) {
  const rows = asArray(outputs);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.agentId === "researcher") return String(rows[i]?.output || "").trim();
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (String(rows[i]?.provider || "").trim().toLowerCase() === "gemini") return String(rows[i]?.output || "").trim();
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const out = String(rows[i]?.output || "").trim();
    if (out) return out;
  }
  return "";
}

export function summarizeSpecialChatOutputs(outputs = []) {
  const rows = asArray(outputs);
  const searchRows = rows.filter((row) => String(row?.mode || "") === "public_search");
  const installRows = rows.filter((row) => String(row?.mode || "") === "install_agent_blueprint");
  const publishRows = rows.filter((row) => String(row?.mode || "") === "publish_agent_request");
  const selectionRows = rows.filter((row) => String(row?.mode || "") === "job_config_selection");
  const statusRows = rows.filter((row) => String(row?.mode || "") === "get_status");
  const interruptRows = rows.filter((row) => String(row?.mode || "") === "interrupt");
  const agentWriteRows = rows.filter((row) => {
    const mode = String(row?.mode || "");
    return mode === "create_agent" || mode === "update_agent";
  });
  const spawnRows = rows.filter((row) => String(row?.mode || "") === "spawn_agents");
  const listRows = rows.filter((row) => {
    const mode = String(row?.mode || "");
    return mode === "list_agents" || mode === "list_tools";
  });
  const lines = [];

  for (const row of searchRows) {
    const items = asArray(row?.items);
    lines.push("Public agent 검색 결과");
    if (items.length === 0) {
      lines.push("- 검색 결과가 없습니다.");
      continue;
    }
    for (const item of items.slice(0, 6)) {
      const title = String(item?.title || "").trim() || String(item?.blueprint_id || "").trim();
      const blueprintId = String(item?.blueprint_id || "").trim();
      const tags = Array.isArray(item?.tags) && item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
      lines.push(`- ${title}${blueprintId ? ` (blueprint=${blueprintId})` : ""}${tags}`);
    }
  }

  for (const row of installRows) {
    const agentId = String(row?.installed_agent_id || "").trim().toLowerCase();
    const agentLabel = String(row?.installed_agent_label || row?.installed_agent_name || "").trim();
    if (agentLabel || agentId) {
      const display = agentLabel || `@${agentId}`;
      lines.push(`설치 완료: ${display}`);
      lines.push(`이제 ${display} 로 사용 가능`);
    } else {
      lines.push("설치 완료");
    }
  }

  for (const row of publishRows) {
    const requestId = String(row?.request_id || "").trim();
    if (requestId) {
      lines.push(`공개 요청 접수됨: request_id=${requestId}`);
    } else {
      lines.push("공개 요청이 생성되었습니다.");
    }
    lines.push("관리자 승인 후 public library에 반영됩니다.");
  }

  for (const row of [...selectionRows, ...statusRows, ...interruptRows, ...agentWriteRows, ...spawnRows, ...listRows]) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  return lines.join("\n").trim();
}

export function buildChatSynthesisFallback(message = "", execution = {}) {
  const special = summarizeSpecialChatOutputs(execution.outputs);
  if (special) return special;
  const primary = pickPrimaryChatOutput(execution.outputs);
  if (primary) return clip(primary, 3600);

  const errors = asArray(execution.results)
    .filter((row) => row?.status === "error")
    .map((row) => String(row?.note || "").trim())
    .filter(Boolean);
  if (errors.length > 0) {
    return `요청을 처리하는 중 오류가 발생했습니다.\n${errors.map((row) => `- ${row}`).join("\n")}`;
  }
  const oks = asArray(execution.results)
    .filter((row) => row?.status === "ok")
    .map((row) => `${row?.label || "action"}${row?.note ? ` (${row.note})` : ""}`);
  if (oks.length > 0) {
    return `요청을 처리했습니다.\n${oks.map((row) => `- ${row}`).join("\n")}`;
  }
  return `요청: ${clip(String(message || ""), 300)}\n응답을 생성하지 못했습니다. 같은 요청을 다시 보내주세요.`;
}
