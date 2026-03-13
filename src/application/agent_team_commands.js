import {
  applyValidatedConversationTeamMutation,
  createConversationTeamMutationValidationError,
  reconcileConversationTeamWithCatalog,
} from "./conversation_team_mutation.js";
import {
  createMembershipConfirmationError,
  verifyConversationMembershipMutation,
} from "./membership_confirmation.js";
import { summarizeMembershipTarget } from "./membership_target.js";
import { buildRunAuthority } from "./run_authority.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
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
  return `@${cleanId(agentId) || "unknown"}`;
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
  const teamConsistency = reconcileConversationTeamWithCatalog({
    conversationRows: convRows,
    catalogRows: asArray(runtime?.agentsCatalog),
  });
  const enabledAgentIds = enabledAgentIdsFromConsistency(teamConsistency);
  const enabledSet = new Set(enabledAgentIds);
  const summarizeSelection = typeof summarizeSelectionState === "function"
    ? summarizeSelectionState
    : summarizeSelectionStateDefault;
  runtime.conversationAgents = convRows;
  runtime.enabledAgentIds = enabledAgentIds;
  runtime.unknownConversationAgentIds = asArray(teamConsistency.unknown_member_agent_ids);
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
    warnings.push(`unknown_catalog_agents:${runtime.unknownConversationAgentIds.join(",")}`);
  }
  runtime.conversationMembershipWarning = warnings.join(" | ");
  runtime.agents = asArray(runtime?.agentsCatalog)
    .filter((agent) => enabledSet.has(cleanId(agent?.id || "")));
  runtime.agentSelection = summarizeSelection({
    catalog: asArray(runtime?.agentsCatalog),
    enabled: runtime.agents,
  });
  return {
    conversationAgents: convRows,
    enabledAgentIds,
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
  const threadId = String(
    runtime?.map?.threadId || runtime?.conversationMembershipTarget?.thread_id || ""
  ).trim();
  const conversationId = String(
    runtime?.conversationMembershipTarget?.conversation_id || runtime?.conversation?.id || ""
  ).trim();
  const options = {
    jobId: cleanJobId,
    threadId,
    conversationId,
    membershipTarget: runtime?.conversationMembershipTarget || null,
    source: source || "conversation_team_mutation",
    agentId: cleanAgentId,
    enabled: enabled !== false,
  };
  const conversationTeamSource = detectConversationTeamAuthoritySource(runtime);
  const mutation = await applyValidatedConversationTeamMutation({
    teamStore,
    actionType: cleanActionType,
    agentId: cleanAgentId,
    mutationOptions: options,
    catalogRows: conversationTeamSource === "local"
      ? await ensureRuntimeAgentCatalogRows(runtime)
      : [],
    requireCatalogValidation: conversationTeamSource === "local",
  });
  if (!mutation.ok) {
    throw createConversationTeamMutationValidationError(mutation.validation);
  }

  const result = mutation.result;
  const convRows = asArray(result?.rows);
  const target = result?.target && typeof result.target === "object"
    ? result.target
    : runtime?.conversationMembershipTarget
      || {
        thread_id: threadId,
        conversation_id: conversationId,
        source: runtime?.mode === "goc" ? "goc" : "local",
      };
  const verification = verifyConversationMembershipMutation({
    actionType: cleanActionType === "add"
      ? "add_agent_to_conversation"
      : (cleanActionType === "remove" ? "remove_agent_from_conversation" : `${cleanActionType}_agent`),
    threadId: String(target?.thread_id || threadId || "").trim(),
    conversationId: String(target?.conversation_id || conversationId || "").trim(),
    targetAgentId: cleanAgentId,
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

  if (["add", "remove", "enable", "disable"].includes(cleanCommand)) {
    await applyConversationAgentMutation({
      runtime,
      jobId: cleanJobId,
      actionType: cleanCommand,
      agentId,
      enabled: cleanCommand !== "disable",
      source: source || "conversation_team_command",
      summarizeSelectionState,
      recordDiagnostic,
    });
  }

  const updated = asArray(runtime?.conversationAgents);
  const allAgentIds = Array.from(new Set(
    updated.map((row) => cleanId(row?.agent_id || row?.agentId || "")).filter(Boolean)
  ));
  const enabledAgentIds = Array.from(new Set(
    updated
      .filter((row) => row?.enabled !== false)
      .map((row) => cleanId(row?.agent_id || row?.agentId || ""))
      .filter(Boolean)
  ));
  const disabledAgentIds = allAgentIds.filter((id) => !enabledAgentIds.includes(id));
  const availableAgentIds = Array.from(new Set(
    asArray(runtime?.agentsCatalog)
      .map((row) => cleanId(row?.id || row?.agent_id || row?.agentId || ""))
      .filter(Boolean)
  ));
  const availableSet = new Set(availableAgentIds);
  const unknownMembers = allAgentIds.filter((id) => !availableSet.has(id));
  const notInTeamAgentIds = availableAgentIds.filter((id) => !allAgentIds.includes(id));
  const targetAgentIds = cleanCommand === "list"
    ? [...enabledAgentIds, ...allAgentIds, ...availableAgentIds]
    : [agentId, ...enabledAgentIds, ...disabledAgentIds, ...availableAgentIds];
  const { format } = await resolveAgentFormatter({
    runtime,
    agentRegistry,
    targetAgentIds,
    buildAgentDisplayIndex,
    formatAgentRef,
    refreshAgentRegistry,
  });

  if (cleanCommand === "list") {
    const authority = buildRunAuthority(runtime);
    return {
      ok: true,
      type: "list",
      command: cleanCommand,
      message: [
        "현재 conversation membership",
        `- job_id: ${cleanJobId}`,
        `- thread_id: ${String(runtime?.map?.threadId || "").trim() || "(none)"}`,
        `- conversation_id: ${String(runtime?.conversationMembershipTarget?.conversation_id || runtime?.conversation?.id || "").trim() || "(none)"}`,
        enabledAgentIds.length > 0
          ? `- enabled: ${enabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- enabled: (none)",
        disabledAgentIds.length > 0
          ? `- disabled: ${disabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- disabled: (none)",
        unknownMembers.length > 0
          ? `- unknown_catalog_members: ${unknownMembers.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "",
        availableAgentIds.length > 0
          ? `- available_catalog: ${availableAgentIds.slice(0, 30).map((id) => format(id)).join(", ")}`
          : "- available_catalog: (none)",
        notInTeamAgentIds.length > 0
          ? `- not_in_team: ${notInTeamAgentIds.slice(0, 30).map((id) => format(id)).join(", ")}`
          : "- not_in_team: (none)",
        runtime?.conversationMembershipWarning
          ? `- warning: ${String(runtime.conversationMembershipWarning || "").trim()}`
          : "",
        authority?.mode === "goc"
          ? "명령: /agents registry | /agents public [query] | /agents add <id> | /agents remove <id> | /agents enable <id> | /agents disable <id>"
          : "명령: /agents registry | /agents add <id> | /agents remove <id> | /agents enable <id> | /agents disable <id>",
      ].filter(Boolean).join("\n"),
      enabledAgentIds,
      disabledAgentIds,
      availableAgentIds,
      unknownMembers,
      notInTeamAgentIds,
    };
  }

  return {
    ok: true,
    type: "mutation",
    command: cleanCommand,
    message: [
      `✅ conversation agent ${actionVerb(cleanCommand)} 완료`,
      `- job_id: ${cleanJobId}`,
      `- agent: ${format(agentId)}`,
      enabledAgentIds.length > 0
        ? `- enabled: ${enabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
        : "- enabled: (none)",
      disabledAgentIds.length > 0
        ? `- disabled: ${disabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
        : "- disabled: (none)",
    ].join("\n"),
    enabledAgentIds,
    disabledAgentIds,
    availableAgentIds,
    unknownMembers,
    notInTeamAgentIds,
  };
}
