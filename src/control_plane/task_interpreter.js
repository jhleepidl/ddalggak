import { normalizeStringList } from "../shared/normalize.js";
import { normalizeTaskInterpretation } from "../domain/task_interpretation.js";
import { normalizeConversationPreferences } from "../domain/conversation_preferences.js";
import { normalizeRoleId, normalizeRoleList } from "../compatibility/legacy_roles.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function includesAny(text = "", needles = []) {
  const source = normalizeText(text, { lower: true });
  return asArray(needles).some((needle) => source.includes(normalizeText(needle, { lower: true })));
}

function tokenize(text = "") {
  return normalizeStringList(
    normalizeText(text, { lower: true }).split(/[^a-z0-9가-힣._-]+/g),
    { max: 128, lower: true }
  );
}

function inferLocale(text = "") {
  if (/[가-힣]/.test(String(text || ""))) return "ko-KR";
  return "en-US";
}

function collectDomainHints(text = "") {
  const hints = [];
  if (includesAny(text, ["dart", "filing", "공시"])) hints.push("filings");
  if (includesAny(text, ["market", "news", "headline", "macro", "시장", "뉴스"])) hints.push("market_news");
  if (includesAny(text, ["claim", "evidence", "citation", "근거", "주장"])) hints.push("claims");
  if (includesAny(text, ["stock", "equity", "valuation", "주식", "밸류"])) hints.push("finance");
  if (includesAny(text, ["code", "implement", "fix", "bug", "patch", "리팩터", "코드", "구현"])) hints.push("codebase");
  if (includesAny(text, ["workflow", "membership", "runtime", "polling", "shutdown", "team", "context", "운영"])) hints.push("workflow");
  if (includesAny(text, ["test", "qa", "verify", "regression", "검토", "테스트"])) hints.push("quality");
  return normalizeStringList(hints, { max: 16, lower: true });
}

function inferTaskType(text = "", routeContext = null) {
  const routeText = normalizeText(routeContext?.reason);
  if (includesAny(`${text}\n${routeText}`, ["workflow", "membership", "runtime", "polling", "shutdown", "operator", "thread team"])) {
    return "workflow";
  }
  if (includesAny(text, ["code", "implement", "fix", "bug", "patch", "refactor", "ipynb", "코드", "구현", "리팩터"])) {
    return "code_change";
  }
  if (includesAny(text, ["review", "audit", "verify", "claim", "evidence", "검토", "감사"])) {
    return "review";
  }
  if (includesAny(text, ["summary", "brief", "report", "요약", "보고"])) {
    return "report";
  }
  return "analysis_report";
}

function inferDeliverableType(taskType = "", text = "") {
  if (taskType === "code_change") return "code_patch";
  if (taskType === "workflow") return "workflow_update";
  if (taskType === "review") return "review_findings";
  if (includesAny(text, ["telegram", "brief", "요약"])) return "brief";
  return "report";
}

function inferRiskLevel(text = "", {
  taskType = "",
  domainHints = [],
} = {}) {
  const claimHeavy = includesAny(text, ["claim", "evidence", "citation", "financial", "market", "valuation", "법", "의료", "투자"]);
  const codeChange = taskType === "code_change";
  const workflowHeavy = taskType === "workflow";
  if (claimHeavy || codeChange || workflowHeavy || domainHints.includes("finance")) return "high";
  if (taskType === "review" || taskType === "report") return "medium";
  return "low";
}

function inferReviewPolicy(text = "", {
  taskType = "",
  riskLevel = "medium",
} = {}) {
  if (taskType === "code_change") return "code_default";
  if (includesAny(text, ["claim", "evidence", "citation", "fact"])) return "claim_heavy";
  if (riskLevel === "high") return "required";
  return "optional";
}

function inferControlMode(taskType = "", {
  riskLevel = "medium",
  reviewPolicy = "optional",
} = {}) {
  if (taskType === "workflow") return "supervised";
  if (riskLevel === "high" || reviewPolicy !== "optional") return "checkpointed";
  return "direct";
}

