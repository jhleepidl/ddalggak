export function buildPendingApprovalPrompt(
  pending = {},
  {
    inferReason,
    buildActionLines,
  } = {}
) {
  const id = String(pending?.id || "").trim();
  const reason = typeof inferReason === "function"
    ? String(inferReason(pending) || "").trim()
    : String(pending?.preview_reason || pending?.reason || "승인 필요").trim();
  const actionLines = typeof buildActionLines === "function"
    ? buildActionLines(pending)
    : [String(pending?.action?.type || "action")];
  const cancelImpact = String(pending?.cancel_impact || "").trim() || "취소 시 영향 없음";
  const runtimePolicySummary = Array.isArray(pending?.runtime_policy_summary)
    ? pending.runtime_policy_summary.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const keyboardRow = [
    { text: "Approve ✅", callback_data: `approve_action:${id}` },
    { text: "Cancel ❌", callback_data: `reject_action:${id}` },
    { text: "Work instead 🧩", callback_data: `work_action:${id}` },
  ];
  return {
    text: [
      "⚠️ 승인 요청(Preview)",
      `요청 이유: ${reason}`,
      "승인 시 수행될 내용:",
      ...actionLines,
      ...(runtimePolicySummary.length > 0 ? ["실행 정책:", ...runtimePolicySummary] : []),
      cancelImpact,
    ].join("\n"),
    keyboard: [keyboardRow],
  };
}

export function formatChatSummary(routePlan, results) {
  const lines = [
    "🧭 /chat summary",
    `reason=${String(routePlan?.reason || "(none)")}`,
    `actions=${Array.isArray(routePlan?.actions) ? routePlan.actions.length : 0}`,
  ];
  for (const row of (Array.isArray(results) ? results : [])) {
    lines.push(`- ${row.label}: ${row.status}${row.note ? ` (${row.note})` : ""}`);
  }
  return lines.join("\n");
}
