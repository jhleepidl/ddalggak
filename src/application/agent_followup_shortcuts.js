import { findAnswerCapsuleByTelegramMessageId } from "./answer_capsules.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function clean(value = "") {
  return String(value || "").trim();
}

function cleanId(value = "") {
  return clean(value).toLowerCase();
}

function clipText(value = "", max = 3200) {
  const text = clean(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

const FOLLOWUP_KEYWORDS = [
  /왜/, /이유/, /근거/, /설명/, /자세히/, /더\s*자세히/, /풀어서/, /보충/, /어째서/, /어떻게\s*그렇게/,
  /why\b/i, /reason\b/i, /rationale\b/i, /justify\b/i, /explain\b/i, /elaborate\b/i, /expand\b/i,
];

const FOLLOWUP_REFERENTS = [
  /방금/, /아까/, /직전/, /위\s*답변/, /그\s*답변/, /해당\s*답변/, /네\s*답변/, /이\s*답변/,
  /previous\s+answer/i, /last\s+answer/i, /that\s+answer/i,
];

const NEW_TASK_KEYWORDS = [
  /구현/, /수정/, /패치/, /작성/, /생성/, /만들/, /리팩토/, /검색/, /조사/, /분석/, /정리해줘/, /계획/, /설계안/,
  /implement/i, /patch/i, /write/i, /create/i, /search/i, /research/i, /analy[sz]e/i, /plan/i,
];

const SHORTCUT_ELIGIBLE_PROVIDERS = new Set(["gemini", "chatgpt"]);
const SHORTCUT_ELIGIBLE_ROLES = new Set(["researcher", "reviewer", "synthesizer", "operator"]);

export function normalizeRecentAgentTurns(raw = []) {
  const rows = asArray(raw);
  const out = [];
  for (const row of rows) {
    const item = asObject(row);
    const agentId = cleanId(item.agent_id || item.agentId || item.id);
    if (!agentId) continue;
    out.push({
      agent_id: agentId,
      agent_name: clean(item.agent_name || item.agentName || item.name),
      role: cleanId(item.role || item.role_id || item.roleId),
      provider: cleanId(item.provider),
      model: clean(item.model),
      goal: clipText(item.goal, 1200),
      output: clipText(item.output, 5000),
      runtime_instance_id: clean(item.runtime_instance_id || item.runtimeInstanceId),
      slot_id: clean(item.slot_id || item.slotId),
      scope_id: clean(item.scope_id || item.scopeId),
      ts: clean(item.ts || new Date().toISOString()),
      job_id: clean(item.job_id || item.jobId),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function appendRecentAgentTurn(existing = [], entry = {}) {
  const normalized = normalizeRecentAgentTurns([entry, ...asArray(existing)]);
  const deduped = [];
  const seen = new Set();
  for (const row of normalized) {
    const key = [row.agent_id, row.goal, row.output].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= 6) break;
  }
  return deduped;
}

function estimateTokenCount(text = "") {
  return (String(text || "").match(/[a-zA-Z0-9가-힣_]+/g) || []).length;
}

function isLikelyNewTask(message = "") {
  const text = clean(message);
  if (!text || text.startsWith("/")) return false;
  for (const regex of NEW_TASK_KEYWORDS) {
    if (regex.test(text) && estimateTokenCount(text) > 8) return true;
  }
  return false;
}

export function inferAgentFollowupIntent(message = "") {
  const text = clean(message);
  const lower = text.toLowerCase();
  if (!text) return { matched: false, score: 0, reasons: [] };
  if (text.startsWith("/")) return { matched: false, score: 0, reasons: ["command"] };

  let score = 0;
  const reasons = [];

  for (const regex of FOLLOWUP_KEYWORDS) {
    if (regex.test(text)) {
      score += 2;
      reasons.push(`keyword:${regex}`);
      break;
    }
  }
  for (const regex of FOLLOWUP_REFERENTS) {
    if (regex.test(text)) {
      score += 2;
      reasons.push(`referent:${regex}`);
      break;
    }
  }
  if (/[?？]$/.test(text) || /\?$/.test(text)) {
    score += 1;
    reasons.push("question");
  }
  if (estimateTokenCount(text) <= 18) {
    score += 1;
    reasons.push("short");
  }
  if (lower.includes("그건") || lower.includes("why") || lower.includes("because")) {
    score += 1;
    reasons.push("anaphora");
  }
  for (const regex of NEW_TASK_KEYWORDS) {
    if (regex.test(text) && estimateTokenCount(text) > 10) {
      score -= 2;
      reasons.push(`new_task:${regex}`);
      break;
    }
  }

  return {
    matched: score >= 3,
    score,
    reasons,
  };
}

function collectExplicitMentions(message = "", runtime = null) {
  const text = clean(message).toLowerCase();
  if (!text) return new Set();
  const mentions = new Set();
  const catalogs = [
    ...asArray(runtime?.agents),
    ...asArray(runtime?.agentsCatalog),
    ...asArray(runtime?.activeTeamConfig?.agents),
  ];
  for (const row of catalogs) {
    const agentId = cleanId(row?.id || row?.agent_id || row?.agentId);
    const name = clean(row?.name);
    const role = cleanId(row?.role || row?.role_id || row?.roleId || row?.system_key);
    if (agentId && text.includes(agentId)) mentions.add(agentId);
    if (name && text.includes(name.toLowerCase())) mentions.add(agentId || name.toLowerCase());
    if (role && text.includes(role)) mentions.add(agentId || role);
  }
  return mentions;
}

function isShortcutEligibleTurn(turn = {}) {
  const provider = cleanId(turn.provider);
  const role = cleanId(turn.role);
  if (provider && !SHORTCUT_ELIGIBLE_PROVIDERS.has(provider)) return false;
  if (role && !SHORTCUT_ELIGIBLE_ROLES.has(role)) return false;
  return clean(turn.output).length > 0;
}

function buildReplyAnchoredFollowup({ capsule = null, message = "" } = {}) {
  const row = asObject(capsule);
  const agentId = cleanId(row.agent_id || row.agentId);
  if (!agentId) return null;
  const prompt = [
    "[FOLLOW-UP SHORTCUT: REPLY ANCHOR]",
    "너는 이전 답변을 작성했던 동일한 agent다.",
    "이번 요청은 오래된 답장(reply) 기반의 후속 질문이므로 team router를 다시 거치지 않는다.",
    "가능하면 이전 답변의 논리와 근거를 그대로 이어서 설명하고, 새 팀 구성 제안은 하지 말라.",
    row.original_goal_summary ? `[ORIGINAL GOAL SUMMARY]\n${row.original_goal_summary}` : "",
    row.answer_summary ? `[PREVIOUS ANSWER SUMMARY]\n${row.answer_summary}` : "",
    row.answer_excerpt ? `[PREVIOUS ANSWER EXCERPT]\n${clipText(row.answer_excerpt, 3600)}` : "",
    Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0
      ? `[EVIDENCE REFS]\n${row.evidence_refs.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    Array.isArray(row.artifact_refs) && row.artifact_refs.length > 0
      ? `[ARTIFACT REFS]\n${row.artifact_refs.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    `[USER FOLLOW-UP]\n${clean(message)}`,
    "[RESPONSE STYLE] 한국어로 직접 답하고, 필요하면 이전 답변과 연결되는 핵심 근거만 짧게 덧붙여라.",
  ].filter(Boolean).join("\n\n");

  return {
    matched: true,
    reason: "reply_anchor_capsule",
    target_agent_id: agentId,
    target_capsule: row,
    action: {
      type: "run_agent",
      agent_id: agentId,
      goal: prompt,
      inputs: {
        shortcut_followup: true,
        reply_anchor_followup: true,
        reply_anchor_message_id: row.telegram_message_id || undefined,
      },
    },
  };
}

export function planAgentFollowupShortcut({ message = "", session = null, runtime = null, teamConfig = null, replyToMessageId = null } = {}) {
  const intent = inferAgentFollowupIntent(message);
  const cleanReplyToMessageId = Number.isFinite(Number(replyToMessageId)) ? Number(replyToMessageId) : null;
  const shortcutPolicy = asObject(teamConfig?.shortcut_policy || runtime?.activeTeamConfig?.shortcut_policy);
  if (shortcutPolicy.enabled === false) {
    return { matched: false, reason: "shortcut_disabled", intent };
  }
  if (session?.pending_approval && shortcutPolicy.disallow_when_pending_approval !== false) {
    return { matched: false, reason: "pending_approval", intent };
  }

  if (!cleanReplyToMessageId) {
    return { matched: false, reason: "reply_required", intent };
  }

  const replyCapsule = findAnswerCapsuleByTelegramMessageId(session, cleanReplyToMessageId);
  const replyShortcutAllowed = replyCapsule && !isLikelyNewTask(message);
  if (replyShortcutAllowed) {
    const anchored = buildReplyAnchoredFollowup({ capsule: replyCapsule, message });
    if (anchored) {
      return {
        ...anchored,
        intent: {
          ...intent,
          matched: true,
          score: Math.max(3, Number(intent?.score || 0)),
          reasons: [...new Set([...(Array.isArray(intent?.reasons) ? intent.reasons : []), "reply_anchor"])],
        },
      };
    }
  }

  if (!intent.matched) return { matched: false, reason: "intent_not_matched", intent };

  const recentTurns = normalizeRecentAgentTurns(session?.recent_agent_turns || session?.recentAgentTurns || []);
  if (recentTurns.length === 0) return { matched: false, reason: "no_recent_agent_turn", intent };

  const explicitMentions = collectExplicitMentions(message, runtime);
  const eligibleTurns = recentTurns.filter(isShortcutEligibleTurn);
  if (eligibleTurns.length === 0) return { matched: false, reason: "no_eligible_recent_agent_turn", intent };

  const targetTurn = explicitMentions.size > 0
    ? eligibleTurns.find((row) => explicitMentions.has(row.agent_id)) || eligibleTurns[0]
    : eligibleTurns[0];

  if (!targetTurn?.agent_id) return { matched: false, reason: "no_target_agent", intent };

  const followupPrompt = [
    "[FOLLOW-UP SHORTCUT]",
    "너는 방금 직전 응답을 작성했던 동일한 agent다.",
    "이번 요청은 team router를 다시 거치지 않는 짧은 후속 질문이다.",
    "가능하면 방금 네가 제시한 논리와 근거를 그대로 이어서 설명하라.",
    "새 팀 구성이나 새 agent 분배를 제안하지 말고, 필요한 설명만 바로 답하라.",
    targetTurn.goal ? `[PREVIOUS GOAL]\n${targetTurn.goal}` : "",
    targetTurn.output ? `[YOUR PREVIOUS ANSWER]\n${clipText(targetTurn.output, 3600)}` : "",
    `[USER FOLLOW-UP]\n${clean(message)}`,
    "[RESPONSE STYLE] 한국어로 직접 답하고, 필요하면 핵심 근거만 짧게 덧붙여라.",
  ].filter(Boolean).join("\n\n");

  return {
    matched: true,
    reason: "recent_agent_followup",
    intent,
    target_agent_id: targetTurn.agent_id,
    target_turn: targetTurn,
    action: {
      type: "run_agent",
      agent_id: targetTurn.agent_id,
      goal: followupPrompt,
      inputs: {
        runtime_instance_id: targetTurn.runtime_instance_id || undefined,
        slot_id: targetTurn.slot_id || undefined,
        scope_id: targetTurn.scope_id || undefined,
        shortcut_followup: true,
      },
    },
  };
}
