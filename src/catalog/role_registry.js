import {
  DEFAULT_ROLE_TEMPLATES,
  normalizeRoleTemplateList,
} from "../domain/role_templates.js";
import {
  CANONICAL_WORKER_ROLE_IDS,
  isCanonicalWorkerRole,
  normalizeRoleId,
} from "../compatibility/legacy_roles.js";

export class RoleRegistry {
  constructor({
    roles = DEFAULT_ROLE_TEMPLATES,
  } = {}) {
    this.roles = normalizeRoleTemplateList(roles);
    this.byId = new Map(this.roles.map((role) => [role.role_id, role]));
  }

  list() {
    return [...this.roles];
  }

  resolve(roleId = "") {
    const key = normalizeRoleId(roleId, {
      allowDeprecatedControlPlane: false,
      fallback: "",
    });
    if (!key) return null;
    return this.byId.get(key) || null;
  }

  normalize(roleId = "") {
    return normalizeRoleId(roleId);
  }

  isWorkerRole(roleId = "") {
    return isCanonicalWorkerRole(roleId);
  }
}

export function createRoleRegistry(options = {}) {
  return new RoleRegistry(options);
}

export function listCanonicalRoleIds() {
  return [...CANONICAL_WORKER_ROLE_IDS];
}
