function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function pickString(source = {}, keys = []) {
  const row = asObject(source);
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "undefined" || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return text;
  }
  return "";
}

function normalizeId(text = "") {
  return String(text || "").trim();
}

export function normalizeConversationMembershipTarget(raw = {}, fallback = {}) {
  const row = asObject(raw);
  const defaults = asObject(fallback);
  const threadId = normalizeId(
    pickString(row, ["thread_id", "threadId"])
    || pickString(defaults, ["thread_id", "threadId"])
  );
  const conversationId = normalizeId(
    pickString(row, ["conversation_id", "conversationId", "id"])
    || pickString(defaults, ["conversation_id", "conversationId", "id"])
  );
  const workspaceId = normalizeId(
    pickString(row, ["workspace_id", "workspaceId"])
    || pickString(defaults, ["workspace_id", "workspaceId"])
  );
  const accountId = normalizeId(
    pickString(row, ["account_id", "accountId", "user_id", "userId"])
    || pickString(defaults, ["account_id", "accountId", "user_id", "userId"])
  );
  const source = normalizeId(
    pickString(row, ["source"])
    || pickString(defaults, ["source"])
  );
  return {
    thread_id: threadId,
    conversation_id: conversationId,
    workspace_id: workspaceId,
    account_id: accountId,
    source: source || "membership_target",
  };
}

export async function resolveConversationMembershipTarget(client, {
  threadId = "",
  conversationId = "",
  workspaceId = "",
  accountId = "",
  source = "",
  ensureConversation = true,
  bootstrapDefaults = false,
} = {}) {
  const requested = normalizeConversationMembershipTarget({
    thread_id: threadId,
    conversation_id: conversationId,
    workspace_id: workspaceId,
    account_id: accountId,
    source: source || "requested_target",
  });
  if (!requested.thread_id) {
    throw new Error("resolveConversationMembershipTarget requires threadId");
  }

  let ensuredConversation = null;
  let ensureError = null;
  if (ensureConversation !== false && typeof client?.ensureConversation === "function") {
    try {
      ensuredConversation = await client.ensureConversation(requested.thread_id, {
        bootstrapDefaults: bootstrapDefaults === true,
      });
    } catch (error) {
      ensureError = error;
    }
  }

  const ensured = normalizeConversationMembershipTarget(ensuredConversation, {
    thread_id: requested.thread_id,
    conversation_id: requested.conversation_id,
    workspace_id: requested.workspace_id,
    account_id: requested.account_id,
    source: "ensureConversation",
  });

  const ensureThreadId = normalizeId(ensured.thread_id);
  const mismatch = !!ensureThreadId && ensureThreadId !== requested.thread_id;
  const canonical = normalizeConversationMembershipTarget({
    thread_id: requested.thread_id,
    conversation_id: mismatch ? requested.conversation_id : (ensured.conversation_id || requested.conversation_id),
    workspace_id: ensured.workspace_id || requested.workspace_id,
    account_id: ensured.account_id || requested.account_id,
    source: source || "resolve_conversation_membership_target",
  });

  return {
    ...canonical,
    requested_target: requested,
    ensured_target: ensured,
    ensured_thread_mismatch: mismatch,
    mismatch_reason: mismatch ? "ensure_conversation_thread_mismatch" : "",
    ensure_error: ensureError ? String(ensureError?.message || ensureError) : "",
    ensure_conversation_used: typeof client?.ensureConversation === "function" && ensureConversation !== false,
  };
}

export function summarizeMembershipTarget(target = {}) {
  const row = normalizeConversationMembershipTarget(target);
  return {
    thread_id: row.thread_id,
    conversation_id: row.conversation_id,
    workspace_id: row.workspace_id || undefined,
    account_id: row.account_id || undefined,
    source: row.source || undefined,
  };
}
