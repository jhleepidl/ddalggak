import {
  applyConversationPreferenceMutation,
  applyValidatedConversationTeamMutation,
  createConversationTeamMutationValidationError,
  reconcileConversationTeamWithCatalog,
} from "./conversation_team_mutation.js";
import {
  createMembershipConfirmationError,
  verifyConversationMembershipMutation,
} from "./membership_confirmation.js";
import {
  buildLogicalAgentCatalogIndex,
  logicalAgentCommandRef,
  resolveLogicalAgentRef,
} from "./logical_agents.js";
import { summarizeMembershipTarget } from "./membership_target.js";
import { buildRunAuthority } from "./run_authority.js";
import { normalizeConversationPreferences } from "../domain/conversation_preferences.js";
import { normalizeWorkerRoleId } from "../compatibility/legacy_roles.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}


function humanizeRef(raw = "") {
  const clean = cleanId(String(raw || "").replace(/^@+/, ""));
  if (!clean) return "Agent";
  const canonicalRole = normalizeWorkerRoleId(clean);
  if (canonicalRole) {
    return canonicalRole.charAt(0).toUpperCase() + canonicalRole.slice(1);
  }
  const words = clean
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      if (part.toUpperCase() === part && part.length <= 5) return part;
      if (part === 'dart') return 'DART';
      if (part === 'goc') return 'GoC';
      if (part === 'ui') return 'UI';
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  return words.join(' ') || 'Agent';
}
function uniqIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function actionVerb(actionType = "") {
  const type = cleanId(actionType);
  if (type === "add") return "추가";
  if (type === "remove") return "제거";
  if (type === "enable") return "활성화";
  if (type === "disable") return "비활성화";
  return type || "변경";
}

function formatAgentRefDefault(agentId = "") {
  return humanizeRef(agentId);
}

function enabledAgentIdsFromConsistency(teamConsistency = {}) {
  const sourceIds = asArray(teamConsistency?.catalog_agent_ids).length > 0
    ? teamConsistency?.active_enabled_agent_ids
    : teamConsistency?.enabled_member_agent_ids;
  return Array.from(new Set(asArray(sourceIds).map((id) => cleanId(id)).filter(Boolean)));
}

function summarizeSelectionStateDefault({ catalog = [], enabled = [] } = {}) {
  const catalogIds = Array.from(new Set(
    asArray(catalog).map((row) => cleanId(row?.id || row?.agent_id || row?.agentId)).filter(Boolean)
  ));
  const enabledIds = Array.from(new Set(
    asArray(enabled).map((row) => cleanId(row?.id || row?.agent_id || row?.agentId)).filter(Boolean)
  ));
  const enabledSet = new Set(enabledIds);
  return {
    catalog_ids: catalogIds,
    enabled_ids: enabledIds,
    disabled_ids: catalogIds.filter((id) => !enabledSet.has(id)),
  };
}

function pushUniq(target = [], raw = "") {
  const id = cleanId(raw);
  if (!id || target.includes(id)) return target;
  target.push(id);
  return target;
}

function deriveLastActiveRunTeamAgentIds(runtime = {}) {
  const snapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === "object"
      ? runtime.runtime_team_snapshot
      : null);
  const runtimeAgents = Array.isArray(snapshot?.runtime_agents)
    ? snapshot.runtime_agents
    : (Array.isArray(snapshot?.runtimeAgents) ? snapshot.runtimeAgents : []);
  return uniqIds(runtimeAgents.map((row) => (
    row?.template_id
    || row?.templateId
    || row?.agent_id
    || row?.agentId
    || row?.role_label
    || row?.roleLabel
  )));
}

function getRuntimeConversationPreferences(runtime = {}) {
  return normalizeConversationPreferences(
    runtime?.conversationPreferences
    || runtime?.conversation_preferences
    || {}
  );
}

function buildLogicalMembershipIndex(conversationRows = [], logicalCatalog = null) {
  const catalog = logicalCatalog && typeof logicalCatalog === "object"
    ? logicalCatalog
    : buildLogicalAgentCatalogIndex([]);
  const byLogicalId = new Map();
  const unknownRawAgentIds = [];

  for (const row of asArray(conversationRows)) {
    const rawAgentId = cleanId(row?.agent_id || row?.agentId || row?.id);
    if (!rawAgentId) continue;
    const logicalAgentId = catalog.rawIdToLogicalId instanceof Map && catalog.rawIdToLogicalId.has(rawAgentId)
      ? catalog.rawIdToLogicalId.get(rawAgentId)
      : rawAgentId;
    const logicalAgent = catalog.byLogicalId instanceof Map
      ? (catalog.byLogicalId.get(logicalAgentId) || null)
      : null;
    if (!logicalAgent) pushUniq(unknownRawAgentIds, rawAgentId);
    if (!byLogicalId.has(logicalAgentId)) {
      byLogicalId.set(logicalAgentId, {
        logical_agent_id: logicalAgentId,
        command_ref: logicalAgent?.command_ref || rawAgentId,
        representative_agent_id: logicalAgent?.representative_agent_id || rawAgentId,
        member_agent_ids: [],
        enabled_member_agent_ids: [],
        disabled_member_agent_ids: [],
        rows: [],
        logical_agent: logicalAgent,
      });
    }
    const entry = byLogicalId.get(logicalAgentId);
    entry.rows.push(row);
    pushUniq(entry.member_agent_ids, rawAgentId);
    if (row?.enabled !== false) pushUniq(entry.enabled_member_agent_ids, rawAgentId);
    else pushUniq(entry.disabled_member_agent_ids, rawAgentId);
  }

  return {
    byLogicalId,
    unknownRawAgentIds: uniqIds(unknownRawAgentIds),
  };
}

