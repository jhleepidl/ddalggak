import crypto from "node:crypto";
import { normalizeSkillAttachmentList } from "./skill_attachment.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeScope(raw = "") {
  const value = normalizeText(raw).toLowerCase();
  if (["run", "team", "role", "runtime_agent"].includes(value)) return value;
  return "role";
}

function normalizeContextItems(items = []) {
  return asArray(items)
    .map((row) => asObject(row))
    .filter((row) => Object.keys(row).length > 0);
}

function normalizeTokenBudget(raw = {}) {
  const row = asObject(raw);
  const soft = Number(row.soft_limit ?? row.softLimit);
  const hard = Number(row.hard_limit ?? row.hardLimit);
  return {
    soft_limit: Number.isFinite(soft) ? Math.max(200, Math.floor(soft)) : undefined,
    hard_limit: Number.isFinite(hard) ? Math.max(200, Math.floor(hard)) : undefined,
  };
}

function normalizeSkillContextItems(list = []) {
  const attached = normalizeSkillAttachmentList(list);
  return attached.map((row) => ({
    skill_id: row.skill_id,
    load_level: row.load_level,
    selected_by: row.selected_by,
    selection_reason: row.selection_reason || undefined,
    status: row.status,
  }));
}

export function createContextPackId(prefix = "ctxp") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function normalizeContextPack(raw = {}, {
  defaultRunId = "",
} = {}) {
  const row = asObject(raw);
  const id = normalizeText(row.id) || createContextPackId();
  return {
    id,
    run_id: normalizeText(row.run_id || row.runId || defaultRunId),
    scope: normalizeScope(row.scope),
    target_runtime_agent_instance_id: normalizeText(
      row.target_runtime_agent_instance_id
      || row.targetRuntimeAgentInstanceId
    ) || undefined,
    shared_items: normalizeContextItems(row.shared_items || row.sharedItems),
    role_specific_items: normalizeContextItems(row.role_specific_items || row.roleSpecificItems),
    skill_items: normalizeSkillContextItems(row.skill_items || row.skillItems || row.attached_skills),
    excluded_items: normalizeContextItems(row.excluded_items || row.excludedItems),
    missing_items: normalizeContextItems(row.missing_items || row.missingItems),
    conflicts: normalizeContextItems(row.conflicts),
    token_budget: normalizeTokenBudget(row.token_budget || row.tokenBudget),
  };
}

export function normalizeContextPackList(list = [], options = {}) {
  return asArray(list)
    .map((row) => normalizeContextPack(row, options))
    .filter(Boolean);
}

