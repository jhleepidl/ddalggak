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

export function deriveConversationTeamView(runtime = {}, {
  conversationRows = null,
  catalogRows = null,
  baselineAgentIds = null,
} = {}) {
  const convRows = asArray(conversationRows ?? runtime?.conversationAgents);
  const catalog = asArray(catalogRows ?? runtime?.agentsCatalog);
  const teamConsistency = reconcileConversationTeamWithCatalog({
    conversationRows: convRows,
    catalogRows: catalog,
  });
  const explicitMemberAgentIds = uniqIds(teamConsistency.member_agent_ids);
  const explicitEnabledAgentIds = uniqIds(teamConsistency.enabled_member_agent_ids);
  const explicitDisabledSet = new Set(
    explicitMemberAgentIds.filter((id) => !explicitEnabledAgentIds.includes(id))
  );
  const baselineDefaultAgentIds = uniqIds(
    baselineAgentIds ?? runtime?.baselineDefaultAgentIds ?? []
  );
  const effectiveEnabledAgentIds = uniqIds([
    ...baselineDefaultAgentIds,
    ...enabledAgentIdsFromConsistency(teamConsistency),
  ]).filter((id) => !explicitDisabledSet.has(id));
  const availableCatalogAgentIds = uniqIds(
    catalog.map((row) => row?.id || row?.agent_id || row?.agentId)
  );
  const availableCatalogSet = new Set(availableCatalogAgentIds);
  const unknownExplicitMemberAgentIds = explicitMemberAgentIds.filter((id) => !availableCatalogSet.has(id));
  const availableNotExplicitAgentIds = availableCatalogAgentIds.filter((id) => !explicitMemberAgentIds.includes(id));
  const baselineDefaultSet = new Set(baselineDefaultAgentIds);
  const optionalAgentIds = availableCatalogAgentIds.filter((id) => (
    !baselineDefaultSet.has(id) && !explicitMemberAgentIds.includes(id)
  ));
  const effectiveEnabledSet = new Set(effectiveEnabledAgentIds);
  const enabledAgents = catalog.filter((agent) => effectiveEnabledSet.has(cleanId(agent?.id || agent?.agent_id || agent?.agentId)));
  const lastActiveRunTeamAgentIds = deriveLastActiveRunTeamAgentIds(runtime);

  return {
    teamConsistency,
    baselineDefaultAgentIds,
    explicitMemberAgentIds,
    explicitEnabledAgentIds,
    explicitDisabledAgentIds: explicitMemberAgentIds.filter((id) => explicitDisabledSet.has(id)),
    effectiveEnabledAgentIds,
    availableCatalogAgentIds,
    availableNotExplicitAgentIds,
    optionalAgentIds,
    unknownExplicitMemberAgentIds,
    lastActiveRunTeamAgentIds,
    enabledAgents,
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
  runtime.baselineDefaultAgentIds = view.baselineDefaultAgentIds;
  runtime.explicitConversationAgentIds = view.explicitMemberAgentIds;
  runtime.explicitEnabledConversationAgentIds = view.explicitEnabledAgentIds;
  runtime.explicitDisabledConversationAgentIds = view.explicitDisabledAgentIds;
  runtime.enabledAgentIds = view.effectiveEnabledAgentIds;
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
    baselineDefaultAgentIds: view.baselineDefaultAgentIds,
    explicitMemberAgentIds: view.explicitMemberAgentIds,
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
  const teamView = deriveConversationTeamView(runtime, {
    conversationRows: updated,
  });
  const targetAgentIds = cleanCommand === "list"
    ? [
      ...teamView.effectiveEnabledAgentIds,
      ...teamView.explicitMemberAgentIds,
      ...teamView.availableCatalogAgentIds,
      ...teamView.lastActiveRunTeamAgentIds,
    ]
    : [
      agentId,
      ...teamView.effectiveEnabledAgentIds,
      ...teamView.explicitMemberAgentIds,
      ...teamView.availableCatalogAgentIds,
    ];
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
        "현재 agent/team 상태",
        `- job_id: ${cleanJobId}`,
        `- thread_id: ${String(runtime?.map?.threadId || "").trim() || "(none)"}`,
        `- conversation_id: ${String(runtime?.conversationMembershipTarget?.conversation_id || runtime?.conversation?.id || "").trim() || "(none)"}`,
        teamView.baselineDefaultAgentIds.length > 0
          ? `- baseline_defaults: ${teamView.baselineDefaultAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- baseline_defaults: (none)",
        teamView.explicitEnabledAgentIds.length > 0
          ? `- explicit_enabled: ${teamView.explicitEnabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- explicit_enabled: (none)",
        teamView.explicitDisabledAgentIds.length > 0
          ? `- explicit_disabled: ${teamView.explicitDisabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- explicit_disabled: (none)",
        teamView.effectiveEnabledAgentIds.length > 0
          ? `- effective_enabled: ${teamView.effectiveEnabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "- effective_enabled: (none)",
        teamView.unknownExplicitMemberAgentIds.length > 0
          ? `- unknown_explicit_members: ${teamView.unknownExplicitMemberAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "",
        teamView.availableCatalogAgentIds.length > 0
          ? `- available_catalog: ${teamView.availableCatalogAgentIds.slice(0, 30).map((id) => format(id)).join(", ")}`
          : "- available_catalog: (none)",
        teamView.optionalAgentIds.length > 0
          ? `- optional_members: ${teamView.optionalAgentIds.slice(0, 30).map((id) => format(id)).join(", ")}`
          : "- optional_members: (none)",
        teamView.lastActiveRunTeamAgentIds.length > 0
          ? `- last_active_run_team: ${teamView.lastActiveRunTeamAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
          : "",
        runtime?.conversationMembershipWarning
          ? `- warnings: ${String(runtime.conversationMembershipWarning || "").trim()}`
          : "",
        authority?.mode === "goc"
          ? "명령: /agents registry | /agents public [query] | /agents add <id> | /agents remove <id> | /agents enable <id> | /agents disable <id>"
          : "명령: /agents registry | /agents add <id> | /agents remove <id> | /agents enable <id> | /agents disable <id>",
      ].filter(Boolean).join("\n"),
      baselineDefaultAgentIds: teamView.baselineDefaultAgentIds,
      enabledAgentIds: teamView.effectiveEnabledAgentIds,
      explicitEnabledAgentIds: teamView.explicitEnabledAgentIds,
      explicitDisabledAgentIds: teamView.explicitDisabledAgentIds,
      availableAgentIds: teamView.availableCatalogAgentIds,
      unknownMembers: teamView.unknownExplicitMemberAgentIds,
      optionalAgentIds: teamView.optionalAgentIds,
      notInTeamAgentIds: teamView.availableNotExplicitAgentIds,
      lastActiveRunTeamAgentIds: teamView.lastActiveRunTeamAgentIds,
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
      teamView.effectiveEnabledAgentIds.length > 0
        ? `- effective_enabled: ${teamView.effectiveEnabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
        : "- effective_enabled: (none)",
      teamView.explicitDisabledAgentIds.length > 0
        ? `- explicit_disabled: ${teamView.explicitDisabledAgentIds.slice(0, 20).map((id) => format(id)).join(", ")}`
        : "- explicit_disabled: (none)",
    ].join("\n"),
    baselineDefaultAgentIds: teamView.baselineDefaultAgentIds,
    enabledAgentIds: teamView.effectiveEnabledAgentIds,
    explicitEnabledAgentIds: teamView.explicitEnabledAgentIds,
    explicitDisabledAgentIds: teamView.explicitDisabledAgentIds,
    availableAgentIds: teamView.availableCatalogAgentIds,
    unknownMembers: teamView.unknownExplicitMemberAgentIds,
    optionalAgentIds: teamView.optionalAgentIds,
    notInTeamAgentIds: teamView.availableNotExplicitAgentIds,
  };
}