function buildAddressableLogicalAgents(logicalCatalog = null, membershipIndex = null) {
  const catalog = logicalCatalog && typeof logicalCatalog === "object"
    ? logicalCatalog
    : buildLogicalAgentCatalogIndex([]);
  const membership = membershipIndex && typeof membershipIndex === "object"
    ? membershipIndex
    : buildLogicalMembershipIndex([], catalog);
  const byLogicalId = new Map();
  const aliasMap = new Map();

  const registerEntry = (entry = {}) => {
    const logicalAgentId = cleanId(entry.logical_agent_id);
    if (!logicalAgentId) return;
    if (!byLogicalId.has(logicalAgentId)) {
      byLogicalId.set(logicalAgentId, {
        logical_agent_id: logicalAgentId,
        representative_agent_id: cleanId(entry.representative_agent_id || logicalAgentId),
        command_ref: cleanId(entry.command_ref || entry.representative_agent_id || logicalAgentId),
        aliases: uniqIds(entry.aliases),
        raw_member_agent_ids: uniqIds(entry.raw_member_agent_ids),
        logical_agent: entry.logical_agent || null,
      });
    }
    const target = byLogicalId.get(logicalAgentId);
    target.representative_agent_id = cleanId(
      target.representative_agent_id
      || entry.representative_agent_id
      || logicalAgentId
    );
    target.command_ref = cleanId(
      target.command_ref
      || entry.command_ref
      || target.representative_agent_id
      || logicalAgentId
    );
    target.aliases = uniqIds([
      ...target.aliases,
      ...asArray(entry.aliases),
      target.command_ref,
      target.representative_agent_id,
    ]);
    target.raw_member_agent_ids = uniqIds([
      ...target.raw_member_agent_ids,
      ...asArray(entry.raw_member_agent_ids),
    ]);
    if (!target.logical_agent && entry.logical_agent) target.logical_agent = entry.logical_agent;
  };

  for (const logicalAgent of asArray(catalog.agents)) {
    registerEntry({
      logical_agent_id: logicalAgent.logical_agent_id,
      representative_agent_id: logicalAgent.representative_agent_id || logicalAgent.id,
      command_ref: logicalAgent.command_ref || logicalAgentCommandRef(logicalAgent),
      aliases: logicalAgent.logical_aliases,
      raw_member_agent_ids: logicalAgent.logical_member_agent_ids,
      logical_agent: logicalAgent,
    });
  }

  for (const membershipEntry of membership.byLogicalId instanceof Map
    ? membership.byLogicalId.values()
    : []) {
    registerEntry({
      logical_agent_id: membershipEntry.logical_agent_id,
      representative_agent_id: membershipEntry.representative_agent_id,
      command_ref: membershipEntry.command_ref,
      aliases: [
        membershipEntry.logical_agent_id,
        membershipEntry.command_ref,
        membershipEntry.representative_agent_id,
        ...asArray(membershipEntry.member_agent_ids),
        ...asArray(membershipEntry.member_agent_ids).map((id) => cleanId(id).slice(0, 8)),
      ],
      raw_member_agent_ids: membershipEntry.member_agent_ids,
      logical_agent: membershipEntry.logical_agent || null,
    });
  }

  for (const entry of byLogicalId.values()) {
    for (const alias of uniqIds(entry.aliases)) {
      if (!aliasMap.has(alias)) aliasMap.set(alias, new Set());
      aliasMap.get(alias).add(entry.logical_agent_id);
    }
  }

  return {
    agents: [...byLogicalId.values()],
    byLogicalId,
    aliasMap,
  };
}

function resolveAddressableLogicalAgent(agentRef = "", addressable = null) {
  const row = addressable && typeof addressable === "object"
    ? addressable
    : buildAddressableLogicalAgents();
  const query = cleanId(String(agentRef || "").replace(/^@+/, ""));
  if (!query) return null;

  const exactMatches = row.aliasMap instanceof Map && row.aliasMap.has(query)
    ? [...row.aliasMap.get(query)]
    : [];
  if (exactMatches.length === 1) {
    return row.byLogicalId.get(exactMatches[0]) || null;
  }
  if (exactMatches.length > 1) {
    return {
      ambiguous: true,
      candidates: exactMatches
        .map((logicalAgentId) => row.byLogicalId.get(logicalAgentId))
        .filter(Boolean),
    };
  }

  const resolved = resolveLogicalAgentRef(query, {
    agents: asArray(row.agents),
    byLogicalId: row.byLogicalId,
    aliasMap: row.aliasMap,
  });
  if (resolved?.logical_agent) {
    return row.byLogicalId.get(cleanId(resolved.logical_agent.logical_agent_id)) || null;
  }
  if (resolved?.ambiguous) {
    return {
      ambiguous: true,
      candidates: asArray(resolved.candidates),
    };
  }
  return null;
}

