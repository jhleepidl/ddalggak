import {
  buildRuntimeMetadataPatch,
  normalizeRuntimeAuthority,
} from "./runtime_metadata.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function normalizeRunAuthority(authority = null, { fallback = null } = {}) {
  return normalizeRuntimeAuthority(authority, { fallback });
}

export function buildRunAuthority(runtime = null, overrides = {}) {
  const row = asObject(runtime);
  const base = normalizeRunAuthority(
    row.runtimeAuthority || row.runtime_authority || null
  );
  const merged = {
    ...(base || {}),
    ...asObject(overrides),
  };
  return normalizeRunAuthority(merged, { fallback: base || null });
}

export function buildRunAuthorityPatch(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return {};
  return buildRuntimeMetadataPatch(
    { runtime_authority: authority },
    options
  );
}

export function applyRunAuthority(runtime = null, overrides = {}, options = {}) {
  const authority = buildRunAuthority(runtime, overrides);
  if (!authority) return null;
  if (runtime && typeof runtime === "object") {
    const patch = buildRunAuthorityPatch(runtime, overrides, options);
    runtime.runtimeAuthority = authority;
    runtime.runtime_authority = authority;
    Object.assign(runtime, patch);
  }
  return authority;
}
