import crypto from "node:crypto";
import { normalizeNodeIds, normalizeStringList } from "../shared/normalize.js";
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

function normalizeLoadLevel(raw = "", skillItems = []) {
  const explicit = normalizeText(raw).toLowerCase();
  if (["metadata_only", "instructions", "resources"].includes(explicit)) return explicit;
  if (skillItems.some((entry) => entry.load_level === "resources")) return "resources";
  if (skillItems.some((entry) => entry.load_level === "instructions")) return "instructions";
  return "metadata_only";
}

function inferContextTypes(row = {}, {
  sharedItems = [],
  roleSpecificItems = [],
} = {}) {
  const explicit = normalizeStringList(row.context_types ?? row.contextTypes ?? [], {
    max: 32,
    lower: true,
  });
  if (explicit.length > 0) return explicit;
  const inferred = [
    ...sharedItems.map((entry) => normalizeText(entry.kind || entry.type).toLowerCase()),
    ...roleSpecificItems.map((entry) => normalizeText(entry.kind || entry.type).toLowerCase()),
  ].filter(Boolean);
  return normalizeStringList(inferred, { max: 32, lower: true });
}

export function createContextPackId(prefix = "ctxp") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function normalizeContextPack(raw = {}, {
  defaultRunId = "",
} = {}) {
  const row = asObject(raw);
  const contextPackId = normalizeText(
    row.context_pack_id
    || row.contextPackId
    || row.id
  ) || createContextPackId();
  const sharedItems = normalizeContextItems(row.shared_items || row.sharedItems);
  const roleSpecificItems = normalizeContextItems(row.role_specific_items || row.roleSpecificItems);
  const skillItems = normalizeSkillContextItems(
    row.skill_items
    || row.skillItems
    || row.attached_skills
  );
  const tokenBudget = normalizeTokenBudget(row.token_budget || row.tokenBudget);
  const targetInstanceId = normalizeText(
    row.target_instance_id
    || row.targetInstanceId
    || row.target_runtime_agent_instance_id
    || row.targetRuntimeAgentInstanceId
  ) || undefined;
  const budgetTokensRaw = Number(
    row.budget_tokens
    ?? row.budgetTokens
    ?? tokenBudget.hard_limit
    ?? tokenBudget.soft_limit
  );
  return {
    context_pack_id: contextPackId,
    id: contextPackId,
    run_id: normalizeText(row.run_id || row.runId || defaultRunId),
    scope: normalizeScope(row.scope),
    target_instance_id: targetInstanceId,
    target_runtime_agent_instance_id: targetInstanceId,
    context_types: inferContextTypes(row, {
      sharedItems,
      roleSpecificItems,
    }),
    evidence_node_ids: normalizeNodeIds(
      row.evidence_node_ids
      ?? row.evidenceNodeIds
      ?? row.node_ids
      ?? row.nodeIds
      ?? [],
      { max: 64 }
    ),
    budget_tokens: Number.isFinite(budgetTokensRaw) ? Math.max(0, Math.floor(budgetTokensRaw)) : undefined,
    load_level: normalizeLoadLevel(row.load_level || row.loadLevel, skillItems),
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
    shared_items: sharedItems,
    role_specific_items: roleSpecificItems,
    skill_items: skillItems,
    excluded_items: normalizeContextItems(row.excluded_items || row.excludedItems),
    missing_items: normalizeContextItems(row.missing_items || row.missingItems),
    conflicts: normalizeContextItems(row.conflicts),
    token_budget: tokenBudget,
  };
}

export function normalizeContextPackList(list = [], options = {}) {
  return asArray(list)
    .map((row) => normalizeContextPack(row, options))
    .filter(Boolean);
}
