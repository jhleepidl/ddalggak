import fs from "node:fs";
import path from "node:path";

function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeEventType(raw = "") {
  const value = normalizeText(raw, { lower: true });
  if (!value) return "skill_used";
  return value;
}

export function normalizeSkillUsageEvent(raw = {}) {
  const row = asObject(raw);
  const runId = normalizeText(row.run_id || row.runId);
  const runtimeAgentInstanceId = normalizeText(
    row.runtime_agent_instance_id
    || row.runtimeAgentInstanceId
    || row.runtime_instance_id
    || row.runtimeInstanceId
  );
  const skillId = normalizeText(row.skill_id || row.skillId, { lower: true });
  if (!skillId) return null;
  return {
    run_id: runId || undefined,
    runtime_agent_instance_id: runtimeAgentInstanceId || undefined,
    skill_id: skillId,
    event_type: normalizeEventType(row.event_type || row.eventType),
    payload: asObject(row.payload),
    created_at: normalizeText(row.created_at || row.createdAt) || new Date().toISOString(),
  };
}

export function createSkillUsageEvent({
  runId = "",
  runtimeAgentInstanceId = "",
  skillId = "",
  eventType = "skill_used",
  payload = {},
  createdAt = new Date().toISOString(),
} = {}) {
  return normalizeSkillUsageEvent({
    run_id: runId,
    runtime_agent_instance_id: runtimeAgentInstanceId,
    skill_id: skillId,
    event_type: eventType,
    payload,
    created_at: createdAt,
  });
}

function appendJsonl(filePath = "", row = {}) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function resolveEventsPath({
  jobId = "",
  runsDir = "",
  filePath = "",
} = {}) {
  const explicit = normalizeText(filePath);
  if (explicit) return explicit;
  const cleanJobId = normalizeText(jobId);
  if (!cleanJobId) return "";
  const base = normalizeText(runsDir) || process.env.RUNS_DIR || "runs";
  return path.resolve(base, cleanJobId, "skill_usage_events.jsonl");
}

export function recordSkillUsageEvent(event = null, {
  inMemory = null,
  jobId = "",
  runsDir = "",
  filePath = "",
} = {}) {
  const normalized = normalizeSkillUsageEvent(event || {});
  if (!normalized) return null;
  if (Array.isArray(inMemory)) inMemory.push(normalized);
  const outputPath = resolveEventsPath({
    jobId,
    runsDir,
    filePath,
  });
  if (outputPath) {
    try {
      appendJsonl(outputPath, normalized);
    } catch {}
  }
  return normalized;
}

export function summarizeSkillUsageEvents(events = []) {
  const summary = {
    total: 0,
    by_skill_id: {},
    by_event_type: {},
  };
  for (const rowRaw of Array.isArray(events) ? events : []) {
    const row = normalizeSkillUsageEvent(rowRaw);
    if (!row) continue;
    summary.total += 1;
    summary.by_skill_id[row.skill_id] = Number(summary.by_skill_id[row.skill_id] || 0) + 1;
    summary.by_event_type[row.event_type] = Number(summary.by_event_type[row.event_type] || 0) + 1;
  }
  return summary;
}