export function deriveConversationTeamView(runtime = {}, {
  conversationRows = null,
  catalogRows = null,
  baselineAgentIds = null,
} = {}) {
  const convRows = asArray(conversationRows ?? runtime?.conversationAgents);
  const catalog = asArray(catalogRows ?? runtime?.agentsCatalog);
  const explicitMemberRawAgentIds = uniqIds(
    convRows.map((row) => row?.agent_id || row?.agentId || row?.id)
  );
  const logicalCatalog = buildLogicalAgentCatalogIndex(catalog, {
    preferredRawIds: explicitMemberRawAgentIds,
  });
  const membershipIndex = buildLogicalMembershipIndex(convRows, logicalCatalog);
  const teamConsistency = reconcileConversationTeamWithCatalog({
    conversationRows: convRows,
    catalogRows: catalog,
  });
  const availableCatalogLogicalIds = asArray(logicalCatalog.agents)
    .map((agent) => cleanId(agent.logical_agent_id))
    .filter(Boolean);
  const availableCatalogLogicalSet = new Set(availableCatalogLogicalIds);
  const baselineDefaultLogicalIds = uniqIds(
    asArray(baselineAgentIds ?? runtime?.baselineDefaultAgentIds ?? [])
      .map((rawId) => {
        const cleanRawId = cleanId(rawId);
        return (logicalCatalog.rawIdToLogicalId instanceof Map && logicalCatalog.rawIdToLogicalId.has(cleanRawId))
          ? logicalCatalog.rawIdToLogicalId.get(cleanRawId)
          : cleanRawId;
      })
  );
  const explicitMemberLogicalIds = uniqIds(
    membershipIndex.byLogicalId instanceof Map
      ? [...membershipIndex.byLogicalId.keys()]
      : []
  );
  const explicitEnabledLogicalIds = explicitMemberLogicalIds.filter((logicalAgentId) => (
    asArray(membershipIndex.byLogicalId.get(logicalAgentId)?.enabled_member_agent_ids).length > 0
  ));
  const explicitDisabledLogicalIds = explicitMemberLogicalIds.filter((logicalAgentId) => (
    asArray(membershipIndex.byLogicalId.get(logicalAgentId)?.enabled_member_agent_ids).length === 0
  ));
  const explicitDisabledSet = new Set(explicitDisabledLogicalIds);
  const conversationPreferences = getRuntimeConversationPreferences(runtime);
  const suppressedRoleSet = new Set(asArray(conversationPreferences.suppressed_role_ids));
  const activeExplicitLogicalIds = availableCatalogLogicalIds.length > 0
    ? explicitEnabledLogicalIds.filter((logicalAgentId) => availableCatalogLogicalSet.has(logicalAgentId))
    : explicitEnabledLogicalIds;

  const logicalEntryFor = (logicalAgentId = "") => (
    logicalCatalog.byLogicalId.get(cleanId(logicalAgentId))
    || membershipIndex.byLogicalId.get(cleanId(logicalAgentId))
    || null
  );
  const representativeIdFor = (logicalAgentId = "") => cleanId(
    logicalEntryFor(logicalAgentId)?.representative_agent_id
    || logicalAgentId
  );
  const commandRefFor = (logicalAgentId = "") => cleanId(
    logicalEntryFor(logicalAgentId)?.command_ref
    || representativeIdFor(logicalAgentId)
    || logicalAgentId
  );
  const roleIdFor = (logicalAgentId = "") => normalizeWorkerRoleId(
    logicalEntryFor(logicalAgentId)?.logical_system_key
    || logicalEntryFor(logicalAgentId)?.command_ref
    || representativeIdFor(logicalAgentId)
    || logicalAgentId
  );
  const isSuppressedLogicalRole = (logicalAgentId = "") => {
    const roleId = roleIdFor(logicalAgentId);
    return !!(roleId && suppressedRoleSet.has(roleId));
  };

  const effectiveEnabledLogicalIds = uniqIds([
    ...baselineDefaultLogicalIds,
    ...activeExplicitLogicalIds,
  ]).filter((logicalAgentId) => !explicitDisabledSet.has(logicalAgentId) && !isSuppressedLogicalRole(logicalAgentId));
  const effectiveEnabledAgentIds = uniqIds(
    effectiveEnabledLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))
  );
  const availableNotExplicitLogicalIds = availableCatalogLogicalIds.filter((logicalAgentId) => (
    !explicitMemberLogicalIds.includes(logicalAgentId)
  ));
  const baselineDefaultSet = new Set(baselineDefaultLogicalIds);
  const optionalLogicalIds = availableCatalogLogicalIds.filter((logicalAgentId) => (
    !baselineDefaultSet.has(logicalAgentId) && !explicitMemberLogicalIds.includes(logicalAgentId)
  ));
  const enabledAgents = effectiveEnabledLogicalIds
    .map((logicalAgentId) => logicalCatalog.byLogicalId.get(logicalAgentId))
    .filter(Boolean);
  const lastActiveRunTeamRawAgentIds = deriveLastActiveRunTeamAgentIds(runtime);
  const lastActiveRunTeamLogicalIds = uniqIds(
    lastActiveRunTeamRawAgentIds.map((rawAgentId) => {
      const cleanRawId = cleanId(rawAgentId);
      return (logicalCatalog.rawIdToLogicalId instanceof Map && logicalCatalog.rawIdToLogicalId.has(cleanRawId))
        ? logicalCatalog.rawIdToLogicalId.get(cleanRawId)
        : cleanRawId;
    })
  );
  const addressableAgents = buildAddressableLogicalAgents(logicalCatalog, membershipIndex);

  return {
    conversationPreferences,
    teamConsistency,
    logicalCatalog,
    membershipIndex,
    addressableAgents,
    baselineDefaultLogicalIds,
    baselineDefaultAgentIds: uniqIds(baselineDefaultLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    baselineDefaultCommandRefs: uniqIds(baselineDefaultLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    explicitMemberLogicalIds,
    explicitMemberAgentIds: uniqIds(explicitMemberLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    explicitMemberCommandRefs: uniqIds(explicitMemberLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    explicitEnabledLogicalIds,
    explicitEnabledAgentIds: uniqIds(explicitEnabledLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    explicitEnabledCommandRefs: uniqIds(explicitEnabledLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    explicitDisabledLogicalIds,
    explicitDisabledAgentIds: uniqIds(explicitDisabledLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    explicitDisabledCommandRefs: uniqIds(explicitDisabledLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    effectiveEnabledAgentIds,
    effectiveEnabledLogicalIds,
    effectiveEnabledCommandRefs: uniqIds(effectiveEnabledLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    availableCatalogLogicalIds,
    availableCatalogAgentIds: uniqIds(availableCatalogLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    availableCatalogCommandRefs: uniqIds(availableCatalogLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    availableNotExplicitLogicalIds,
    availableNotExplicitAgentIds: uniqIds(availableNotExplicitLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    optionalLogicalIds,
    optionalAgentIds: uniqIds(optionalLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    optionalCommandRefs: uniqIds(optionalLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    unknownExplicitMemberAgentIds: membershipIndex.unknownRawAgentIds,
    explicitMemberRawAgentIds,
    lastActiveRunTeamLogicalIds,
    lastActiveRunTeamAgentIds: uniqIds(lastActiveRunTeamLogicalIds.map((logicalAgentId) => representativeIdFor(logicalAgentId))),
    lastActiveRunTeamCommandRefs: uniqIds(lastActiveRunTeamLogicalIds.map((logicalAgentId) => commandRefFor(logicalAgentId))),
    enabledAgents,
    logicalAgents: asArray(logicalCatalog.agents),
  };
}

async function resolveAgentFormatter({
  runtime = null,
  agentRegistry = null,
  targetAgentIds = [],
  buildAgentDisplayIndex = null,
  formatAgentRef = null,
  refreshAgentRegistry = null,
} = {}) {
  const buildIndex = typeof buildAgentDisplayIndex === "function"
    ? buildAgentDisplayIndex
    : () => new Map();
  let effectiveRegistry = agentRegistry;
  let agentIndex = buildIndex(agentRegistry, runtime);
  const missingTargets = asArray(targetAgentIds)
    .map((id) => cleanId(id))
    .filter(Boolean)
    .filter((id) => !(agentIndex instanceof Map ? agentIndex.has(id) : false));
  if (
    typeof refreshAgentRegistry === "function"
    && (agentIndex.size === 0 || missingTargets.length > 0)
  ) {
    const refreshedRegistry = await refreshAgentRegistry({ includeCompiled: true });
    effectiveRegistry = refreshedRegistry || effectiveRegistry;
    agentIndex = buildIndex(effectiveRegistry, runtime);
  }
  return {
    agentIndex,
    agentRegistry: effectiveRegistry,
    format: (agentId) => (
      typeof formatAgentRef === "function"
        ? formatAgentRef(agentId, agentIndex)
        : formatAgentRefDefault(agentId)
    ),
  };
}

export function summarizeMembershipMutationResponse(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  return {
    ok: row.ok === true ? true : undefined,
    id: String(row.id || "").trim() || undefined,
    thread_id: String(row.thread_id || row.threadId || "").trim() || undefined,
    conversation_id: String(row.conversation_id || row.conversationId || "").trim() || undefined,
    agent_id: cleanId(row.agent_id || row.agentId || ""),
    enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
  };
}

export function detectConversationTeamAuthoritySource(runtime = null) {
  const authority = buildRunAuthority(runtime);
  if (authority?.conversation_team_source === "goc") return "goc";
  const teamStoreSource = cleanId(runtime?.capabilities?.conversationTeamStore?.source || "");
  return teamStoreSource === "goc" ? "goc" : "local";
}

export function syncRuntimeConversationTeamState(runtime = {}, {
  conversationRows = [],
  membershipTarget = null,
  warningLines = [],
  summarizeSelectionState = null,
} = {}) {
  const convRows = asArray(conversationRows);
  const summarizeSelection = typeof summarizeSelectionState === "function"
    ? summarizeSelectionState
    : summarizeSelectionStateDefault;
  runtime.conversationAgents = convRows;
  const view = deriveConversationTeamView(runtime, {
    conversationRows: convRows,
  });
  runtime.logicalAgents = view.logicalAgents;
  runtime.baselineDefaultLogicalAgentIds = view.baselineDefaultLogicalIds;
  runtime.baselineDefaultAgentIds = view.baselineDefaultAgentIds;
  runtime.baselineDefaultAgentRefs = view.baselineDefaultCommandRefs;
  runtime.explicitConversationLogicalAgentIds = view.explicitMemberLogicalIds;
  runtime.explicitConversationAgentIds = view.explicitMemberAgentIds;
  runtime.explicitConversationAgentRefs = view.explicitMemberCommandRefs;
  runtime.explicitEnabledConversationLogicalAgentIds = view.explicitEnabledLogicalIds;
  runtime.explicitEnabledConversationAgentIds = view.explicitEnabledAgentIds;
  runtime.explicitEnabledConversationAgentRefs = view.explicitEnabledCommandRefs;
  runtime.explicitDisabledConversationLogicalAgentIds = view.explicitDisabledLogicalIds;
  runtime.explicitDisabledConversationAgentIds = view.explicitDisabledAgentIds;
  runtime.explicitDisabledConversationAgentRefs = view.explicitDisabledCommandRefs;
  runtime.enabledLogicalAgentIds = view.effectiveEnabledLogicalIds;
  runtime.enabledAgentIds = view.effectiveEnabledAgentIds;
  runtime.enabledAgentRefs = view.effectiveEnabledCommandRefs;
  runtime.unknownConversationAgentIds = view.unknownExplicitMemberAgentIds;
  if (membershipTarget && typeof membershipTarget === "object") {
    runtime.conversationMembershipTarget = summarizeMembershipTarget(membershipTarget);
    runtime.conversation = {
      id: String(membershipTarget?.conversation_id || runtime?.conversation?.id || "").trim(),
      thread_id: String(
        membershipTarget?.thread_id
        || runtime?.conversation?.thread_id
        || runtime?.map?.threadId
        || ""
      ).trim(),
    };
  }
  const warnings = asArray(warningLines)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (runtime.unknownConversationAgentIds.length > 0) {
    warnings.push(`unknown_explicit_members:${runtime.unknownConversationAgentIds.join(",")}`);
  }
  runtime.conversationMembershipWarning = warnings.join(" | ");
  runtime.agents = view.enabledAgents;
  runtime.agentSelection = summarizeSelection({
    catalog: asArray(runtime?.agentsCatalog),
    enabled: runtime.agents,
  });
  return {
    conversationAgents: convRows,
    enabledAgentIds: view.effectiveEnabledAgentIds,
    enabledAgentRefs: view.effectiveEnabledCommandRefs,
    baselineDefaultAgentIds: view.baselineDefaultAgentIds,
    baselineDefaultAgentRefs: view.baselineDefaultCommandRefs,
    explicitMemberAgentIds: view.explicitMemberAgentIds,
    explicitMemberAgentRefs: view.explicitMemberCommandRefs,
    membershipTarget: runtime.conversationMembershipTarget || null,
  };
}

export async function ensureRuntimeAgentCatalogRows(runtime = {}) {
  const existing = asArray(runtime?.agentsCatalog);
  if (existing.length > 0) return existing;
  const catalog = runtime?.capabilities?.agentCatalog;
  if (!catalog || typeof catalog.load !== "function") return existing;
  try {
    const loaded = await catalog.load({
      includeCompiled: true,
      refresh: false,
      fallbackToLocal: true,
    });
    const rows = asArray(loaded?.agents);
    if (rows.length > 0) runtime.agentsCatalog = rows;
    return rows;
  } catch {
    return existing;
  }
}

function normalizeWarningLines(values = []) {
  return asArray(values)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}

function formatAgentRefs(refs = [], { limit = 20 } = {}) {
  const rows = uniqIds(refs).slice(0, Math.max(1, Number(limit) || 20));
  return rows.map((ref) => humanizeRef(ref)).join(", ");
}

function formatPreferenceRefs(refs = [], { limit = 20 } = {}) {
  const rows = uniqIds(refs).slice(0, Math.max(1, Number(limit) || 20));
  return rows.map((ref) => humanizeRef(ref)).join(", ");
}

function buildMutationOptions(runtime = null, {
  jobId = "",
  source = "",
  agentId = "",
  enabled = true,
} = {}) {
  const threadId = String(
    runtime?.map?.threadId || runtime?.conversationMembershipTarget?.thread_id || ""
  ).trim();
  const conversationId = String(
    runtime?.conversationMembershipTarget?.conversation_id || runtime?.conversation?.id || ""
  ).trim();
  return {
    jobId: String(jobId || "").trim(),
    threadId,
    conversationId,
    membershipTarget: runtime?.conversationMembershipTarget || null,
    source: source || "conversation_team_mutation",
    agentId: cleanId(agentId),
    enabled: enabled !== false,
  };
}

async function applyConversationPreferenceAliasCommand({
  runtime = null,
  jobId = "",
  actionType = "",
  agentId = "",
  source = "",
} = {}) {
  if (!runtime || typeof runtime !== "object") throw new Error("runtime is required");
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore) throw new Error("conversation team store is unavailable");
  const catalogRows = await ensureRuntimeAgentCatalogRows(runtime);
  const options = buildMutationOptions(runtime, {
    jobId,
    source: source || "conversation_preference_mutation",
    agentId,
    enabled: actionType !== "disable",
  });
  const mutation = await applyConversationPreferenceMutation({
    teamStore,
    actionType,
    agentId,
    mutationOptions: options,
    catalogRows,
  });
  if (!mutation.ok) {
    throw createConversationTeamMutationValidationError(mutation.validation);
  }
  const preferences = normalizeConversationPreferences(mutation?.result?.preferences || {});
  runtime.conversationPreferences = preferences;
  runtime.conversation_preferences = preferences;
  return {
    preferences,
    target: mutation.target,
    agentRef: mutation?.target?.target_id || cleanId(agentId),
  };
}

function resolveConversationTeamCommandTarget(agentRef = "", teamView = {}) {
  const query = cleanId(String(agentRef || "").replace(/^@+/, ""));
  if (!query) return null;
  const resolved = resolveAddressableLogicalAgent(query, teamView.addressableAgents);
  if (resolved?.ambiguous) {
    const candidates = asArray(resolved.candidates)
      .map((row) => humanizeRef(row?.command_ref || row?.representative_agent_id || row?.logical_agent_id))
      .filter(Boolean);
    throw new Error(
      `Ambiguous team ref: ${humanizeRef(query)}. Candidates: ${candidates.join(", ") || "(none)"}`
    );
  }
  if (!resolved || typeof resolved !== "object") {
    return {
      logical_agent_id: query,
      command_ref: query,
      representative_agent_id: query,
      explicit_member_agent_ids: [],
      explicit_enabled_member_agent_ids: [],
      explicit_disabled_member_agent_ids: [],
      is_baseline: false,
      in_catalog: false,
    };
  }
  const logicalAgentId = cleanId(resolved.logical_agent_id);
  const membershipEntry = teamView?.membershipIndex?.byLogicalId instanceof Map
    ? (teamView.membershipIndex.byLogicalId.get(logicalAgentId) || null)
    : null;
  return {
    logical_agent_id: logicalAgentId,
    command_ref: cleanId(
      resolved.command_ref
      || membershipEntry?.command_ref
      || query
    ),
    representative_agent_id: cleanId(
      resolved.representative_agent_id
      || membershipEntry?.representative_agent_id
      || query
    ),
    explicit_member_agent_ids: uniqIds(membershipEntry?.member_agent_ids || []),
    explicit_enabled_member_agent_ids: uniqIds(membershipEntry?.enabled_member_agent_ids || []),
    explicit_disabled_member_agent_ids: uniqIds(membershipEntry?.disabled_member_agent_ids || []),
    is_baseline: asArray(teamView?.baselineDefaultLogicalIds).includes(logicalAgentId),
    in_catalog: asArray(teamView?.availableCatalogLogicalIds).includes(logicalAgentId),
  };
}

async function applyLogicalConversationAgentMutation({
  teamStore = null,
  actionType = "",
  logicalTarget = null,
  mutationOptions = {},
} = {}) {
  if (!teamStore || typeof teamStore !== "object") {
    throw new Error("teamStore is required");
  }
  const type = cleanId(actionType);
  const target = logicalTarget && typeof logicalTarget === "object" ? logicalTarget : {};
  const options = mutationOptions && typeof mutationOptions === "object" ? mutationOptions : {};
  const representativeAgentId = cleanId(target.representative_agent_id || options.agentId);
  const explicitMemberAgentIds = uniqIds(target.explicit_member_agent_ids || []);
  const operations = [];

  const runAdd = async (agentId, enabled = true) => {
    if (!agentId) return null;
    if (typeof teamStore.addAgent !== "function") {
      throw new Error("teamStore.addAgent is unavailable");
    }
    const result = await teamStore.addAgent({
      ...options,
      agentId,
      enabled,
    });
    operations.push(result);
    return result;
  };
  const runRemove = async (agentId) => {
    if (!agentId) return null;
    if (typeof teamStore.removeAgent !== "function") {
      throw new Error("teamStore.removeAgent is unavailable");
    }
    const result = await teamStore.removeAgent({
      ...options,
      agentId,
    });
    operations.push(result);
    return result;
  };
  const runSetEnabled = async (agentId, enabled) => {
    if (!agentId) return null;
    if (typeof teamStore.setAgentEnabled !== "function") {
      throw new Error("teamStore.setAgentEnabled is unavailable");
    }
    const result = await teamStore.setAgentEnabled({
      ...options,
      agentId,
      enabled: enabled !== false,
    });
    operations.push(result);
    return result;
  };

  if (type === "add") {
    if (explicitMemberAgentIds.length > 0) {
      for (const memberAgentId of explicitMemberAgentIds) {
        await runSetEnabled(memberAgentId, true);
      }
    } else {
      await runAdd(representativeAgentId, true);
    }
  } else if (type === "enable") {
    if (explicitMemberAgentIds.length > 0) {
      for (const memberAgentId of explicitMemberAgentIds) {
        await runSetEnabled(memberAgentId, true);
      }
    } else if (!target.is_baseline) {
      await runSetEnabled(representativeAgentId, true);
    }
  } else if (type === "disable") {
    const disableTargets = explicitMemberAgentIds.length > 0
      ? explicitMemberAgentIds
      : [representativeAgentId];
    for (const memberAgentId of disableTargets) {
      await runSetEnabled(memberAgentId, false);
    }
  } else if (type === "remove") {
    for (const memberAgentId of explicitMemberAgentIds) {
      await runRemove(memberAgentId);
    }
  } else {
    throw new Error(`unsupported action type: ${type}`);
  }

  const listed = typeof teamStore.listAgents === "function"
    ? await teamStore.listAgents({
      threadId: options.threadId,
      conversationId: options.conversationId,
      membershipTarget: options.membershipTarget,
      jobId: options.jobId,
      source: `${String(options.source || "conversation_team_mutation").trim() || "conversation_team_mutation"}_readback`,
    })
    : null;
  const lastOperation = operations.length > 0 ? operations[operations.length - 1] : null;
  return {
    target: listed?.target || lastOperation?.target || options.membershipTarget || null,
    rows: asArray(listed?.rows || lastOperation?.rows),
    warnings: normalizeWarningLines([
      ...normalizeWarningLines(listed?.warnings),
      ...operations.flatMap((result) => normalizeWarningLines(result?.warnings)),
    ]),
    mutation_response: lastOperation?.mutation_response || {
      ok: true,
      agent_id: representativeAgentId || undefined,
      no_op: operations.length === 0 ? true : undefined,
    },
    mutation_responses: operations
      .map((result) => result?.mutation_response)
      .filter(Boolean),
    no_op: operations.length === 0,
  };
}

function buildLogicalMutationVerification({
  actionType = "",
  logicalTarget = null,
  teamView = {},
  target = null,
  source = "",
  jobId = "",
  mutationResponse = null,
  mutationResponses = [],
} = {}) {
  const type = cleanId(actionType);
  const logicalAgentId = cleanId(logicalTarget?.logical_agent_id);
  const commandRef = cleanId(logicalTarget?.command_ref || logicalTarget?.representative_agent_id || logicalAgentId);
  const explicitPresent = asArray(teamView?.explicitMemberLogicalIds).includes(logicalAgentId);
  const explicitEnabled = asArray(teamView?.explicitEnabledLogicalIds).includes(logicalAgentId);
  const explicitDisabled = asArray(teamView?.explicitDisabledLogicalIds).includes(logicalAgentId);
  const effectiveEnabled = asArray(teamView?.effectiveEnabledLogicalIds).includes(logicalAgentId);

  let confirmed = false;
  if (type === "add") confirmed = explicitPresent && effectiveEnabled;
  else if (type === "enable") confirmed = effectiveEnabled;
  else if (type === "disable") confirmed = explicitDisabled && !effectiveEnabled;
  else if (type === "remove") confirmed = !explicitPresent && (logicalTarget?.is_baseline === true ? true : !effectiveEnabled);

  return {
    action: type === "add"
      ? "add_agent_to_conversation"
      : (type === "remove" ? "remove_agent_from_conversation" : `${type}_agent`),
    thread_id: String(target?.thread_id || "").trim(),
    conversation_id: String(target?.conversation_id || "").trim(),
    target_agent_id: commandRef,
    target_logical_agent_id: logicalAgentId,
    expected_present: type !== "remove",
    expected_enabled: type === "disable" ? false : (type === "remove" ? null : true),
    confirmed,
    source: String(source || "").trim() || undefined,
    readback: {
      explicit_present: explicitPresent,
      explicit_enabled: explicitEnabled,
      explicit_disabled: explicitDisabled,
      effective_enabled: effectiveEnabled,
      explicit_member_refs: asArray(teamView?.explicitMemberCommandRefs),
      effective_enabled_refs: asArray(teamView?.effectiveEnabledCommandRefs),
    },
    job_id: String(jobId || "").trim() || undefined,
    membership_target: summarizeMembershipTarget(target || {}),
    ensured_thread_mismatch: target?.ensured_thread_mismatch === true,
    mutation_response: summarizeMembershipMutationResponse(mutationResponse),
    mutation_responses: asArray(mutationResponses).map((row) => summarizeMembershipMutationResponse(row)),
  };
}

export async function applyConversationAgentMutation({
  runtime = null,
  jobId = "",
  actionType = "",
  agentId = "",
  source = "",
  enabled = true,
  summarizeSelectionState = null,
  recordDiagnostic = null,
} = {}) {
  const cleanActionType = cleanId(actionType);
  const cleanAgentId = cleanId(agentId);
  const cleanJobId = String(jobId || "").trim();
  if (!runtime || typeof runtime !== "object") throw new Error("runtime is required");
  if (!cleanJobId) throw new Error("jobId is required");
  if (!cleanAgentId) throw new Error("agent_id is required");
  if (!["add", "remove", "enable", "disable"].includes(cleanActionType)) {
    throw new Error(`unsupported action type: ${cleanActionType}`);
  }

  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore) throw new Error("conversation team store is unavailable");
  const catalogRows = await ensureRuntimeAgentCatalogRows(runtime);
  const preMutationView = deriveConversationTeamView(runtime, {
    conversationRows: asArray(runtime?.conversationAgents),
    catalogRows,
  });
  const resolvedTarget = resolveConversationTeamCommandTarget(cleanAgentId, preMutationView);
  const options = buildMutationOptions(runtime, {
    jobId: cleanJobId,
    source: source || "conversation_team_mutation",
    agentId: resolvedTarget?.representative_agent_id || cleanAgentId,
    enabled,
  });
  const conversationTeamSource = detectConversationTeamAuthoritySource(runtime);
  let mutation = null;
  if (conversationTeamSource === "local") {
    mutation = await applyValidatedConversationTeamMutation({
      teamStore,
      actionType: cleanActionType,
      agentId: resolvedTarget?.representative_agent_id || cleanAgentId,
      mutationOptions: options,
      catalogRows,
      requireCatalogValidation: true,
    });
    if (!mutation.ok) {
      throw createConversationTeamMutationValidationError(mutation.validation);
    }
  } else {
    mutation = {
      ok: true,
      result: await applyLogicalConversationAgentMutation({
        teamStore,
        actionType: cleanActionType,
        logicalTarget: resolvedTarget,
        mutationOptions: options,
      }),
    };
  }

  const result = mutation.result;
  const convRows = asArray(result?.rows);
  const target = result?.target && typeof result.target === "object"
    ? result.target
    : runtime?.conversationMembershipTarget
      || {
        thread_id: options.threadId,
        conversation_id: options.conversationId,
        source: runtime?.mode === "goc" ? "goc" : "local",
      };
  const postMutationView = deriveConversationTeamView({
    ...runtime,
    agentsCatalog: catalogRows,
    conversationAgents: convRows,
  }, {
    conversationRows: convRows,
    catalogRows,
    baselineAgentIds: runtime?.baselineDefaultAgentIds || [],
  });
  const verification = conversationTeamSource === "local"
    ? verifyConversationMembershipMutation({
      actionType: cleanActionType === "add"
        ? "add_agent_to_conversation"
        : (cleanActionType === "remove" ? "remove_agent_from_conversation" : `${cleanActionType}_agent`),
      threadId: String(target?.thread_id || options.threadId || "").trim(),
      conversationId: String(target?.conversation_id || options.conversationId || "").trim(),
      targetAgentId: resolvedTarget?.representative_agent_id || cleanAgentId,
      expectedPresent: cleanActionType !== "remove",
      expectedEnabled: cleanActionType === "disable" ? false : true,
      conversationRows: convRows,
      source: source || "conversation_team_mutation",
      extra: {
        job_id: cleanJobId,
        membership_target: summarizeMembershipTarget(target),
        ensured_thread_mismatch: target?.ensured_thread_mismatch === true,
        mutation_response: summarizeMembershipMutationResponse(result?.mutation_response),
      },
    })
    : buildLogicalMutationVerification({
      actionType: cleanActionType,
      logicalTarget: resolvedTarget,
      teamView: postMutationView,
      target,
      source: source || "conversation_team_mutation",
      jobId: cleanJobId,
      mutationResponse: result?.mutation_response,
      mutationResponses: result?.mutation_responses,
    });
  if (!verification.confirmed) {
    if (typeof recordDiagnostic === "function") {
      recordDiagnostic(cleanJobId, verification, {
        stage: "membership_confirmation_failed",
      });
    }
    throw createMembershipConfirmationError(verification);
  }

  syncRuntimeConversationTeamState(runtime, {
    conversationRows: convRows,
    membershipTarget: target,
    warningLines: asArray(result?.warnings),
    summarizeSelectionState,
  });
  return {
    convRows,
    target,
    verification,
    mutationResponse: result?.mutation_response || null,
    warnings: asArray(result?.warnings),
    agentRef: resolvedTarget?.command_ref || cleanAgentId,
    agentId: resolvedTarget?.representative_agent_id || cleanAgentId,
    teamView: postMutationView,
  };
}

export async function runConversationAgentTeamCommand({
  command = "list",
  runtime = null,
  jobId = "",
  agentId = "",
  source = "",
  agentRegistry = null,
  buildAgentDisplayIndex = null,
  formatAgentRef = null,
  refreshAgentRegistry = null,
  summarizeSelectionState = null,
  recordDiagnostic = null,
} = {}) {
  const cleanCommand = cleanId(command) || "list";
  const cleanJobId = String(jobId || "").trim();
  if (!runtime || typeof runtime !== "object") throw new Error("runtime is required");
  let mutationResult = null;

  if (["add", "remove", "enable", "disable"].includes(cleanCommand)) {
    mutationResult = await applyConversationPreferenceAliasCommand({
      runtime,
      jobId: cleanJobId,
      actionType: cleanCommand,
      agentId,
      source: source || "conversation_team_command",
    });
  }

  const updated = asArray(runtime?.conversationAgents);
  const teamView = deriveConversationTeamView(runtime, {
    conversationRows: updated,
  });
  const preferences = teamView.conversationPreferences;
  const targetAgentRef = cleanId(mutationResult?.agentRef || agentId);

  if (cleanCommand === "list") {
    const authority = buildRunAuthority(runtime);
    return {
      ok: true,
      type: "list",
      command: cleanCommand,
      message: [
        "Current team & preset state",
        `- job_id: ${cleanJobId}`,
        `- thread_id: ${String(runtime?.map?.threadId || "").trim() || "(none)"}`,
        `- conversation_id: ${String(runtime?.conversationMembershipTarget?.conversation_id || runtime?.conversation?.id || "").trim() || "(none)"}`,
        teamView.baselineDefaultCommandRefs.length > 0
          ? `- baseline_defaults: ${formatAgentRefs(teamView.baselineDefaultCommandRefs, { limit: 20 })}`
          : "- baseline_defaults: (none)",
        teamView.effectiveEnabledCommandRefs.length > 0
          ? `- effective_team_view: ${formatAgentRefs(teamView.effectiveEnabledCommandRefs, { limit: 20 })}`
          : "- effective_team_view: (none)",
        preferences.pinned_preset_ids.length > 0
          ? `- pinned_presets: ${formatPreferenceRefs(preferences.pinned_preset_ids, { limit: 20 })}`
          : "- pinned_presets: (none)",
        preferences.banned_preset_ids.length > 0
          ? `- banned_presets: ${formatPreferenceRefs(preferences.banned_preset_ids, { limit: 20 })}`
          : "- banned_presets: (none)",
        preferences.suppressed_role_ids.length > 0
          ? `- suppressed_roles: ${formatPreferenceRefs(preferences.suppressed_role_ids, { limit: 20 })}`
          : "- suppressed_roles: (none)",
        preferences.suppressed_skill_ids.length > 0
          ? `- suppressed_skills: ${formatPreferenceRefs(preferences.suppressed_skill_ids, { limit: 20 })}`
          : "",
        preferences.preferred_domains.length > 0
          ? `- preferred_domains: ${preferences.preferred_domains.join(", ")}`
          : "",
        preferences.preferred_locales.length > 0
          ? `- preferred_locales: ${preferences.preferred_locales.join(", ")}`
          : "",
        preferences.default_control_mode
          ? `- default_control_mode: ${preferences.default_control_mode}`
          : "",
        preferences.reviewer_policy
          ? `- reviewer_policy: ${preferences.reviewer_policy}`
          : "",
        preferences.max_parallel_slots > 0
          ? `- max_parallel_slots: ${preferences.max_parallel_slots}`
          : "",
        teamView.explicitEnabledCommandRefs.length > 0
          ? `- legacy_explicit_enabled: ${formatAgentRefs(teamView.explicitEnabledCommandRefs, { limit: 20 })}`
          : "",
        teamView.explicitDisabledCommandRefs.length > 0
          ? `- legacy_explicit_disabled: ${formatAgentRefs(teamView.explicitDisabledCommandRefs, { limit: 20 })}`
          : "",
        teamView.unknownExplicitMemberAgentIds.length > 0
          ? `- unknown_explicit_members: ${formatAgentRefs(teamView.unknownExplicitMemberAgentIds, { limit: 20 })}`
          : "",
        teamView.availableCatalogCommandRefs.length > 0
          ? `- available_presets: ${formatAgentRefs(teamView.availableCatalogCommandRefs, { limit: 30 })}`
          : "- available_presets: (none)",
        teamView.optionalCommandRefs.length > 0
          ? `- optional_presets: ${formatAgentRefs(teamView.optionalCommandRefs, { limit: 30 })}`
          : "- optional_presets: (none)",
        teamView.lastActiveRunTeamCommandRefs.length > 0
          ? `- last_active_run_team: ${formatAgentRefs(teamView.lastActiveRunTeamCommandRefs, { limit: 20 })}`
          : "",
        runtime?.conversationMembershipWarning
          ? `- warnings: ${String(runtime.conversationMembershipWarning || "").trim()}`
          : "",
        authority?.mode === "goc"
          ? "명령: /team | /team add <preset_or_role_ref> | /team remove <preset_or_role_ref> | /team enable <preset_or_role_ref> | /team disable <preset_or_role_ref> | /catalog [query] | /agents (legacy alias)"
          : "명령: /team | /team add <preset_or_role_ref> | /team remove <preset_or_role_ref> | /team enable <preset_or_role_ref> | /team disable <preset_or_role_ref> | /catalog [query] | /agents (legacy alias)",
      ].filter(Boolean).join("\n"),
      conversation_preferences: preferences,
      baselineDefaultAgentIds: teamView.baselineDefaultAgentIds,
      baselineDefaultAgentRefs: teamView.baselineDefaultCommandRefs,
      enabledAgentIds: teamView.effectiveEnabledAgentIds,
      enabledAgentRefs: teamView.effectiveEnabledCommandRefs,
      explicitEnabledAgentIds: teamView.explicitEnabledAgentIds,
      explicitEnabledAgentRefs: teamView.explicitEnabledCommandRefs,
      explicitDisabledAgentIds: teamView.explicitDisabledAgentIds,
      explicitDisabledAgentRefs: teamView.explicitDisabledCommandRefs,
      availableAgentIds: teamView.availableCatalogAgentIds,
      availableAgentRefs: teamView.availableCatalogCommandRefs,
      unknownMembers: teamView.unknownExplicitMemberAgentIds,
      optionalAgentIds: teamView.optionalAgentIds,
      optionalAgentRefs: teamView.optionalCommandRefs,
      notInTeamAgentIds: teamView.availableNotExplicitAgentIds,
      lastActiveRunTeamAgentIds: teamView.lastActiveRunTeamAgentIds,
      lastActiveRunTeamAgentRefs: teamView.lastActiveRunTeamCommandRefs,
    };
  }

  return {
    ok: true,
    type: "mutation",
    command: cleanCommand,
    message: [
      `✅ Team preference ${actionVerb(cleanCommand)} complete`,
      `- job_id: ${cleanJobId}`,
      `- target: ${humanizeRef(targetAgentRef || cleanId(agentId) || "unknown")}`,
      preferences.pinned_preset_ids.length > 0
        ? `- pinned_presets: ${formatPreferenceRefs(preferences.pinned_preset_ids, { limit: 20 })}`
        : "- pinned_presets: (none)",
      preferences.banned_preset_ids.length > 0
        ? `- banned_presets: ${formatPreferenceRefs(preferences.banned_preset_ids, { limit: 20 })}`
        : "- banned_presets: (none)",
      preferences.suppressed_role_ids.length > 0
        ? `- suppressed_roles: ${formatPreferenceRefs(preferences.suppressed_role_ids, { limit: 20 })}`
        : "- suppressed_roles: (none)",
      teamView.effectiveEnabledCommandRefs.length > 0
        ? `- effective_team_view: ${formatAgentRefs(teamView.effectiveEnabledCommandRefs, { limit: 20 })}`
        : "- effective_team_view: (none)",
    ].join("\n"),
    conversation_preferences: preferences,
    baselineDefaultAgentIds: teamView.baselineDefaultAgentIds,
    baselineDefaultAgentRefs: teamView.baselineDefaultCommandRefs,
    enabledAgentIds: teamView.effectiveEnabledAgentIds,
    enabledAgentRefs: teamView.effectiveEnabledCommandRefs,
    explicitEnabledAgentIds: teamView.explicitEnabledAgentIds,
    explicitEnabledAgentRefs: teamView.explicitEnabledCommandRefs,
    explicitDisabledAgentIds: teamView.explicitDisabledAgentIds,
    explicitDisabledAgentRefs: teamView.explicitDisabledCommandRefs,
    availableAgentIds: teamView.availableCatalogAgentIds,
    availableAgentRefs: teamView.availableCatalogCommandRefs,
    unknownMembers: teamView.unknownExplicitMemberAgentIds,
    optionalAgentIds: teamView.optionalAgentIds,
    optionalAgentRefs: teamView.optionalCommandRefs,
    notInTeamAgentIds: teamView.availableNotExplicitAgentIds,
  };
}