function inferParallelismPreference(text = "", {
  domainHints = [],
  taskType = "",
} = {}) {
  const multiSource = includesAny(text, ["compare", "across sources", "multi source", "filing and news", "cross-check", "비교", "교차검증"])
    || (domainHints.includes("market_news") && domainHints.includes("filings"));
  if (multiSource) return "parallel";
  if (taskType === "code_change") return "sequential";
  return "hybrid";
}

function inferPresetPins(text = "", {
  domainHints = [],
} = {}) {
  const pins = [];
  if (domainHints.includes("filings") || includesAny(text, ["dart"])) pins.push("dart_financial_researcher");
  if (domainHints.includes("claims") || includesAny(text, ["skeptical", "claim audit", "evidence audit"])) pins.push("skeptical_claim_reviewer");
  if (domainHints.includes("market_news") || includesAny(text, ["market news", "headline", "macro news"])) pins.push("market_news_researcher");
  return normalizeStringList(pins, { max: 8, lower: true });
}

function inferSuppressedRoles({
  taskType = "",
  deliverableType = "",
  domainHints = [],
} = {}) {
  const suppressed = [];
  if (taskType !== "workflow") suppressed.push("operator");
  if (taskType === "code_change") suppressed.push("synthesizer");
  if (deliverableType === "brief" || deliverableType === "report") {
    return normalizeStringList(suppressed.filter((entry) => entry !== "synthesizer"), { max: 8, lower: true });
  }
  if (!domainHints.includes("claims") && taskType !== "code_change") {
    suppressed.push("reviewer");
  }
  return normalizeStringList(suppressed, { max: 8, lower: true });
}

