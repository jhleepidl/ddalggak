import { normalizeStringList } from "../shared/normalize.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function normalizeCount(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(16, Math.floor(value)));
}

function normalizeActionList(raw = []) {
  return normalizeStringList(raw, { max: 64, lower: true });
}

export const DEFAULT_AUTHORITY_PROFILES = Object.freeze([
  {
    authority_profile_id: "worker_readonly_research",
    allowed_actions: ["read", "search", "analyze", "summarize", "cite"],
    denied_actions: ["publish", "commit", "merge", "destructive_write"],
    approval_required_for: ["network_write", "workspace_write", "tool_execute"],
    tool_allowlist: ["web", "read_only_fs"],
    max_parallel_children: 0,
  },
  {
    authority_profile_id: "worker_readonly_review",
    allowed_actions: ["read", "search", "review", "comment", "cite"],
    denied_actions: ["publish", "commit", "merge", "destructive_write"],
    approval_required_for: ["network_write", "workspace_write", "tool_execute"],
    tool_allowlist: ["web", "read_only_fs"],
    max_parallel_children: 0,
  },
  {
    authority_profile_id: "worker_publish_guarded",
    allowed_actions: ["read", "search", "write", "execute", "draft", "summarize"],
    denied_actions: ["merge", "destructive_write"],
    approval_required_for: ["publish", "commit", "network_write", "destructive_write"],
    tool_allowlist: ["web", "workspace_fs", "shell"],
    max_parallel_children: 1,
  },
  {
    authority_profile_id: "supervisor_controlled",
    allowed_actions: ["read", "search", "coordinate", "assign", "draft"],
    denied_actions: ["publish", "commit", "merge", "destructive_write"],
    approval_required_for: ["spawn_worker", "workspace_write", "tool_execute", "network_write"],
    tool_allowlist: ["web", "read_only_fs", "control_plane"],
    max_parallel_children: 5,
  },
]);

export function normalizeAuthorityProfile(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const authorityProfileId = normalizeText(
    row.authority_profile_id || row.authorityProfileId || row.id
  ).toLowerCase();
  if (!authorityProfileId) return null;
  return {
    authority_profile_id: authorityProfileId,
    allowed_actions: normalizeActionList(row.allowed_actions ?? row.allowedActions ?? []),
    denied_actions: normalizeActionList(row.denied_actions ?? row.deniedActions ?? []),
    approval_required_for: normalizeActionList(
      row.approval_required_for ?? row.approvalRequiredFor ?? []
    ),
    tool_allowlist: normalizeActionList(row.tool_allowlist ?? row.toolAllowlist ?? []),
    max_parallel_children: normalizeCount(
      row.max_parallel_children ?? row.maxParallelChildren,
      0
    ),
  };
}

export function normalizeAuthorityProfileList(list = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeAuthorityProfile(row);
    if (!normalized || seen.has(normalized.authority_profile_id)) continue;
    seen.add(normalized.authority_profile_id);
    out.push(normalized);
  }
  return out;
}
