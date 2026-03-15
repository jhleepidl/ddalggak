import { normalizeStringList } from "../shared/normalize.js";

export const CANONICAL_WORKER_ROLE_IDS = Object.freeze([
  "researcher",
  "builder",
  "reviewer",
  "synthesizer",
  "operator",
]);

export const LEGACY_ROLE_ALIAS_MAP = Object.freeze({
  coder: "builder",
  verifier: "reviewer",
  messenger: "synthesizer",
  context_curator: "operator",
  planner: "deprecated_control_plane_only",
  router: "deprecated_control_plane_only",
});

export const TRANSPORT_ROLE_ALIAS_MAP = Object.freeze({
  researcher: "researcher",
  builder: "coder",
  reviewer: "reviewer",
  synthesizer: "messenger",
  operator: "context_curator",
  deprecated_control_plane_only: "planner",
});

function normalizeText(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

export function normalizeRoleId(raw = "", {
  allowDeprecatedControlPlane = true,
  fallback = "",
} = {}) {
  const value = normalizeText(raw);
  if (!value) return normalizeText(fallback);
  const aliased = LEGACY_ROLE_ALIAS_MAP[value] || value;
  if (CANONICAL_WORKER_ROLE_IDS.includes(aliased)) return aliased;
  if (allowDeprecatedControlPlane && aliased === "deprecated_control_plane_only") {
    return aliased;
  }
  return normalizeText(fallback);
}

export function normalizeWorkerRoleId(raw = "", {
  fallback = "",
} = {}) {
  const value = normalizeRoleId(raw, {
    allowDeprecatedControlPlane: false,
    fallback,
  });
  return CANONICAL_WORKER_ROLE_IDS.includes(value) ? value : normalizeText(fallback);
}

export function isCanonicalWorkerRole(raw = "") {
  return CANONICAL_WORKER_ROLE_IDS.includes(normalizeWorkerRoleId(raw));
}

export function normalizeRoleList(list = [], {
  allowDeprecatedControlPlane = true,
  max = 24,
} = {}) {
  return normalizeStringList(
    (Array.isArray(list) ? list : []).map((entry) => normalizeRoleId(entry, {
      allowDeprecatedControlPlane,
      fallback: "",
    })).filter(Boolean),
    { max, lower: true }
  );
}

export function roleIdsEqual(a = "", b = "") {
  return normalizeRoleId(a) === normalizeRoleId(b);
}

export function roleCompatibleWithList(roleId = "", compatibleRoles = []) {
  const requested = normalizeRoleId(roleId);
  if (!requested) return false;
  const supported = normalizeRoleList(compatibleRoles, {
    allowDeprecatedControlPlane: true,
    max: 64,
  });
  return supported.includes(requested);
}

export function getLegacyAliasesForRole(roleId = "") {
  const target = normalizeRoleId(roleId);
  if (!target) return [];
  return Object.entries(LEGACY_ROLE_ALIAS_MAP)
    .filter(([, canonical]) => canonical === target)
    .map(([legacy]) => legacy);
}

export function getTransportRoleId(roleId = "", {
  fallback = "",
} = {}) {
  const normalized = normalizeRoleId(roleId);
  if (normalized && TRANSPORT_ROLE_ALIAS_MAP[normalized]) {
    return TRANSPORT_ROLE_ALIAS_MAP[normalized];
  }
  return normalizeText(fallback);
}

export function listCanonicalWorkerRoles() {
  return [...CANONICAL_WORKER_ROLE_IDS];
}