function buildCandidateSlots({
  taskType = "",
  deliverableType = "",
  riskLevel = "medium",
  reviewPolicy = "optional",
  domainHints = [],
  controlMode = "direct",
  parallelismPreference = "hybrid",
  goal = "",
  pinnedPresetIds = [],
  seedInstruction = "",
}) {
  const slots = [];
  const lowerGoal = normalizeText(`${goal}\n${seedInstruction}`, { lower: true });
  const addSlot = (slot) => {
    slots.push({
      role_id: normalizeRoleId(slot.role_id),
      purpose: slot.purpose,
      required_skill_ids: normalizeStringList(slot.required_skill_ids || [], { max: 16, lower: true }),
      preferred_skill_ids: normalizeStringList(slot.preferred_skill_ids || [], { max: 16, lower: true }),
      required_context_types: normalizeStringList(slot.required_context_types || [], { max: 16, lower: true }),
      required_tool_ids: normalizeStringList(slot.required_tool_ids || [], { max: 16, lower: true }),
      parallelizable: slot.parallelizable !== false,
      deliverable_type: slot.deliverable_type || undefined,
      selection_reason: slot.selection_reason || undefined,
    });
  };

  if (taskType === "code_change") {
    addSlot({
      role_id: "builder",
      purpose: "Implement the requested code or artifact changes",
      required_context_types: ["workspace", "patch_plan"],
      preferred_skill_ids: includesAny(lowerGoal, ["debug", "trace"]) ? ["skill.run_trace_debugging.v1"] : [],
      deliverable_type: "code_patch",
      parallelizable: false,
      selection_reason: "code change requires a builder",
    });
    addSlot({
      role_id: "reviewer",
      purpose: "Review the implementation for regressions and missing tests",
      required_context_types: ["risk", "tests"],
      preferred_skill_ids: includesAny(lowerGoal, ["claim", "evidence"]) ? ["skill.claim_evidence_audit.v1"] : [],
      parallelizable: false,
      deliverable_type: "review_findings",
      selection_reason: "code changes default to reviewer coverage",
    });
    if (includesAny(lowerGoal, ["research", "investigate", "filing", "news", "compare"])) {
      addSlot({
        role_id: "researcher",
        purpose: "Gather upstream evidence needed before implementation",
        required_context_types: ["evidence", "citations"],
        parallelizable: true,
        deliverable_type: "research_notes",
        selection_reason: "code task also requires external analysis",
      });
    }
  } else {
    const multiSource = parallelismPreference === "parallel";
    if (multiSource && domainHints.includes("filings")) {
      addSlot({
        role_id: "researcher",
        purpose: "Collect filing-based evidence",
        preferred_skill_ids: ["skill.kr_equity_analysis.v1"],
        required_context_types: ["filings", "evidence", "citations"],
        parallelizable: true,
        deliverable_type: "research_notes",
        selection_reason: "multi-source task split by filing cluster",
      });
    }
    addSlot({
      role_id: "researcher",
      purpose: taskType === "review"
        ? "Collect evidence to validate claims"
        : "Research the task and gather supporting evidence",
      preferred_skill_ids: domainHints.includes("market_news") ? ["skill.telegram_briefing.v1"] : [],
      required_context_types: domainHints.includes("market_news")
        ? ["news", "evidence", "citations"]
        : ["evidence", "citations"],
      parallelizable: multiSource,
      deliverable_type: "research_notes",
      selection_reason: "analysis/report tasks need a researcher",
    });
  }

  if (deliverableType === "brief" || deliverableType === "report" || taskType === "analysis_report" || taskType === "report") {
    addSlot({
      role_id: "synthesizer",
      purpose: "Assemble upstream findings into a concise final output",
      required_context_types: ["upstream_results", "aggregation"],
      preferred_skill_ids: deliverableType === "brief" ? ["skill.telegram_briefing.v1"] : [],
      parallelizable: false,
      deliverable_type: deliverableType === "brief" ? "brief" : "report",
      selection_reason: "analysis/report outputs usually need synthesis",
    });
  }

  if (reviewPolicy !== "optional" || riskLevel === "high" || domainHints.includes("claims")) {
    addSlot({
      role_id: "reviewer",
      purpose: "Stress-test claims, risks, and quality before final output",
      required_context_types: ["risk", "contradictions"],
      preferred_skill_ids: domainHints.includes("claims") ? ["skill.claim_evidence_audit.v1"] : [],
      parallelizable: false,
      deliverable_type: "review_findings",
      selection_reason: "risky or claim-heavy task requires reviewer coverage",
    });
  }

  if (taskType === "workflow" || domainHints.includes("workflow") || controlMode === "supervised") {
    addSlot({
      role_id: "operator",
      purpose: "Coordinate workflow, runtime state, and tool-heavy execution details",
      preferred_skill_ids: ["skill.thread_team_reconciliation.v1", "skill.context_selection_policy.v1"],
      required_context_types: ["workflow", "run_state", "tools"],
      parallelizable: false,
      deliverable_type: "workflow_update",
      selection_reason: "workflow or tool/state-heavy task requires an operator",
    });
  }

  if (pinnedPresetIds.includes("skeptical_claim_reviewer") && !slots.some((slot) => slot.role_id === "reviewer")) {
    addSlot({
      role_id: "reviewer",
      purpose: "Pinned skeptical review pass",
      preferred_skill_ids: ["skill.claim_evidence_audit.v1"],
      required_context_types: ["contradictions", "citations"],
      parallelizable: false,
      deliverable_type: "review_findings",
      selection_reason: "pinned skeptical claim reviewer preset",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const slot of slots) {
    const key = `${slot.role_id}|${slot.purpose}`;
    if (!slot.role_id || seen.has(key)) continue;
    seen.add(key);
    deduped.push(slot);
  }
  return deduped;
}

export function interpretTask({
  goal = "",
  task = "",
  message = "",
  mode = "run",
  seedInstruction = "",
  preferredRoles = [],
  conversationPreferences = null,
  conversationHints = [],
  routeContext = null,
  registry = null,
  toolHints = [],
} = {}) {
  const normalizedConversationPreferences = normalizeConversationPreferences(conversationPreferences || {});
  const goalText = normalizeText(goal || task || message);
  const routeReason = normalizeText(routeContext?.reason);
  const routePrompts = asArray(routeContext?.actions)
    .map((action) => normalizeText(action?.prompt || action?.goal || action?.task))
    .filter(Boolean);
  const registryHints = normalizeStringList(
    asArray(registry?.agents).map((agent) => normalizeText(agent?.id || agent?.role_type || agent?.name)),
    { max: 16, lower: true }
  );
  const combinedText = [
    goalText,
    seedInstruction,
    routeReason,
    ...routePrompts,
    ...asArray(conversationHints),
    ...asArray(toolHints),
    ...registryHints,
  ].filter(Boolean).join("\n");
  const domainHints = collectDomainHints(combinedText);
  const taskType = inferTaskType(combinedText, routeContext);
  const deliverableType = inferDeliverableType(taskType, combinedText);
  const riskLevel = inferRiskLevel(combinedText, { taskType, domainHints });
  const reviewPolicy = inferReviewPolicy(combinedText, { taskType, riskLevel });
  const controlMode = normalizedConversationPreferences.default_control_mode
    || inferControlMode(taskType, { riskLevel, reviewPolicy });
  const parallelismPreference = normalizedConversationPreferences.max_parallel_slots > 1
    ? "parallel"
    : inferParallelismPreference(combinedText, { domainHints, taskType });
  const pinnedPresetIds = normalizeStringList([
    ...inferPresetPins(combinedText, { domainHints }),
    ...normalizedConversationPreferences.pinned_preset_ids,
  ], { max: 24, lower: true });
  const preferredLocales = normalizeStringList([
    inferLocale(combinedText),
    ...normalizedConversationPreferences.preferred_locales,
  ], { max: 8, lower: true });
  const preferredDomains = normalizeStringList([
    ...domainHints,
    ...normalizedConversationPreferences.preferred_domains,
  ], { max: 16, lower: true });
  const suppressedRoleIds = normalizeRoleList([
    ...inferSuppressedRoles({
      taskType,
      deliverableType,
      domainHints,
    }),
    ...normalizedConversationPreferences.suppressed_role_ids,
  ], {
    allowDeprecatedControlPlane: false,
    max: 16,
  });
  const reviewerPolicy = normalizedConversationPreferences.reviewer_policy || reviewPolicy;
  const candidateCapabilitySlots = buildCandidateSlots({
    taskType,
    deliverableType,
    riskLevel,
    reviewPolicy: reviewerPolicy,
    domainHints: preferredDomains,
    controlMode,
    parallelismPreference,
    goal: goalText,
    pinnedPresetIds,
    seedInstruction,
  });

  return normalizeTaskInterpretation({
    goal: goalText,
    objective: goalText,
    mode,
    source: "control_plane",
    route_reason_hint: routeReason || undefined,
    notes: seedInstruction ? [seedInstruction] : [],
    preferred_roles: preferredRoles,
    task_type: taskType,
    task_summary: goalText || "task",
    deliverable_type: deliverableType,
    risk_level: riskLevel,
    domain_hints: domainHints,
    candidate_capability_slots: candidateCapabilitySlots,
    control_mode: controlMode,
    review_policy: reviewerPolicy,
    parallelism_preference: parallelismPreference,
    pinned_preset_ids: pinnedPresetIds,
    banned_preset_ids: normalizedConversationPreferences.banned_preset_ids,
    preferred_domains: preferredDomains,
    preferred_locales: preferredLocales,
    suppressed_role_ids: suppressedRoleIds,
    suppressed_skill_ids: normalizedConversationPreferences.suppressed_skill_ids,
  }, {
    fallbackGoal: goalText,
    fallbackMode: mode,
  });
}
