import { listCanonicalWorkerRoles, normalizeWorkerRoleId } from "../compatibility/legacy_roles.js";
import { normalizeConversationPreferences } from "../domain/conversation_preferences.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

function normalizeActionType(raw = "") {
  const type = cleanId(raw);
  if (type === "add" || type === "remove" || type === "enable" || type === "disable") {
    return type;
  }
  return "";
}

function normalizePreferenceKey(raw = "") {
  return cleanId(String(raw || "").replace(/^@+/, ""));
}

function removeValue(list = [], value = "") {
  const cleanValue = cleanId(value);
  return asArray(list)
    .map((entry) => cleanId(entry))
    .filter((entry) => entry && entry !== cleanValue);
}

function addValue(list = [], value = "") {
  const out = removeValue(list, value);
  const cleanValue = cleanId(value);
  if (cleanValue) out.push(cleanValue);
  return out;
}

function normalizeCatalogIds(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const id = cleanId(row?.id || row?.agent_id || row?.agentId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeMemberIds(rows = []) {
  const members = [];
  const enabled = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const id = cleanId(row?.agent_id || row?.agentId || row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    members.push(id);
    if (row?.enabled !== false) enabled.push(id);
  }
  return {
    member_agent_ids: members,
    enabled_member_agent_ids: enabled,
  };
}

function normalizePreferenceNumber(raw, { fallback = 0 } = {}) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(8, Math.floor(num)));
}

export function resolveConversationPreferenceTarget(agentRef = "", { catalogRows = [] } = {}) {
  const query = normalizePreferenceKey(agentRef);
  if (!query) return null;
  const roleId = normalizeWorkerRoleId(query);
  if (roleId) {
    return {
      kind: "role",
      target_id: roleId,
      label: roleId,
    };
  }
  if (query.startsWith("role:")) {
    const explicitRoleId = normalizeWorkerRoleId(query.slice(5));
    if (!explicitRoleId) return null;
    return { kind: "role", target_id: explicitRoleId, label: explicitRoleId };
  }
  if (query.startsWith("preset:")) {
    const presetId = cleanId(query.slice(7));
    return presetId ? { kind: "preset", target_id: presetId, label: presetId } : null;
  }
  if (query.startsWith("skill:")) {
    const skillId = cleanId(query.slice(6));
    return skillId ? { kind: "skill", target_id: skillId, label: skillId } : null;
  }
  if (query.startsWith("domain:")) {
    const domainId = cleanId(query.slice(7));
    return domainId ? { kind: "domain", target_id: domainId, label: domainId } : null;
  }
  if (query.startsWith("locale:")) {
    const localeId = cleanId(query.slice(7));
    return localeId ? { kind: "locale", target_id: localeId, label: localeId } : null;
  }
  if (query.startsWith("control:")) {
    const modeId = cleanId(query.slice(8));
    return modeId ? { kind: "control_mode", target_id: modeId, label: modeId } : null;
  }
  if (query.startsWith("review:") || query.startsWith("reviewer_policy:")) {
    const policyId = cleanId(query.includes(":") ? query.split(":").slice(1).join(":") : "");
    return policyId ? { kind: "reviewer_policy", target_id: policyId, label: policyId } : null;
  }
  if (query.startsWith("parallel:")) {
    const count = normalizePreferenceNumber(query.slice(9), { fallback: NaN });
    return Number.isFinite(count)
      ? { kind: "max_parallel_slots", target_id: String(count), label: String(count), numeric_value: count }
      : null;
  }
  const catalogIds = normalizeCatalogIds(catalogRows);
  if (catalogIds.includes(query)) {
    return {
      kind: "preset",
      target_id: query,
      label: query,
    };
  }
  return null;
}

export function validateConversationPreferenceMutationAgainstCatalog({
  actionType = "",
  agentId = "",
  catalogRows = [],
} = {}) {
  const type = normalizeActionType(actionType);
  const id = normalizePreferenceKey(agentId);
  const target = resolveConversationPreferenceTarget(id, { catalogRows });
  const availablePresetIds = normalizeCatalogIds(catalogRows);
  if (!id) {
    return {
      ok: false,
      code: "invalid_preference_target",
      action_type: type || undefined,
      agent_id: id,
      available_preset_ids: availablePresetIds,
      available_role_ids: listCanonicalWorkerRoles(),
      message: "agent_ref is required",
    };
  }
  if (target) {
    return {
      ok: true,
      action_type: type,
      agent_id: id,
      target,
      available_preset_ids: availablePresetIds,
      available_role_ids: listCanonicalWorkerRoles(),
    };
  }
  return {
    ok: false,
    code: "unknown_preference_target",
    action_type: type,
    agent_id: id,
    available_preset_ids: availablePresetIds,
    available_role_ids: listCanonicalWorkerRoles(),
    message: `Unknown preset/role ref: @${id}. Use a preset id from /agents registry or a canonical role (${listCanonicalWorkerRoles().join(", ")}).`,
  };
}

