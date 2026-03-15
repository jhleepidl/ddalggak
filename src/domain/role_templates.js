import { normalizeStringList } from "../shared/normalize.js";
import {
  CANONICAL_WORKER_ROLE_IDS,
  getLegacyAliasesForRole,
  normalizeWorkerRoleId,
} from "../compatibility/legacy_roles.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

export const DEFAULT_ROLE_TEMPLATES = Object.freeze([
  {
    role_id: "researcher",
    display_name: "Researcher",
    description: "Collect evidence, inspect sources, and surface uncertainty.",
    capability_tags: ["research", "analysis", "evidence"],
  },
  {
    role_id: "builder",
    display_name: "Builder",
    description: "Implement changes or produce working artifacts from an approved plan.",
    capability_tags: ["implementation", "coding", "delivery"],
  },
  {
    role_id: "reviewer",
    display_name: "Reviewer",
    description: "Stress-test outputs, find defects, and validate claims.",
    capability_tags: ["review", "verification", "qa"],
  },
  {
    role_id: "synthesizer",
    display_name: "Synthesizer",
    description: "Combine outputs into a concise user-facing brief or handoff.",
    capability_tags: ["summary", "communication", "handoff"],
  },
  {
    role_id: "operator",
    display_name: "Operator",
    description: "Coordinate runtime state, context handling, and operational safety tasks.",
    capability_tags: ["operations", "context", "coordination"],
  },
]);

export function normalizeRoleTemplate(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const roleId = normalizeWorkerRoleId(row.role_id || row.roleId || row.id || row.name);
  if (!roleId || !CANONICAL_WORKER_ROLE_IDS.includes(roleId)) return null;
  return {
    role_id: roleId,
    display_name: normalizeText(row.display_name || row.displayName || row.title || roleId) || roleId,
    description: normalizeText(row.description),
    capability_tags: normalizeStringList(
      row.capability_tags ?? row.capabilityTags ?? [],
      { max: 32, lower: true }
    ),
    legacy_aliases: normalizeStringList(
      row.legacy_aliases ?? row.legacyAliases ?? getLegacyAliasesForRole(roleId),
      { max: 16, lower: true }
    ),
  };
}

export function normalizeRoleTemplateList(list = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeRoleTemplate(row);
    if (!normalized || seen.has(normalized.role_id)) continue;
    seen.add(normalized.role_id);
    out.push(normalized);
  }
  return out;
}
