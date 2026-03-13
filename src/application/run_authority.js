import {
  buildRuntimeMetadataPatch,
  normalizeRuntimeAuthority,
} from "./runtime_metadata.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function pickAuthorityFields(value = {}) {
  const row = asObject(value);
  const nested = row.runtimeAuthority ?? row.runtime_authority;
  if (nested && typeof nested === "object") return pickAuthorityFields(nested);

  const out = {};
  const modeRaw = String(row.mode || "").trim().toLowerCase();
  if (modeRaw === "goc" || modeRaw === "standalone" || modeRaw === "local") {
    out.mode = row.mode;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "plan_source")
    || Object.prototype.hasOwnProperty.call(row, "planSource")
  ) {
    out.plan_source = row.plan_source ?? row.planSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "context_source")
    || Object.prototype.hasOwnProperty.call(row, "contextSource")
  ) {
    out.context_source = row.context_source ?? row.contextSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "agent_catalog_source")
    || Object.prototype.hasOwnProperty.call(row, "agentCatalogSource")
  ) {
    out.agent_catalog_source = row.agent_catalog_source ?? row.agentCatalogSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "conversation_team_source")
    || Object.prototype.hasOwnProperty.call(row, "conversationTeamSource")
  ) {
    out.conversation_team_source = row.conversation_team_source ?? row.conversationTeamSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "skill_catalog_source")
    || Object.prototype.hasOwnProperty.call(row, "skillCatalogSource")
  ) {
    out.skill_catalog_source = row.skill_catalog_source ?? row.skillCatalogSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "degraded_mode")
    || Object.prototype.hasOwnProperty.call(row, "degradedMode")
  ) {
    out.degraded_mode = row.degraded_mode ?? row.degradedMode;
  }
  if (
    Object.prototype.hasOwnProperty.call(row, "fallback_reason")
    || Object.prototype.hasOwnProperty.call(row, "fallbackReason")
  ) {
    out.fallback_reason = row.fallback_reason ?? row.fallbackReason;
  }
  return out;
}

export const RUN_AUTHORITY_CONTRACT_FIELDS = Object.freeze([
  "mode",
  "plan_source",
  "context_source",
  "agent_catalog_source",
  "conversation_team_source",
  "skill_catalog_source",
  "degraded_mode",
  "fallback_reason",
]);

export const RUN_AUTHORITY_DEFAULTS = Object.freeze({
  standalone: Object.freeze({
    mode: "standalone",
    plan_source: "local",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: false,
    fallback_reason: null,
  }),
  goc: Object.freeze({
    mode: "goc",
    plan_source: "local",
    context_source: "goc",
    agent_catalog_source: "goc",
    conversation_team_source: "goc",
    skill_catalog_source: "mixed",
    degraded_mode: false,
    fallback_reason: null,
  }),
  local_fallback: Object.freeze({
    mode: "standalone",
    plan_source: "local_fallback",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: true,
    fallback_reason: null,
  }),
});

function pickAuthorityDefaults(input = null) {
  const normalized = normalizeRuntimeAuthority(pickAuthorityFields(input));
  if (normalized?.plan_source === "local_fallback" || normalized?.degraded_mode === true) {
    return RUN_AUTHORITY_DEFAULTS.local_fallback;
  }
  if (normalized?.mode === "goc") return RUN_AUTHORITY_DEFAULTS.goc;
  return RUN_AUTHORITY_DEFAULTS.standalone;
}

function buildAuthorityEnvelope(authority = null, {
  includeRuntimeMode = false,
  includeFlattenedMode = true,
  ...options
} = {}) {
  if (!authority) return {};
  const patch = buildRuntimeMetadataPatch({ runtime_authority: authority }, options);
  if (!includeFlattenedMode) delete patch.mode;
  return {
    ...patch,
    ...(includeRuntimeMode ? { runtime_mode: authority.mode } : {}),
  };
}

export function normalizeRunAuthority(authority = null, { fallback = null } = {}) {
  return normalizeRuntimeAuthority(authority, { fallback });
}

export function createRunAuthorityContract(authority = null, { fallback = null } = {}) {
  const candidate = pickAuthorityFields(authority);
  const base = fallback || pickAuthorityDefaults(candidate);
  return normalizeRunAuthority(candidate, { fallback: base });
}

export function mergeRunAuthority(baseAuthority = null, overrides = null) {
  const base = createRunAuthorityContract(baseAuthority);
  const merged = {
    ...(base || {}),
    ...pickAuthorityFields(overrides),
  };
  return normalizeRunAuthority(merged, { fallback: base || pickAuthorityDefaults(merged) });
}

export function buildRunAuthority(runtime = null, overrides = {}) {
  const row = asObject(runtime);
  return mergeRunAuthority(
    row.runtimeAuthority || row.runtime_authority || row,
    overrides
  );
}

export function buildRunAuthorityPatch(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return {};
  return buildRuntimeMetadataPatch(
    { runtime_authority: authority },
    options
  );
}

export function buildRunAuthorityEnvelope(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return {};
  return {
    ...buildAuthorityEnvelope(authority, {
      includeFlattenedMode: false,
      ...options,
    }),
    runtimeAuthority: authority,
  };
}

export function summarizeRunAuthorityLines(runtime = null, overrides = {}, {
  prefix = "- ",
  includeMode = true,
  modeLabel = "mode",
  includeFallbackReason = true,
  fallbackReasonEmpty = "",
} = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return [];

  const lines = [];
  if (includeMode) lines.push(`${prefix}${modeLabel}: ${authority.mode}`);
  lines.push(`${prefix}plan_source: ${authority.plan_source}`);
  lines.push(`${prefix}context_source: ${authority.context_source}`);
  lines.push(`${prefix}agent_catalog_source: ${authority.agent_catalog_source}`);
  lines.push(`${prefix}conversation_team_source: ${authority.conversation_team_source}`);
  lines.push(`${prefix}skill_catalog_source: ${authority.skill_catalog_source}`);
  lines.push(`${prefix}degraded_mode: ${authority.degraded_mode ? "true" : "false"}`);
  if (includeFallbackReason) {
    const value = authority.fallback_reason || fallbackReasonEmpty;
    if (value) lines.push(`${prefix}fallback_reason: ${value}`);
  }
  return lines;
}

export function applyRunAuthority(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return null;
  if (runtime && typeof runtime === "object") {
    Object.assign(runtime, buildRunAuthorityEnvelope(
      { runtime_authority: authority },
      {},
      options
    ));
  }
  return authority;
}
