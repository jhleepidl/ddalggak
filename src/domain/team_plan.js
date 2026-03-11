import { normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "./skill_attachment.js";

export const DEFAULT_RUNTIME_ROLES = [
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "verifier",
  "messenger",
  "context_curator",
];

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeRoleStatus(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  if (["ready", "running", "done", "error", "disabled", "planned"].includes(value)) return value;
  return "ready";
}

export function normalizeRuntimeTeamRole(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.role_id || row.roleId || row.role || "").trim().toLowerCase();
  const roleType = String(row.role_type || row.roleType || id || "").trim().toLowerCase();
  if (!id && !roleType) return null;
  return {
    id: id || roleType,
    role_type: roleType || id,
    role_label: String(row.role_label || row.roleLabel || row.name || id || roleType).trim() || (id || roleType),
    assigned_goal: String(row.assigned_goal || row.assignedGoal || row.goal || "").trim() || undefined,
    capability_tags: normalizeStringList(row.capability_tags ?? row.capabilityTags ?? [], { max: 32, lower: true }),
    template_id: String(row.template_id || row.templateId || "").trim().toLowerCase() || undefined,
    provider: String(row.provider || "").trim().toLowerCase() || undefined,
    model: String(row.model || "").trim() || undefined,
    attached_skills: normalizeSkillAttachmentList(row.attached_skills ?? row.attachedSkills ?? []),
    depends_on: normalizeStringList(row.depends_on ?? row.dependsOn ?? [], { max: 16, lower: true }),
    context_policy: row.context_policy && typeof row.context_policy === "object"
      ? row.context_policy
      : (row.contextPolicy && typeof row.contextPolicy === "object" ? row.contextPolicy : {}),
    ephemeral: row.ephemeral === true,
    fallback: row.fallback === true,
    status: normalizeRoleStatus(row.status),
    required: row.required !== false,
    optional: row.required === false || row.optional === true,
  };
}

export function normalizeDependencyEdge(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const from = String(row.from || row.depends_on || row.dependsOn || "").trim().toLowerCase();
  const to = String(row.to || row.target || "").trim().toLowerCase();
  if (!from || !to || from === to) return null;
  return { from, to };
}

export function normalizeTeamPlan(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const roles = asArray(row.roles)
    .map(normalizeRuntimeTeamRole)
    .filter(Boolean);
  const roleIds = new Set(roles.map((role) => role.id));

  const dependencies = asArray(row.dependencies)
    .map(normalizeDependencyEdge)
    .filter((edge) => edge && roleIds.has(edge.from) && roleIds.has(edge.to));

  const givenOrder = normalizeStringList(row.execution_order ?? row.executionOrder ?? [], { max: 32, lower: true });
  const executionOrder = givenOrder.length > 0
    ? givenOrder.filter((id) => roleIds.has(id))
    : roles.map((role) => role.id);

  const mode = String(row.mode || "balanced").trim().toLowerCase() || "balanced";
  const reason = String(row.reason || "").trim() || "team plan";
  const budget = row.budget && typeof row.budget === "object"
    ? {
      max_agents: Number.isFinite(Number(row.budget.max_agents))
        ? Math.max(1, Math.min(12, Math.floor(Number(row.budget.max_agents))))
        : undefined,
      max_actions: Number.isFinite(Number(row.budget.max_actions))
        ? Math.max(1, Math.min(32, Math.floor(Number(row.budget.max_actions))))
        : undefined,
      preferred_provider_mix: normalizeStringList(row.budget.preferred_provider_mix ?? [], { max: 8, lower: true }),
    }
    : {};

  return {
    mode,
    roles,
    dependencies,
    execution_order: executionOrder,
    reason,
    budget,
  };
}

export function validateTeamPlan(raw = {}) {
  const plan = normalizeTeamPlan(raw);
  const errors = [];
  if (!Array.isArray(plan.roles) || plan.roles.length === 0) errors.push("roles_required");
  if (!Array.isArray(plan.execution_order) || plan.execution_order.length === 0) errors.push("execution_order_required");
  return {
    ok: errors.length === 0,
    errors,
    team_plan: plan,
  };
}
