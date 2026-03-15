import {
  DEFAULT_AUTHORITY_PROFILES,
  normalizeAuthorityProfileList,
} from "../domain/authority_profiles.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";

const DEFAULT_PROFILE_BY_ROLE = Object.freeze({
  researcher: "worker_readonly_research",
  reviewer: "worker_readonly_review",
  builder: "worker_publish_guarded",
  synthesizer: "worker_publish_guarded",
  operator: "supervisor_controlled",
  deprecated_control_plane_only: "supervisor_controlled",
});

export class AuthorityRegistry {
  constructor({
    profiles = DEFAULT_AUTHORITY_PROFILES,
  } = {}) {
    this.profiles = normalizeAuthorityProfileList(profiles);
    this.byId = new Map(this.profiles.map((profile) => [profile.authority_profile_id, profile]));
  }

  list() {
    return [...this.profiles];
  }

  resolve(authorityProfileId = "") {
    const key = String(authorityProfileId || "").trim().toLowerCase();
    if (!key) return null;
    return this.byId.get(key) || null;
  }

  defaultForRole(roleId = "") {
    const key = normalizeRoleId(roleId);
    return DEFAULT_PROFILE_BY_ROLE[key] || "worker_publish_guarded";
  }
}

export function createAuthorityRegistry(options = {}) {
  return new AuthorityRegistry(options);
}

export function pickDefaultAuthorityProfileId(roleId = "") {
  const registry = new AuthorityRegistry();
  return registry.defaultForRole(roleId);
}