function applyPreferenceMutation(current = {}, {
  actionType = "",
  target = null,
} = {}) {
  const type = normalizeActionType(actionType);
  const resolvedTarget = target && typeof target === "object" ? target : null;
  const preferences = normalizeConversationPreferences(current);
  if (!resolvedTarget || !type) return preferences;

  if (resolvedTarget.kind === "role") {
    return normalizeConversationPreferences({
      ...preferences,
      suppressed_role_ids: (type === "remove" || type === "disable")
        ? addValue(preferences.suppressed_role_ids, resolvedTarget.target_id)
        : removeValue(preferences.suppressed_role_ids, resolvedTarget.target_id),
    });
  }
  if (resolvedTarget.kind === "preset") {
    return normalizeConversationPreferences({
      ...preferences,
      pinned_preset_ids: (type === "add" || type === "enable")
        ? addValue(preferences.pinned_preset_ids, resolvedTarget.target_id)
        : removeValue(preferences.pinned_preset_ids, resolvedTarget.target_id),
      banned_preset_ids: (type === "remove" || type === "disable")
        ? addValue(preferences.banned_preset_ids, resolvedTarget.target_id)
        : removeValue(preferences.banned_preset_ids, resolvedTarget.target_id),
    });
  }
  if (resolvedTarget.kind === "skill") {
    return normalizeConversationPreferences({
      ...preferences,
      suppressed_skill_ids: (type === "remove" || type === "disable")
        ? addValue(preferences.suppressed_skill_ids, resolvedTarget.target_id)
        : removeValue(preferences.suppressed_skill_ids, resolvedTarget.target_id),
    });
  }
  if (resolvedTarget.kind === "domain") {
    return normalizeConversationPreferences({
      ...preferences,
      preferred_domains: (type === "add" || type === "enable")
        ? addValue(preferences.preferred_domains, resolvedTarget.target_id)
        : removeValue(preferences.preferred_domains, resolvedTarget.target_id),
    });
  }
  if (resolvedTarget.kind === "locale") {
    return normalizeConversationPreferences({
      ...preferences,
      preferred_locales: (type === "add" || type === "enable")
        ? addValue(preferences.preferred_locales, resolvedTarget.target_id)
        : removeValue(preferences.preferred_locales, resolvedTarget.target_id),
    });
  }
  if (resolvedTarget.kind === "control_mode") {
    return normalizeConversationPreferences({
      ...preferences,
      default_control_mode: (type === "remove" || type === "disable")
        ? ""
        : resolvedTarget.target_id,
    });
  }
  if (resolvedTarget.kind === "reviewer_policy") {
    return normalizeConversationPreferences({
      ...preferences,
      reviewer_policy: (type === "remove" || type === "disable")
        ? ""
        : resolvedTarget.target_id,
    });
  }
  if (resolvedTarget.kind === "max_parallel_slots") {
    return normalizeConversationPreferences({
      ...preferences,
      max_parallel_slots: (type === "remove" || type === "disable")
        ? 0
        : normalizePreferenceNumber(resolvedTarget.numeric_value ?? resolvedTarget.target_id, { fallback: 0 }),
    });
  }
  return preferences;
}

export async function applyConversationPreferenceMutation({
  teamStore = null,
  actionType = "",
  agentId = "",
  mutationOptions = {},
  catalogRows = [],
} = {}) {
  const type = normalizeActionType(actionType);
  if (!type) throw new Error(`unsupported action type: ${String(actionType || "")}`);
  if (!teamStore || typeof teamStore !== "object") {
    throw new Error("teamStore is required");
  }
  const validation = validateConversationPreferenceMutationAgainstCatalog({
    actionType: type,
    agentId,
    catalogRows,
  });
  if (!validation.ok) {
    return {
      ok: false,
      action_type: type,
      agent_id: normalizePreferenceKey(agentId),
      validation,
      result: null,
    };
  }
  const options = asObject(mutationOptions);
  const current = typeof teamStore.getPreferences === "function"
    ? await teamStore.getPreferences(options)
    : normalizeConversationPreferences(options.preferences || {});
  const next = applyPreferenceMutation(current, {
    actionType: type,
    target: validation.target,
  });
  const result = typeof teamStore.updatePreferences === "function"
    ? await teamStore.updatePreferences({
      ...options,
      preferences: next,
      source: options.source || "conversation_preference_mutation",
    })
    : {
      target: {
        thread_id: String(options.threadId || "").trim(),
        conversation_id: String(options.conversationId || "").trim(),
        source: String(options.source || "conversation_preference_mutation").trim() || undefined,
      },
      preferences: next,
      warnings: [],
    };
  return {
    ok: true,
    action_type: type,
    agent_id: normalizePreferenceKey(agentId),
    validation,
    target: validation.target,
    result,
  };
}

