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

function clipText(value = "", max = 320) {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sanitizeList(value = [], { limit = 8, max = 180 } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(value)) {
    const text = clipText(row, max);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function extractEvidenceRefs(execution = null) {
  const refs = [];
  for (const row of asArray(execution?.outputs)) {
    const item = asObject(row);
    const output = clean(item.output);
    const path = clean(item.relativePath || item.relative_path || item.path || item.artifact_path || item.artifactPath);
    const resourceId = clean(item.resource_id || item.resourceId || item.node_id || item.nodeId);
    const label = path || resourceId || clipText(output, 120);
    if (!label) continue;
    refs.push(label);
    if (refs.length >= 6) break;
  }
  return sanitizeList(refs, { limit: 6, max: 140 });
}

function extractArtifactRefs(execution = null) {
  const refs = [];
  for (const row of asArray(execution?.outputs)) {
    const item = asObject(row);
    const path = clean(item.relativePath || item.relative_path || item.path || item.artifact_path || item.artifactPath);
    if (!path) continue;
    refs.push(path);
    if (refs.length >= 6) break;
  }
  return sanitizeList(refs, { limit: 6, max: 180 });
}

function inferCapsuleAgent({ routePlan = null, execution = null } = {}) {
  const route = asObject(routePlan);
  const shortcutAgentId = cleanId(route.shortcut_followup?.target_agent_id);
  if (shortcutAgentId) return shortcutAgentId;

  const explicitOwner = cleanId(route.final_owner_agent_id || route.finalOwnerAgentId || route.final_agent_id || route.finalAgentId);
  if (explicitOwner) return explicitOwner;

  const outputs = asArray(execution?.outputs);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const agentId = cleanId(outputs[index]?.agentId || outputs[index]?.agent_id || outputs[index]?.agent);
    if (agentId && !["system", "router", "supervisor"].includes(agentId)) {
      return agentId;
    }
  }
  return "";
}

function inferCapsuleOutput({ execution = null, replyText = "" } = {}) {
  const outputs = asArray(execution?.outputs);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const row = asObject(outputs[index]);
    const agentId = cleanId(row.agentId || row.agent_id || row.agent);
    const output = clean(row.output);
    if (!output) continue;
    if (agentId && !["system", "router", "supervisor"].includes(agentId)) {
      return clipText(output, 2200);
    }
  }
  return clipText(replyText, 2200);
}

export function normalizeAnswerCapsules(raw = []) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(raw)) {
    const item = asObject(row);
    const telegramMessageId = Number.isFinite(Number(item.telegram_message_id))
      ? Number(item.telegram_message_id)
      : (Number.isFinite(Number(item.telegramMessageId)) ? Number(item.telegramMessageId) : null);
    if (!(telegramMessageId > 0)) continue;
    const key = String(telegramMessageId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      telegram_message_id: telegramMessageId,
      reply_to_message_id: Number.isFinite(Number(item.reply_to_message_id))
        ? Number(item.reply_to_message_id)
        : (Number.isFinite(Number(item.replyToMessageId)) ? Number(item.replyToMessageId) : null),
      run_id: clean(item.run_id || item.runId),
      job_id: clean(item.job_id || item.jobId),
      agent_id: cleanId(item.agent_id || item.agentId),
      agent_name: clean(item.agent_name || item.agentName || item.name),
      step_id: clean(item.step_id || item.stepId),
      answer_summary: clipText(item.answer_summary || item.answerSummary, 600),
      answer_excerpt: clipText(item.answer_excerpt || item.answerExcerpt || item.output, 2600),
      original_goal_summary: clipText(item.original_goal_summary || item.originalGoalSummary || item.goal, 1400),
      evidence_refs: sanitizeList(item.evidence_refs || item.evidenceRefs, { limit: 8, max: 180 }),
      artifact_refs: sanitizeList(item.artifact_refs || item.artifactRefs, { limit: 8, max: 180 }),
      ts: clean(item.ts || new Date().toISOString()),
    });
    if (out.length >= 48) break;
  }
  return out;
}

export function appendAnswerCapsules(existing = [], entries = []) {
  return normalizeAnswerCapsules([...(asArray(entries)), ...(asArray(existing))]);
}

export function findAnswerCapsuleByTelegramMessageId(session = null, telegramMessageId = null) {
  const target = Number(telegramMessageId);
  if (!(Number.isFinite(target) && target > 0)) return null;
  const rows = normalizeAnswerCapsules(session?.answer_capsules || session?.answerCapsules || []);
  return rows.find((row) => row.telegram_message_id === target) || null;
}

export function buildAnswerCapsules({
  telegramMessages = [],
  replyToMessageId = null,
  runId = "",
  jobId = "",
  routePlan = null,
  execution = null,
  replyText = "",
  originalGoal = "",
} = {}) {
  const messages = asArray(telegramMessages)
    .map((row) => ({
      message_id: Number.isFinite(Number(row?.message_id)) ? Number(row.message_id) : null,
    }))
    .filter((row) => row.message_id > 0);
  if (messages.length === 0) return [];

  const agentId = inferCapsuleAgent({ routePlan, execution });
  const answerExcerpt = inferCapsuleOutput({ execution, replyText });
  const summarySource = clean(replyText) || answerExcerpt;
  const answerSummary = clipText(summarySource.replace(/\s+/g, " "), 280);
  const originalGoalSummary = clipText(originalGoal, 700);
  const evidenceRefs = extractEvidenceRefs(execution);
  const artifactRefs = extractArtifactRefs(execution);
  const now = new Date().toISOString();

  return messages.map((row) => ({
    telegram_message_id: row.message_id,
    reply_to_message_id: Number.isFinite(Number(replyToMessageId)) ? Number(replyToMessageId) : null,
    run_id: clean(runId),
    job_id: clean(jobId),
    agent_id: agentId,
    answer_summary: answerSummary,
    answer_excerpt: answerExcerpt,
    original_goal_summary: originalGoalSummary,
    evidence_refs: evidenceRefs,
    artifact_refs: artifactRefs,
    ts: now,
  }));
}
