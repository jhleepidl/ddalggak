function normalizeRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      agent_id: String(row?.agent_id || row?.agentId || "").trim().toLowerCase(),
      enabled: row?.enabled !== false,
    }))
    .filter((row) => row.agent_id);
}

export function summarizeConversationReadback(rows = [], { targetAgentId = "" } = {}) {
  const normalizedRows = normalizeRows(rows);
  const target = String(targetAgentId || "").trim().toLowerCase();
  const enabled = normalizedRows.filter((row) => row.enabled).map((row) => row.agent_id);
  const disabled = normalizedRows.filter((row) => !row.enabled).map((row) => row.agent_id);
  const targetRow = normalizedRows.find((row) => row.agent_id === target) || null;
  return {
    total: normalizedRows.length,
    enabled_count: enabled.length,
    disabled_count: disabled.length,
    enabled_sample: enabled.slice(0, 12),
    disabled_sample: disabled.slice(0, 12),
    target_present: !!targetRow,
    target_enabled: targetRow ? targetRow.enabled === true : false,
  };
}

export function verifyConversationMembershipMutation({
  actionType = "",
  threadId = "",
  targetAgentId = "",
  expectedPresent = true,
  expectedEnabled = true,
  conversationRows = [],
  source = "",
  extra = {},
} = {}) {
  const cleanAction = String(actionType || "").trim().toLowerCase();
  const cleanThreadId = String(threadId || "").trim();
  const cleanTarget = String(targetAgentId || "").trim().toLowerCase();
  const summary = summarizeConversationReadback(conversationRows, {
    targetAgentId: cleanTarget,
  });
  const confirmed = expectedPresent
    ? (summary.target_present && summary.target_enabled === (expectedEnabled === true))
    : !summary.target_present;
  return {
    action: cleanAction || "membership_mutation",
    thread_id: cleanThreadId,
    target_agent_id: cleanTarget,
    expected_present: expectedPresent === true,
    expected_enabled: expectedPresent ? (expectedEnabled === true) : null,
    confirmed,
    source: String(source || "").trim() || undefined,
    readback: summary,
    ...((extra && typeof extra === "object") ? extra : {}),
  };
}

export function createMembershipConfirmationError(diagnostic = {}) {
  const row = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
  const action = String(row.action || "membership_mutation").trim();
  const agentId = String(row.target_agent_id || "").trim().toLowerCase();
  const expectedPresent = row.expected_present === true ? "present" : "absent";
  const expectedEnabled = row.expected_enabled === true
    ? "enabled"
    : (row.expected_enabled === false ? "disabled" : "n/a");
  const err = new Error(
    `team membership readback mismatch: action=${action}, agent=${agentId || "unknown"}, expected=${expectedPresent}/${expectedEnabled}`
  );
  err.code = "MEMBERSHIP_CONFIRMATION_FAILED";
  err.membershipConfirmationFailed = true;
  err.membership_confirmation = row;
  return err;
}

export function isMembershipConfirmationError(error) {
  return error?.membershipConfirmationFailed === true
    || String(error?.code || "").trim().toUpperCase() === "MEMBERSHIP_CONFIRMATION_FAILED";
}