export function requiresCatalogValidationForTeamMutation(actionType = "") {
  const type = cleanId(actionType);
  return type === "add" || type === "enable";
}

export function createConversationTeamMutationValidationError(validation = {}) {
  const row = validation && typeof validation === "object" ? validation : {};
  const message = String(
    row.message
    || row.error
    || "conversation team mutation was rejected by catalog validation"
  ).trim();
  const error = new Error(message || "conversation team mutation validation failed");
  error.code = String(row.code || "conversation_team_mutation_validation_failed").trim();
  error.validation = row;
  return error;
}

export function validateConversationTeamMutationAgainstCatalog({
  actionType = "",
  agentId = "",
  catalogRows = [],
} = {}) {
  const type = cleanId(actionType);
  const id = cleanId(agentId);
  if (!id) {
    return {
      ok: false,
      code: "invalid_agent_id",
      action_type: type || undefined,
      agent_id: id,
      message: "agent_id is required",
      available_agent_ids: normalizeCatalogIds(catalogRows),
    };
  }
  if (!requiresCatalogValidationForTeamMutation(type)) {
    return {
      ok: true,
      action_type: type,
      agent_id: id,
      available_agent_ids: normalizeCatalogIds(catalogRows),
    };
  }
  const catalogIds = normalizeCatalogIds(catalogRows);
  if (catalogIds.includes(id)) {
    return {
      ok: true,
      action_type: type,
      agent_id: id,
      available_agent_ids: catalogIds,
    };
  }
  return {
    ok: false,
    code: "unknown_agent",
    action_type: type,
    agent_id: id,
    available_agent_ids: catalogIds,
    message: `Unknown agent id: @${id}. Run /agents registry and choose an existing agent id.`,
  };
}

export async function applyValidatedConversationTeamMutation({
  teamStore = null,
  actionType = "",
  agentId = "",
  mutationOptions = {},
  catalogRows = [],
  requireCatalogValidation = false,
} = {}) {
  const type = normalizeActionType(actionType);
  if (!type) throw new Error(`unsupported action type: ${String(actionType || "")}`);
  if (!teamStore || typeof teamStore !== "object") {
    throw new Error("teamStore is required");
  }

  const id = cleanId(agentId);
  const validation = !id
    ? {
      ok: false,
      code: "invalid_agent_id",
      action_type: type,
      agent_id: id,
      message: "agent_id is required",
      available_agent_ids: normalizeCatalogIds(catalogRows),
    }
    : (requireCatalogValidation
      ? validateConversationTeamMutationAgainstCatalog({
        actionType: type,
        agentId: id,
        catalogRows,
      })
      : {
        ok: true,
        action_type: type,
        agent_id: id,
        available_agent_ids: normalizeCatalogIds(catalogRows),
      });
  if (!validation.ok) {
    return {
      ok: false,
      action_type: type,
      agent_id: id,
      validation,
      result: null,
    };
  }

  const options = asObject(mutationOptions);
  let result = null;
  if (type === "add") {
    if (typeof teamStore.addAgent !== "function") {
      throw new Error("teamStore.addAgent is unavailable");
    }
    result = await teamStore.addAgent({
      ...options,
      agentId: id,
      enabled: options.enabled !== false,
    });
  } else if (type === "remove") {
    if (typeof teamStore.removeAgent !== "function") {
      throw new Error("teamStore.removeAgent is unavailable");
    }
    result = await teamStore.removeAgent({
      ...options,
      agentId: id,
    });
  } else {
    if (typeof teamStore.setAgentEnabled !== "function") {
      throw new Error("teamStore.setAgentEnabled is unavailable");
    }
    result = await teamStore.setAgentEnabled({
      ...options,
      agentId: id,
      enabled: type !== "disable",
    });
  }

  return {
    ok: true,
    action_type: type,
    agent_id: id,
    validation,
    result,
  };
}

export function reconcileConversationTeamWithCatalog({
  conversationRows = [],
  catalogRows = [],
} = {}) {
  const { member_agent_ids, enabled_member_agent_ids } = normalizeMemberIds(conversationRows);
  const catalogIds = normalizeCatalogIds(catalogRows);
  const catalogSet = new Set(catalogIds);
  const active_enabled_agent_ids = enabled_member_agent_ids.filter((id) => catalogSet.has(id));
  const activeSet = new Set(active_enabled_agent_ids);
  const disabled_member_agent_ids = member_agent_ids.filter((id) => catalogSet.has(id) && !activeSet.has(id));
  const unknown_member_agent_ids = member_agent_ids.filter((id) => !catalogSet.has(id));
  return {
    catalog_agent_ids: catalogIds,
    member_agent_ids,
    enabled_member_agent_ids,
    active_enabled_agent_ids,
    disabled_member_agent_ids,
    unknown_member_agent_ids,
  };
}
