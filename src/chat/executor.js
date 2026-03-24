import crypto from "node:crypto";
import {
  actionNeedsApproval,
  isActionAllowed,
  parseAllowlist,
} from "./actions.js";
import {
  isRealExecutionAction,
  isTeamSetupAction,
  isMutationOnlyTeamSetupPlan,
} from "./action_classification.js";
import {
  buildAgentDisplayIndex,
  formatChatAgentDisplayName,
} from "../shared/agent_labels.js";
import { formatChatActionLabel } from "../adapters/telegram/preview_formatting.js";
import {
  evaluateActionAuthority,
} from "../application/run_authority.js";
import { sanitizeExecutablePlan } from "./route_execution_contract.js";
import {
  buildFailureRecoveryScoutGoal,
  classifyExecutionFailure,
  findRecoveryScoutAgentId,
} from "../application/failure_recovery_policy.js";
import {
  attachRouteSignals,
  collectActiveRouteSignals,
  evaluateIncomingConditions,
  resolveActionRouteSignals,
  summarizeConditions,
} from "./structural_runtime.js";
import { normalizeRuntimeExecutionPolicy } from "../application/runtime_execution_policy.js";
import {
  buildProviderRuntimePolicySummary,
  resolveProviderRuntimeOptions,
} from "../application/provider_runtime_policy.js";
import {
  appendResolutionAttempt,
  buildDelegateAgentGoal,
  buildDelegatedDetailContext,
  buildResolvedActionInputs,
  parseDelegateResolutionOutput,
  resolveAwaitUserRequestHandling,
} from "../application/user_input_resolution.js";
import { normalizeInputRequest } from "../shared/input_request_schema.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

const MUTATING_ACTION_TYPES = new Set([
  "propose_agent",
  "create_agent",
  "create_agent_definition",
  "update_agent",
  "fork_agent",
  "add_agent_to_conversation",
  "remove_agent_from_conversation",
  "enable_agent",
  "disable_agent",
  "enable_tool",
  "disable_tool",
  "install_agent_blueprint",
  "publish_agent",
]);

export function isMutatingAction(actionOrType) {
  const type = typeof actionOrType === "string"
    ? actionOrType
    : actionOrType?.type;
  const key = String(type || "").trim().toLowerCase();
  return MUTATING_ACTION_TYPES.has(key);
}

export {
  isRealExecutionAction,
  isTeamSetupAction,
  isMutationOnlyTeamSetupPlan,
};

function isMutatingApproved(action) {
  if (!action || typeof action !== "object") return false;
  return action.approved === true
    || action._approved === true
    || action._mutating_confirmed === true;
}

function looksLikeWorkRequest(text) {
  const src = String(text || "").toLowerCase();
  if (!src) return false;
  return /만들어줘|작성해줘|과제|리서치|분석|구현|코드|work|task|research|analy/i.test(src);
}

function escapeRegExp(text = "") {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAgentMentions(text = "", { agentIndex = new Map(), agentIds = [], nameHints = {} } = {}) {
  let out = String(text || "");
  const hints = nameHints && typeof nameHints === "object" ? nameHints : {};
  const seen = new Set();
  for (const agentIdRaw of agentIds) {
    const agentId = String(agentIdRaw || "").trim().toLowerCase();
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    const label = formatChatAgentDisplayName(agentId, agentIndex, {
      nameHint: String(hints[agentId] || "").trim(),
    });
    out = out.replace(new RegExp(`@${escapeRegExp(agentId)}`, "gi"), label);
  }
  return out;
}

function mutatingPreviewLines(actions = [], { agentIndex = new Map() } = {}) {
  const rows = Array.isArray(actions)
    ? actions.filter((action) => isMutatingAction(action))
    : [];
  return rows.slice(0, 8).map((action) => `- ${actionLabel(action, { agentIndex })}`);
}

function approvalReasonCategory(action = {}, fallbackReason = "") {
  const type = String(action?.type || "").trim().toLowerCase();
  if ([
    "create_agent",
    "create_agent_definition",
    "update_agent",
    "fork_agent",
    "propose_agent",
    "add_agent_to_conversation",
    "remove_agent_from_conversation",
    "enable_agent",
    "disable_agent",
    "enable_tool",
    "disable_tool",
  ].includes(type)) return "agent/tool 설정 변경";
  if (["publish_agent", "install_agent_blueprint"].includes(type)) return "publish/install";
  if (fallbackReason) return String(fallbackReason || "").trim();
  return "외부 상태 변경";
}

function approvalActionSummary(actions = [], { agentIndex = new Map() } = {}) {
  const rows = Array.isArray(actions) ? actions : [];
  return rows.slice(0, 8).map((action) => `- ${actionLabel(action, { agentIndex })}`);
}

function actionLabel(action, { agentIndex = new Map() } = {}) {
  return formatChatActionLabel(action, {
    agentIndex,
    needMoreDetailFallback: "unknown",
    publishFallbackMode: "agent_node_id",
    openContextFallback: "current",
  });
}

function getProviderByAgent(agents = [], agentId = "") {
  const key = String(agentId || "").trim().toLowerCase();
  if (!key) return "";
  const rows = Array.isArray(agents) ? agents : [];
  const found = rows.find((agent) => String(agent?.id || "").trim().toLowerCase() === key);
  return String(found?.provider || "").trim().toLowerCase();
}

function findAgentById(agents = [], agentId = "") {
  const key = String(agentId || "").trim().toLowerCase();
  if (!key) return null;
  return (Array.isArray(agents) ? agents : []).find((agent) => String(agent?.id || "").trim().toLowerCase() === key) || null;
}

function resolveRuntimeExecutionPolicyFromSnapshot(runtimeSnapshot = {}) {
  const structureRuntime = runtimeSnapshot?.structure_v2?.control_policy?.runtime_execution
    || runtimeSnapshot?.structure_v2?.control_policy?.runtimeExecution;
  return normalizeRuntimeExecutionPolicy(structureRuntime || runtimeSnapshot?.runtime_execution || runtimeSnapshot?.runtimeExecution || {});
}

function buildPendingRuntimePolicySummary({ action = {}, runtimeSnapshot = {}, agents = [] } = {}) {
  const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyFromSnapshot(runtimeSnapshot);
  const checkpointing = runtimeExecutionPolicy?.checkpointing || {};
  const continuous = runtimeExecutionPolicy?.continuous_improvement || {};
  const approvalMatrix = runtimeExecutionPolicy?.approval_matrix || {};
  const summary = [
    `- runtime_execution: checkpointing=${checkpointing.enabled === true ? 'enabled' : 'disabled'}, continuous_improvement=${continuous.enabled === true ? `enabled(max_turns=${continuous.max_turns})` : 'disabled'}`,
  ];
  if (Object.keys(approvalMatrix).length > 0) {
    const compact = Object.entries(approvalMatrix)
      .map(([key, value]) => `${key}=${String(value || '').trim()}`)
      .filter((entry) => !entry.endsWith('='))
      .slice(0, 6);
    if (compact.length > 0) summary.push(`- approval_matrix: ${compact.join(', ')}`);
  }

  const type = String(action?.type || '').trim().toLowerCase();
  if (["run_agent", "synthesize_final"].includes(type)) {
    const agentId = String(action?.agent_id || action?.agentId || action?.agent || '').trim().toLowerCase();
    const agent = findAgentById(agents, agentId);
    const provider = String(agent?.provider || '').trim().toLowerCase();
    if (provider) {
      const options = resolveProviderRuntimeOptions({
        runtimeExecutionPolicy,
        provider,
        action,
        agent,
      });
      const providerSummary = buildProviderRuntimePolicySummary({
        runtimeExecutionPolicy,
        provider,
        options,
      }).split("\n")
        .map((line) => String(line || '').trim())
        .filter((line) => line && !line.startsWith('approval_matrix='))
        .slice(0, 6)
        .map((line) => `- ${line}`);
      summary.push(...providerSummary);
    }
  } else if (type === 'tool_proxy_call') {
    summary.push(`- verification: ${String(approvalMatrix.verification || 'allow').trim() || 'allow'}`);
  }

  return summary.slice(0, 8);
}

function nextApprovalId() {
  return `appr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function isAbortLikeError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "ECANCELLED" || code === "ABORT_ERR") return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("cancelled")
    || message.includes("aborted")
    || message.includes("aborterror");
}

function makeCancelledError(reason = "cancelled") {
  const e = new Error(String(reason || "cancelled"));
  e.code = "ECANCELLED";
  return e;
}

function readInterruptState(sessionStore, chatId) {
  if (!sessionStore || typeof sessionStore.get !== "function") return null;
  const session = sessionStore.get(chatId);
  const interrupt = session?.interrupt && typeof session.interrupt === "object"
    ? session.interrupt
    : null;
  if (!interrupt || interrupt.requested !== true) return null;
  return {
    requested: true,
    mode: String(interrupt.mode || "").trim().toLowerCase() === "cancel" ? "cancel" : "replan",
    reason: String(interrupt.reason || "").trim(),
    ts: String(interrupt.ts || "").trim(),
  };
}

function buildStructuralPendingApproval({
  action = {},
  agentIndex = new Map(),
  chatId = '',
  jobId = '',
  userId = '',
  results = [],
  outputs = [],
  blockedIndex = 0,
  remainingActions = [],
  reason = '',
  gateType = '',
  runtimePolicySummary = [],
} = {}) {
  return {
    id: nextApprovalId(),
    chat_id: String(chatId || ''),
    job_id: String(jobId || ''),
    action,
    action_display_label: actionLabel(action, { agentIndex }),
    reason: String(reason || action?.prompt || action?.label || gateType || 'approval required').trim(),
    preview_reason: String(gateType || action?.type || 'approval').trim(),
    actions_summary: approvalActionSummary(remainingActions, { agentIndex }),
    cancel_impact: '취소 시 이후 구조 단계와 후속 agent 실행이 멈춥니다.',
    gate_type: String(gateType || action?.inputs?.gate_type || action?.type || 'approval').trim(),
    blocked_index: blockedIndex,
    remaining_actions: remainingActions,
    checkpoint_id: action?.inputs?.checkpoint_id || undefined,
    checkpoint_ids: Array.isArray(action?.inputs?.checkpoint_ids) ? action.inputs.checkpoint_ids : undefined,
    already_done: {
      results: [...results],
      outputs: [...outputs],
    },
    requested_by: String(userId || ''),
    ts: new Date().toISOString(),
    runtime_policy_summary: Array.isArray(runtimePolicySummary)
      ? runtimePolicySummary.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 8)
      : [],
  };
}


function summarizeVerificationResult(proxyResult = {}) {
  const commands = Array.isArray(proxyResult?.commands) ? proxyResult.commands.filter(Boolean) : [];
  const resultRows = Array.isArray(proxyResult?.results) ? proxyResult.results : [];
  const lines = [];
  if (commands.length > 0) lines.push(`commands: ${commands.join(' ; ')}`);
  for (const row of resultRows.slice(0, 6)) {
    const command = String(row?.command || '').trim();
    const status = row?.ok ? 'ok' : 'failed';
    const exitCode = Number.isFinite(Number(row?.exitCode)) ? Number(row.exitCode) : -1;
    const detail = String((row?.ok ? row?.stdout : (row?.stderr || row?.stdout)) || '').trim().replace(/\s+/g, ' ');
    lines.push(`- ${command || 'command'} -> ${status} (exit=${exitCode})${detail ? ` :: ${detail.slice(0, 240)}` : ''}`);
  }
  const text = String(proxyResult?.text || '').trim();
  if (lines.length > 0) return lines.join('\n');
  return text.slice(0, 700);
}

function buildRepairPrompt({
  proxyResult = {},
  action = {},
  repairTarget = null,
  verifierTarget = null,
  attempt = 1,
} = {}) {
  const label = String(action?.label || action?.prompt || 'verification').trim() || 'verification';
  const summary = summarizeVerificationResult(proxyResult) || 'verification failed';
  const verifierLine = verifierTarget?.agent_id
    ? `After repairing, keep the change set tidy so ${verifierTarget.agent_id} can review it.`
    : 'After repairing, keep the change set minimal and ready for review.';
  return [
    `Repair attempt ${attempt}: ${label} failed.`,
    verifierLine,
    'Fix the code or workspace issues causing the verification failure, then stop after applying the smallest safe patch.',
    'Do not invent missing files or rename knowledge-base documents; use only the files that exist in the current KB contract.',
    '',
    'Verification summary:',
    summary,
  ].join('\n');
}

function buildVerifierPrompt({
  proxyResult = {},
  action = {},
  repairTarget = null,
  verifierTarget = null,
  attempt = 1,
} = {}) {
  const label = String(action?.label || action?.prompt || 'verification').trim() || 'verification';
  const repairLabel = String(repairTarget?.agent_id || repairTarget?.slot_id || 'coder').trim() || 'coder';
  const summary = summarizeVerificationResult(proxyResult) || 'verification failed';
  return [
    `Review repair attempt ${attempt} after ${label} failed.`,
    `Check whether ${repairLabel}'s latest patch likely addresses the failure and flag any remaining risk or missing test coverage.`,
    'Keep the response concise and implementation-facing.',
    '',
    'Verification summary:',
    summary,
  ].join('\n');
}

function summarizeCommitteeCoverage(action = {}, outputs = []) {
  const memberSlotIds = (Array.isArray(action?.inputs?.member_slot_ids) ? action.inputs.member_slot_ids : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const memberSet = new Set(memberSlotIds);
  const respondedSlots = new Set();
  const respondedAgents = new Set();
  for (const row of Array.isArray(outputs) ? outputs : []) {
    const slotId = String(row?.slot_id || '').trim();
    const agentId = String(row?.agentId || '').trim().toLowerCase();
    if (slotId && memberSet.has(slotId)) respondedSlots.add(slotId);
    if (agentId) respondedAgents.add(agentId);
  }
  return {
    member_slot_ids: memberSlotIds,
    responded_slot_ids: [...respondedSlots],
    responded_count: respondedSlots.size,
    responded_agent_count: respondedAgents.size,
  };
}


async function runVerificationRepairLoop({
  action = {},
  initialProxyResult = null,
  callbacks = {},
  jobId = '',
  detailContext = '',
  outputs = [],
  results = [],
  activeRouteSignals = new Set(),
  maxAttempts = 1,
} = {}) {
  if (typeof callbacks.toolProxyCall !== 'function' || typeof callbacks.runAgent !== 'function') return null;
  const inputs = asObject(action?.inputs);
  const repairAgentId = String(inputs.repair_target_agent_id || inputs.repair_agent_id || '').trim().toLowerCase();
  const repairSlotId = String(inputs.repair_target_slot_id || '').trim();
  if (!repairAgentId) return null;
  const verifierAgentId = String(inputs.verifier_agent_id || '').trim().toLowerCase();
  const verifierSlotId = String(inputs.verifier_slot_id || '').trim();
  const attemptLimit = Number.isFinite(Number(maxAttempts)) ? Math.max(1, Math.min(3, Math.floor(Number(maxAttempts)))) : 1;
  let previousProxyResult = initialProxyResult;
  let latestProxyResult = initialProxyResult;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const repairAction = {
      type: 'run_agent',
      agent_id: repairAgentId,
      goal: buildRepairPrompt({
        proxyResult: previousProxyResult || {},
        action,
        repairTarget: { agent_id: repairAgentId, slot_id: repairSlotId },
        verifierTarget: { agent_id: verifierAgentId, slot_id: verifierSlotId },
        attempt,
      }),
      inputs: {
        slot_id: repairSlotId || undefined,
        runtime_instance_id: String(inputs.repair_target_runtime_instance_id || '').trim() || undefined,
        verification_repair_attempt: attempt,
        verification_repair_for_slot_id: String(inputs.slot_id || '').trim() || undefined,
        verification_repair_for_label: String(action?.label || action?.prompt || '').trim() || undefined,
      },
    };
    const repairResult = await callbacks.runAgent({ action: repairAction, jobId, detailContext });
    outputs.push(attachRouteSignals({
      agentId: repairAgentId,
      provider: String(repairResult?.provider || '').trim().toLowerCase(),
      mode: String(repairResult?.mode || 'verification_repair').trim() || 'verification_repair',
      output: String(repairResult?.output || '').trim(),
      jobId: String(jobId || ''),
      slot_id: repairSlotId || undefined,
      runtime_instance_id: String(inputs.repair_target_runtime_instance_id || '').trim() || undefined,
      verification_repair_attempt: attempt,
    }, resolveActionRouteSignals({ action: repairAction, result: repairResult, fallbackSignals: ['repair_attempted'] }), { activeSignals: activeRouteSignals }));
    results.push({ label: `${String(action?.label || 'tool proxy').trim()} repair#${attempt}`, status: 'ok', note: `repair by ${repairAgentId}` });

    if (verifierAgentId && verifierAgentId !== repairAgentId) {
      const verifierAction = {
        type: 'run_agent',
        agent_id: verifierAgentId,
        goal: buildVerifierPrompt({
          proxyResult: previousProxyResult || {},
          action,
          repairTarget: { agent_id: repairAgentId, slot_id: repairSlotId },
          verifierTarget: { agent_id: verifierAgentId, slot_id: verifierSlotId },
          attempt,
        }),
        inputs: {
          slot_id: verifierSlotId || undefined,
          runtime_instance_id: String(inputs.verifier_runtime_instance_id || '').trim() || undefined,
          verification_review_attempt: attempt,
          verification_review_for_slot_id: String(inputs.slot_id || '').trim() || undefined,
        },
      };
      const verifierResult = await callbacks.runAgent({ action: verifierAction, jobId, detailContext });
      outputs.push(attachRouteSignals({
        agentId: verifierAgentId,
        provider: String(verifierResult?.provider || '').trim().toLowerCase(),
        mode: String(verifierResult?.mode || 'verification_review').trim() || 'verification_review',
        output: String(verifierResult?.output || '').trim(),
        jobId: String(jobId || ''),
        slot_id: verifierSlotId || undefined,
        runtime_instance_id: String(inputs.verifier_runtime_instance_id || '').trim() || undefined,
        verification_review_attempt: attempt,
      }, resolveActionRouteSignals({ action: verifierAction, result: verifierResult, fallbackSignals: ['repair_reviewed'] }), { activeSignals: activeRouteSignals }));
      results.push({ label: `${String(action?.label || 'tool proxy').trim()} review#${attempt}`, status: 'ok', note: `review by ${verifierAgentId}` });
    }

    latestProxyResult = await callbacks.toolProxyCall({ action, jobId, outputs, results, detailContext });
    outputs.push(attachRouteSignals({
      agentId: 'system',
      provider: 'system',
      mode: 'tool_proxy_call',
      output: String(latestProxyResult?.text || latestProxyResult?.output || action?.label || 'tool proxy step').trim(),
      jobId: String(jobId || ''),
      verification_repair_attempt: attempt,
      verification_replayed: true,
    }, resolveActionRouteSignals({ action, result: latestProxyResult }), { activeSignals: activeRouteSignals }));
    results.push({ label: `${String(action?.label || 'tool proxy').trim()} retry#${attempt}`, status: latestProxyResult?.ok === true ? 'ok' : 'error', note: latestProxyResult?.ok === true ? 'verification recovered' : 'verification still failing' });
    if (latestProxyResult?.ok === true) {
      return { proxyResult: latestProxyResult, recovered: true, attemptsUsed: attempt };
    }
    previousProxyResult = latestProxyResult;
  }

  return { proxyResult: latestProxyResult, recovered: false, attemptsUsed: attemptLimit };
}


function buildFailureResultNote(failure = {}, fallbackMessage = '') {
  const parts = [String(failure?.category || '').trim(), String(failure?.recovery_strategy || '').trim()].filter(Boolean);
  const suffix = parts.length > 0 ? ` [${parts.join('/')}]` : '';
  return `${String(fallbackMessage || failure?.message || 'failure').trim()}${suffix}`.trim();
}

function buildAwaitUserRequestFromFailure(failure = {}, { label = '', action = {} } = {}) {
  const reason = String(failure?.summary || failure?.message || label || '추가 입력 필요').trim();
  const hint = String(failure?.user_message || '').trim() || '추가 입력이 필요합니다.';
  return normalizeInputRequest({
    request_id: `ireq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` ,
    type: 'await_user',
    category: String(failure?.category || 'unknown_failure').trim() || 'unknown_failure',
    reason,
    prompt: reason,
    followup_hint: hint,
    source_agent_id: String(action?.agent_id || action?.agent || '').trim().toLowerCase() || undefined,
    source_action_label: String(label || '').trim() || String(action?.type || 'action').trim(),
    source_action_type: String(action?.type || '').trim().toLowerCase() || undefined,
  });
}

async function tryResolveAwaitUserRequestByDelegate({
  awaitUserRequest = null,
  action = {},
  callbacks = {},
  jobId = '',
  detailContext = '',
  agents = [],
  outputs = [],
  results = [],
  activeRouteSignals = new Set(),
} = {}) {
  const request = awaitUserRequest && typeof awaitUserRequest === 'object'
    ? normalizeInputRequest(awaitUserRequest, {
        fallbackSourceAgentId: String(action?.agent_id || action?.agent || '').trim().toLowerCase(),
        fallbackActionType: action?.type,
        fallbackActionLabel: action?.label || action?.goal,
      })
    : null;
  if (!request || typeof callbacks.runAgent !== 'function') {
    return {
      resolved: false,
      awaitUserRequest: request,
      detailContext,
      runResult: null,
      delegate: null,
    };
  }
  const handling = resolveAwaitUserRequestHandling({
    request,
    action,
    agents,
    currentAgentId: String(action?.agent_id || action?.agent || '').trim().toLowerCase(),
  });
  if (handling?.resolution !== 'delegate_agent') {
    return {
      resolved: false,
      awaitUserRequest: handling?.request || request,
      detailContext,
      runResult: null,
      delegate: handling || null,
    };
  }

  let evolvingRequest = handling.request || request;
  const candidates = Array.isArray(handling.candidate_delegate_agents) && handling.candidate_delegate_agents.length > 0
    ? handling.candidate_delegate_agents
    : (Array.isArray(handling.candidate_resolver_agent_ids)
      ? handling.candidate_resolver_agent_ids.map((id) => ({ id: String(id || '').trim().toLowerCase(), role: '' })).filter((row) => row.id)
      : []);

  for (const candidate of candidates) {
    const delegateAgentId = String(candidate?.id || '').trim().toLowerCase();
    if (!delegateAgentId) continue;
    const delegateAgentRole = String(candidate?.role || '').trim().toLowerCase() || undefined;
    const delegateAction = {
      type: 'run_agent',
      agent_id: delegateAgentId,
      goal: buildDelegateAgentGoal({
        request: evolvingRequest,
        action,
        sourceAgentId: String(action?.agent_id || action?.agent || '').trim().toLowerCase(),
        delegateAgent: candidate,
      }),
      inputs: {
        input_request: evolvingRequest,
        input_resolution_task: {
          request_id: evolvingRequest.request_id,
          source_agent_id: evolvingRequest.source_agent_id,
          request_kind: evolvingRequest.request_kind,
          category: evolvingRequest.category,
        },
        await_user_resolution_for_agent_id: String(action?.agent_id || action?.agent || '').trim().toLowerCase() || undefined,
        await_user_resolution_category: String(evolvingRequest?.category || '').trim().toLowerCase() || undefined,
      },
    };

    try {
      const delegateResult = await callbacks.runAgent({ action: delegateAction, jobId, detailContext });
      const delegateOutput = String(delegateResult?.output || '').trim();
      const resolution = parseDelegateResolutionOutput({
        request: evolvingRequest,
        delegateOutput,
        delegateAgentId,
        delegateAgentRole,
      });
      evolvingRequest = appendResolutionAttempt({ request: evolvingRequest, resolution });
      outputs.push(attachRouteSignals({
        agentId: delegateAgentId,
        provider: String(delegateResult?.provider || '').trim().toLowerCase(),
        mode: 'input_resolution',
        legacy_mode: 'followup_resolution',
        output: delegateOutput,
        jobId: String(jobId || ''),
        input_request_id: evolvingRequest.request_id || undefined,
        resolution_type: resolution.resolution_type || undefined,
        await_user_resolution_for: String(action?.agent_id || action?.agent || '').trim().toLowerCase() || undefined,
      }, ['input_resolution'], { activeSignals: activeRouteSignals }));
      results.push({
        label: `${String(action?.agent_id || action?.agent || 'agent').trim()} input_resolution`,
        status: resolution.resolution_type === 'agent_resolved' ? 'ok' : 'blocked',
        note: resolution.resolution_type === 'agent_resolved'
          ? `resolved by ${delegateAgentId}`
          : `user decision required after ${delegateAgentId}`,
      });

      if (resolution.resolution_type === 'user_required') {
        return {
          resolved: false,
          awaitUserRequest: evolvingRequest,
          detailContext,
          runResult: null,
          delegate: handling,
          delegateResult,
        };
      }

      const recoveredDetailContext = buildDelegatedDetailContext({
        detailContext,
        request: evolvingRequest,
        resolution,
      });
      const retriedAction = {
        ...action,
        inputs: buildResolvedActionInputs({
          actionInputs: action?.inputs,
          request: evolvingRequest,
          resolution,
        }),
      };
      const retried = await callbacks.runAgent({ action: retriedAction, jobId, detailContext: recoveredDetailContext });
      return {
        resolved: true,
        awaitUserRequest: null,
        detailContext: recoveredDetailContext,
        runResult: retried,
        delegate: handling,
        delegateResult,
      };
    } catch (delegateError) {
      const failureResolution = {
        resolver_agent_id: delegateAgentId,
        resolver_agent_role: delegateAgentRole,
        status: 'failed',
        resolution_type: 'delegate_failed',
        answer: String(delegateError?.message || delegateError || 'delegate resolution failed').trim(),
        rationale: 'delegate resolver failed before producing a usable answer',
      };
      evolvingRequest = appendResolutionAttempt({ request: evolvingRequest, resolution: failureResolution });
      results.push({
        label: `${String(action?.agent_id || action?.agent || 'agent').trim()} input_resolution`,
        status: 'error',
        note: `delegate ${delegateAgentId} failed`,
      });
    }
  }

  const finalAwaitUserRequest = normalizeInputRequest({
    ...evolvingRequest,
    resolution_status: 'awaiting_user',
    human_required: true,
    followup_hint: String(evolvingRequest?.followup_hint || evolvingRequest?.reason || '추가 입력이 필요합니다.').trim() || '추가 입력이 필요합니다.',
  });
  return {
    resolved: false,
    awaitUserRequest: finalAwaitUserRequest,
    detailContext,
    runResult: null,
    delegate: handling,
  };
}

async function executeRunAgentWithRecovery({
  action = {},
  callbacks = {},
  jobId = '',
  detailContext = '',
  label = '',
  provider = '',
  agents = [],
  runtimeExecutionPolicy = {},
  outputs = [],
  results = [],
  activeRouteSignals = new Set(),
} = {}) {
  try {
    const runResult = await callbacks.runAgent({ action, jobId, detailContext });
    return { runResult, detailContext, recovered: false, failure: null, awaitUserRequest: null };
  } catch (error) {
    if (isAbortLikeError(error)) throw error;
    const failure = classifyExecutionFailure({
      error,
      action,
      provider,
      runtimeExecutionPolicy,
      agents,
    });

    if (failure.recovery_strategy === 'await_user' || failure.recovery_strategy === 'await_approval') {
      results.push({ label, status: 'error', note: buildFailureResultNote(failure, String(error?.message ?? error)) });
      outputs.push(attachRouteSignals({
        agentId: 'system',
        provider: 'system',
        mode: 'failure',
        output: `${label} 실패 · ${failure.summary}`,
        jobId: String(jobId || ''),
        failure: {
          category: failure.category,
          recovery_strategy: failure.recovery_strategy,
          summary: failure.summary,
        },
      }, ['failure_detected', failure.category], { activeSignals: activeRouteSignals }));
      return {
        runResult: null,
        detailContext,
        recovered: false,
        failure,
        awaitUserRequest: buildAwaitUserRequestFromFailure(failure, { label, action }),
      };
    }

    if (failure.recovery_strategy === 'retry_once') {
      results.push({ label: `${label} retry`, status: 'ok', note: `auto retry · ${failure.category}` });
      const retried = await callbacks.runAgent({ action, jobId, detailContext });
      return { runResult: retried, detailContext, recovered: true, failure, awaitUserRequest: null };
    }

    if (failure.recovery_strategy === 'search_then_retry') {
      const scoutAgentId = findRecoveryScoutAgentId(agents, { excludeAgentId: String(action?.agent_id || '').trim().toLowerCase() });
      if (scoutAgentId) {
        const scoutAction = {
          type: 'run_agent',
          agent_id: scoutAgentId,
          goal: buildFailureRecoveryScoutGoal({ action, failure, attempt: 1 }),
          inputs: {
            failure_recovery_for_agent_id: String(action?.agent_id || '').trim().toLowerCase() || undefined,
            failure_recovery_type: String(failure?.category || '').trim() || undefined,
          },
        };
        const scoutResult = await callbacks.runAgent({ action: scoutAction, jobId, detailContext });
        const scoutOutput = String(scoutResult?.output || '').trim();
        outputs.push(attachRouteSignals({
          agentId: scoutAgentId,
          provider: String(scoutResult?.provider || '').trim().toLowerCase(),
          mode: 'failure_research',
          output: scoutOutput,
          jobId: String(jobId || ''),
          failure_recovery_for: String(action?.agent_id || '').trim().toLowerCase() || undefined,
        }, ['failure_research', String(failure?.category || '').trim() || 'implementation_failure'], { activeSignals: activeRouteSignals }));
        results.push({ label: `${label} recovery`, status: 'ok', note: `researched by ${scoutAgentId}` });
        const recoveredDetailContext = [
          String(detailContext || '').trim(),
          '[failure_recovery]',
          `category=${String(failure?.category || '').trim()}`,
          `summary=${String(failure?.summary || '').trim()}`,
          failure?.message ? `error=${String(failure.message || '').trim()}` : '',
          scoutOutput ? `scout_notes:
${scoutOutput}` : '',
        ].filter(Boolean).join('\n\n');
        const retried = await callbacks.runAgent({ action, jobId, detailContext: recoveredDetailContext });
        return { runResult: retried, detailContext: recoveredDetailContext, recovered: true, failure, awaitUserRequest: null };
      }
    }

    throw error;
  }
}

export async function executeSupervisorActions({
  chatId,
  userId,
  jobId,
  plan,
  originalUserText = "",
  forceMode = "normal",
  jobConfig = {},
  agents = [],
  tools = [],
  sessionStore = null,
  callbacks = {},
  initialResults = [],
  initialOutputs = [],
} = {}) {
  const config = asObject(jobConfig);
  const budgetCfg = asObject(config.budget);
  const approvalCfg = asObject(config.approval);
  const allowlist = parseAllowlist(config, tools);
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const runtimeSnapshot = plan?.runtime_team_snapshot && typeof plan.runtime_team_snapshot === "object"
    ? plan.runtime_team_snapshot
    : plan;
  const sanitizedPlan = sanitizeExecutablePlan({
    plan: {
      ...plan,
      actions,
    },
    runtimeSnapshot,
  });
  const executionContractNotes = Array.isArray(sanitizedPlan?.notes) ? sanitizedPlan.notes : [];
  const executableActions = Array.isArray(sanitizedPlan?.plan?.actions) ? sanitizedPlan.plan.actions : actions;
  const teamLocked = plan?.team_locked === true || runtimeSnapshot?.team_locked === true;
  const agentDisplayIndex = buildAgentDisplayIndex(agents);
  const maxActions = Number.isFinite(Number(budgetCfg.max_actions))
    ? Math.max(1, Math.floor(Number(budgetCfg.max_actions)))
    : 4;
  const runtimeExecutionPolicy = resolveRuntimeExecutionPolicyFromSnapshot(runtimeSnapshot);

  const results = Array.isArray(initialResults) ? [...initialResults] : [];
  const outputs = Array.isArray(initialOutputs) ? [...initialOutputs] : [];
  const activeRouteSignals = collectActiveRouteSignals(outputs);
  let detailContext = "";
  let pendingApproval = null;
  let blockedIndex = -1;
  let remainingActions = [];
  let usedActions = 0;
  let blockedActions = 0;
  let interruptedByReplan = false;
  let awaitUserRequest = null;
  const cleanOriginalUserText = String(originalUserText || "").trim();
  const cleanForceMode = String(forceMode || "").trim().toLowerCase() === "work"
    ? "work"
    : "normal";

  for (const note of executionContractNotes) {
    results.push({
      label: "route_contract",
      status: "ok",
      note: `${note.action_type} downgraded to sequential run_agent: ${note.reason}`,
    });
    outputs.push({
      agentId: "system",
      provider: "system",
      mode: "execution_contract",
      output: `parallel spawn downgraded to sequential execution (${note.child_count} children): ${note.reason}`,
      jobId: String(jobId || ""),
    });
  }

  if (sessionStore) {
    sessionStore.upsert(chatId, {
      jobId: String(jobId || "").trim(),
      state: "executing",
      pending_approval: null,
      budget: {
        max_actions: maxActions,
      },
    });
  }

  if (teamLocked) {
    const forbidden = executableActions.find((action) => isMutatingAction(action));
    if (forbidden) {
      throw new Error('team is locked; use /team commands to change composition');
    }
  }

  const mutatingIndex = executableActions.findIndex((action) => isMutatingAction(action) && !isMutatingApproved(action));
  if (mutatingIndex >= 0) {
    blockedActions += 1;
    blockedIndex = mutatingIndex;
    remainingActions = executableActions.slice(mutatingIndex);
    const mutatingAction = executableActions[mutatingIndex];
    const workLikeHint = looksLikeWorkRequest(cleanOriginalUserText);
    pendingApproval = {
      id: nextApprovalId(),
      chat_id: String(chatId || ""),
      job_id: String(jobId || ""),
      action: mutatingAction,
      action_display_label: actionLabel(mutatingAction, { agentIndex: agentDisplayIndex }),
      reason: "관리 변경 적용 전 확인이 필요합니다.",
      preview_reason: approvalReasonCategory(mutatingAction, "관리 변경 적용 전 확인이 필요합니다."),
      actions_summary: approvalActionSummary(executableActions, { agentIndex: agentDisplayIndex }),
      cancel_impact: "취소 시 영향 없음",
      gate_type: "mutating_confirm",
      mode_choice_required: true,
      blocked_index: mutatingIndex,
      remaining_actions: executableActions,
      already_done: {
        results: [...results],
        outputs: [...outputs],
      },
      requested_by: String(userId || ""),
      ts: new Date().toISOString(),
      original_user_text: cleanOriginalUserText,
      force_mode: cleanForceMode,
      work_like_hint: workLikeHint,
      preview_lines: mutatingPreviewLines(executableActions, { agentIndex: agentDisplayIndex }),
      runtime_policy_summary: buildPendingRuntimePolicySummary({
        action: mutatingAction,
        runtimeSnapshot,
        agents,
      }),
    };
    results.push({
      label: actionLabel(mutatingAction, { agentIndex: agentDisplayIndex }),
      status: "blocked",
      note: "mutating confirm required",
    });
    if (sessionStore) {
      sessionStore.upsert(chatId, {
        state: "awaiting_approval",
        pending_approval: pendingApproval,
      });
    }
  }

  for (let i = 0; i < executableActions.length && !pendingApproval; i += 1) {
    const action = executableActions[i];
    const label = actionLabel(action, { agentIndex: agentDisplayIndex });
    const interruptBefore = readInterruptState(sessionStore, chatId);
    if (interruptBefore?.requested) {
      if (interruptBefore.mode === "cancel") {
        throw makeCancelledError(interruptBefore.reason || `interrupt(cancel) before ${label}`);
      }
      blockedIndex = i;
      remainingActions = executableActions.slice(i);
      interruptedByReplan = true;
      results.push({
        label: "interrupt",
        status: "skip",
        note: interruptBefore.reason
          ? `replan requested before ${label}: ${interruptBefore.reason}`
          : `replan requested before ${label}`,
      });
      break;
    }

    const authority = evaluateActionAuthority({
      action,
      runtimeSnapshot,
    });
    if (authority.enforced && authority.allowed !== true) {
      blockedActions += 1;
      results.push({
        label,
        status: "blocked",
        note: authority.reasons.join("; ") || "authority denied",
      });
      continue;
    }
    if (authority.requires_approval) {
      blockedActions += 1;
      blockedIndex = i;
        remainingActions = executableActions.slice(i);
      pendingApproval = {
        id: nextApprovalId(),
        chat_id: String(chatId || ""),
        job_id: String(jobId || ""),
        action,
        action_display_label: actionLabel(action, { agentIndex: agentDisplayIndex }),
        reason: authority.reasons.join("; ") || "authority approval required",
        preview_reason: "authority approval required",
        actions_summary: approvalActionSummary(remainingActions, { agentIndex: agentDisplayIndex }),
        cancel_impact: "취소 시 영향 없음",
        gate_type: "authority_approval",
        blocked_index: i,
        remaining_actions: remainingActions,
        checkpoint_id: action?.inputs?.checkpoint_id || undefined,
        checkpoint_ids: Array.isArray(action?.inputs?.checkpoint_ids) ? action.inputs.checkpoint_ids : undefined,
        checkpoint_status: action?.inputs?.checkpoint_status || undefined,
        already_done: {
          results: [...results],
          outputs: [...outputs],
        },
        requested_by: String(userId || ""),
        ts: new Date().toISOString(),
        runtime_policy_summary: buildPendingRuntimePolicySummary({
          action,
          runtimeSnapshot,
          agents,
        }),
      };
      results.push({ label, status: "blocked", note: pendingApproval.reason });
      if (sessionStore) {
        sessionStore.upsert(chatId, {
          state: "awaiting_approval",
          pending_approval: pendingApproval,
        });
      }
      break;
    }

    if (!isActionAllowed(action, allowlist)) {
      blockedActions += 1;
      results.push({ label, status: "blocked", note: "not in allowlist" });
      continue;
    }
    if (usedActions >= maxActions) {
      blockedActions += 1;
      results.push({ label, status: "blocked", note: `budget exceeded (max_actions=${maxActions})` });
      break;
    }

    const routeDecision = evaluateIncomingConditions(action, {
      activeSignals: activeRouteSignals,
    });
    const routeConditionBypass = ["gate_wait", "human_checkpoint", "checkpoint", "committee_consensus", "supervisor_decision"].includes(String(action?.type || "").trim().toLowerCase());
    if (!routeDecision.allowed && !routeConditionBypass) {
      results.push({
        label,
        status: "skip",
        note: routeDecision.missing_conditions.length > 0
          ? `route conditions not satisfied: ${routeDecision.missing_conditions.join(", ")}`
          : "route conditions not satisfied",
      });
      continue;
    }

    const provider = action?.type === "run_agent"
      ? getProviderByAgent(agents, action.agent_id)
      : "";
    const approval = actionNeedsApproval(action, {
      approval: approvalCfg,
      provider,
    });
    if (approval.required) {
      blockedActions += 1;
      blockedIndex = i;
        remainingActions = executableActions.slice(i);
      pendingApproval = {
        id: nextApprovalId(),
        chat_id: String(chatId || ""),
        job_id: String(jobId || ""),
        action,
        action_display_label: actionLabel(action, { agentIndex: agentDisplayIndex }),
        reason: approval.reason,
        preview_reason: approvalReasonCategory(action, approval.reason),
        actions_summary: approvalActionSummary(remainingActions, { agentIndex: agentDisplayIndex }),
        cancel_impact: "취소 시 영향 없음",
        blocked_index: i,
        remaining_actions: remainingActions,
        already_done: {
          results: [...results],
          outputs: [...outputs],
        },
        requested_by: String(userId || ""),
        ts: new Date().toISOString(),
        runtime_policy_summary: buildPendingRuntimePolicySummary({
          action,
          runtimeSnapshot,
          agents,
        }),
      };
      results.push({ label, status: "blocked", note: `approval required: ${approval.reason}` });
      if (sessionStore) {
        sessionStore.upsert(chatId, {
          state: "awaiting_approval",
          pending_approval: pendingApproval,
        });
      }
      break;
    }
    if (action.type === "checkpoint" && action?.inputs?.approval_required === true) {
      blockedActions += 1;
      blockedIndex = i;
        remainingActions = executableActions.slice(i);
      pendingApproval = {
        id: nextApprovalId(),
        chat_id: String(chatId || ""),
        job_id: String(jobId || ""),
        action,
        action_display_label: actionLabel(action, { agentIndex: agentDisplayIndex }),
        reason: action?.prompt || action?.label || "checkpoint approval required",
        preview_reason: "checkpoint approval required",
        actions_summary: approvalActionSummary(remainingActions, { agentIndex: agentDisplayIndex }),
        cancel_impact: "취소 시 영향 없음",
        gate_type: "checkpoint",
        blocked_index: i,
        remaining_actions: remainingActions,
        checkpoint_id: action?.inputs?.checkpoint_id || undefined,
        checkpoint_ids: Array.isArray(action?.inputs?.checkpoint_ids) ? action.inputs.checkpoint_ids : undefined,
        checkpoint_status: action?.inputs?.checkpoint_status || "pending",
        already_done: {
          results: [...results],
          outputs: [...outputs],
        },
        requested_by: String(userId || ""),
        ts: new Date().toISOString(),
        runtime_policy_summary: buildPendingRuntimePolicySummary({
          action,
          runtimeSnapshot,
          agents,
        }),
      };
      results.push({ label, status: "blocked", note: pendingApproval.reason });
      if (sessionStore) {
        sessionStore.upsert(chatId, {
          state: "awaiting_approval",
          pending_approval: pendingApproval,
        });
      }
      break;
    }

    try {
      if (action.type === "need_more_detail") {
        if (typeof callbacks.needMoreDetail !== "function") {
          throw new Error("needMoreDetail callback is missing");
        }
        const expanded = await callbacks.needMoreDetail({
          action,
          jobId,
          detailContext,
        });
        detailContext = String(expanded?.detail_context || detailContext || "");
        const usedNodeCount = Array.isArray(expanded?.used_node_ids) ? expanded.used_node_ids.length : 0;
        results.push({ label, status: "ok", note: `detail_nodes=${usedNodeCount}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "run_agent") {
        if (typeof callbacks.runAgent !== "function") {
          throw new Error("runAgent callback is missing");
        }
        const executionOutcome = await executeRunAgentWithRecovery({
          action,
          callbacks,
          jobId,
          detailContext,
          label,
          provider,
          agents,
          runtimeExecutionPolicy,
          outputs,
          results,
          activeRouteSignals,
        });
        let runResult = executionOutcome?.runResult;
        if (executionOutcome?.awaitUserRequest) {
          const delegatedRecovery = await tryResolveAwaitUserRequestByDelegate({
            awaitUserRequest: executionOutcome.awaitUserRequest,
            action,
            callbacks,
            jobId,
            detailContext,
            agents,
            outputs,
            results,
            activeRouteSignals,
          });
          if (!delegatedRecovery?.resolved) {
            awaitUserRequest = delegatedRecovery?.awaitUserRequest || executionOutcome.awaitUserRequest;
            blockedActions += 1;
            blockedIndex = i;
            remainingActions = executableActions.slice(i + 1);
            break;
          }
          detailContext = String(delegatedRecovery?.detailContext || executionOutcome?.detailContext || detailContext || '');
          runResult = delegatedRecovery?.runResult || runResult;
        } else {
          detailContext = String(executionOutcome?.detailContext || detailContext || '');
        }
        const outputText = String(runResult?.output || "");
        const routeSignals = resolveActionRouteSignals({ action, result: runResult });
        const unmetRequirements = Array.isArray(runResult?.unmet_requirements) ? runResult.unmet_requirements : [];
        outputs.push(attachRouteSignals({
          agentId: String(action.agent_id || "").trim().toLowerCase(),
          provider: String(runResult?.provider || provider || "").trim().toLowerCase(),
          mode: String(runResult?.mode || ""),
          output: outputText,
          jobId: String(jobId || ""),
          slot_id: String(action?.inputs?.slot_id || '').trim() || undefined,
          runtime_instance_id: String(action?.inputs?.runtime_instance_id || '').trim() || undefined,
          recovered: executionOutcome?.recovered === true || undefined,
          failure_recovery: executionOutcome?.failure ? {
            category: executionOutcome.failure.category,
            strategy: executionOutcome.failure.recovery_strategy,
          } : undefined,
          unmet_requirements: unmetRequirements.length > 0 ? unmetRequirements : undefined,
          delivery_requirements: runResult?.delivery_requirements,
        }, routeSignals, { activeSignals: activeRouteSignals }));
        results.push({
          label,
          status: unmetRequirements.length > 0 ? "blocked" : "ok",
          note: unmetRequirements.length > 0
            ? `provider=${provider || "unknown"} · unmet=${unmetRequirements.map((row) => String(row?.code || '').trim()).filter(Boolean).join(',') || 'requirements'}`
            : (executionOutcome?.recovered === true
              ? `provider=${provider || "unknown"} · recovered=${String(executionOutcome?.failure?.recovery_strategy || 'retry_once')}`
              : `provider=${provider || "unknown"}`),
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "spawn_agents") {
        if (typeof callbacks.spawnAgents !== "function") {
          throw new Error("spawnAgents callback is missing");
        }
        const spawned = await callbacks.spawnAgents({
          action,
          jobId,
          detailContext,
        });
        const children = Array.isArray(spawned?.children) ? spawned.children : [];
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "spawn_agents",
          output: String(spawned?.summary || spawned?.text || "").trim() || `spawn finished (${children.length})`,
          children,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `children=${children.length}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "spawn_parallel") {
        if (typeof callbacks.spawnAgents !== "function") {
          throw new Error("spawnAgents callback is missing");
        }
        const spawned = await callbacks.spawnAgents({
          action: {
            type: "spawn_agents",
            summary: String(action?.label || action?.prompt || "").trim(),
            max_parallel: Number(action?.inputs?.max_parallel || action?.agents?.length || 0) || undefined,
            agents: asObject(action)?.agents instanceof Array
              ? action.agents.map((child) => ({
                agent_id: String(child?.agent || child?.agent_id || "").trim().toLowerCase(),
                goal: String(child?.prompt || child?.goal || "").trim(),
                inputs: child?.inputs && typeof child.inputs === "object" ? child.inputs : {},
              }))
              : [],
          },
          jobId,
          detailContext,
        });
        const children = Array.isArray(spawned?.children) ? spawned.children : [];
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "spawn_parallel",
          output: String(spawned?.summary || spawned?.text || "").trim() || `parallel spawn finished (${children.length})`,
          children,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `children=${children.length}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "synthesize_final") {
        if (typeof callbacks.runAgent !== "function") {
          throw new Error("runAgent callback is missing");
        }
        const synthesizedAction = {
          type: "run_agent",
          agent_id: String(action?.agent || action?.agent_id || "").trim().toLowerCase(),
          goal: String(action?.prompt || action?.goal || "").trim(),
          inputs: action?.inputs && typeof action.inputs === "object" ? action.inputs : {},
        };
        const executionOutcome = await executeRunAgentWithRecovery({
          action: synthesizedAction,
          callbacks,
          jobId,
          detailContext,
          label,
          provider: String(provider || 'unknown').trim().toLowerCase(),
          agents,
          runtimeExecutionPolicy,
          outputs,
          results,
          activeRouteSignals,
        });
        let runResult = executionOutcome?.runResult;
        if (executionOutcome?.awaitUserRequest) {
          const delegatedRecovery = await tryResolveAwaitUserRequestByDelegate({
            awaitUserRequest: executionOutcome.awaitUserRequest,
            action: synthesizedAction,
            callbacks,
            jobId,
            detailContext,
            agents,
            outputs,
            results,
            activeRouteSignals,
          });
          if (!delegatedRecovery?.resolved) {
            awaitUserRequest = delegatedRecovery?.awaitUserRequest || executionOutcome.awaitUserRequest;
            blockedActions += 1;
            blockedIndex = i;
            remainingActions = executableActions.slice(i + 1);
            break;
          }
          detailContext = String(delegatedRecovery?.detailContext || executionOutcome?.detailContext || detailContext || '');
          runResult = delegatedRecovery?.runResult || runResult;
        } else {
          detailContext = String(executionOutcome?.detailContext || detailContext || '');
        }
        const routeSignals = resolveActionRouteSignals({ action, result: runResult });
        outputs.push(attachRouteSignals({
          agentId: String(action?.agent || "").trim().toLowerCase() || "synthesizer",
          provider: String(runResult?.provider || "unknown").trim().toLowerCase(),
          mode: "synthesize_final",
          output: String(runResult?.output || ""),
          jobId: String(jobId || ""),
          slot_id: String(action?.inputs?.slot_id || '').trim() || undefined,
          runtime_instance_id: String(action?.inputs?.runtime_instance_id || '').trim() || undefined,
          recovered: executionOutcome?.recovered === true || undefined,
        }, routeSignals, { activeSignals: activeRouteSignals }));
        results.push({ label, status: "ok", note: executionOutcome?.recovered === true ? "final synthesis · recovered" : "final synthesis" });
        usedActions += 1;
        continue;
      }

      if (action.type === "propose_agent") {
        if (typeof callbacks.proposeAgent !== "function") {
          throw new Error("proposeAgent callback is missing");
        }
        const draft = await callbacks.proposeAgent({
          action,
          jobId,
          userId,
          chatId,
        });
        results.push({
          label,
          status: "ok",
          note: `draft=${draft?.draft_id || draft?.id || action.agent_id || "unknown"}`,
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "create_agent") {
        if (typeof callbacks.createAgent !== "function") {
          throw new Error("createAgent callback is missing");
        }
        const created = await callbacks.createAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        const createdAgentId = String(created?.agent_id || action.agent?.id || "").trim().toLowerCase();
        const createdAgentName = String(created?.name || action.agent?.name || "").trim();
        const createdAgentLabel = createdAgentId
          ? formatChatAgentDisplayName(createdAgentId, agentDisplayIndex, {
            nameHint: createdAgentName,
          })
          : (createdAgentName || "");
        const createdOutput = replaceAgentMentions(String(created?.text || created?.message || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [createdAgentId],
          nameHints: { [createdAgentId]: createdAgentName },
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "create_agent",
          output: createdOutput
            || (createdAgentLabel ? `agent 생성 완료: ${createdAgentLabel}` : "agent 생성 완료"),
          jobId: String(jobId || ""),
        });
        results.push({
          label,
          status: "ok",
          note: createdAgentLabel || "created",
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "update_agent") {
        if (typeof callbacks.updateAgent !== "function") {
          throw new Error("updateAgent callback is missing");
        }
        const updated = await callbacks.updateAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        const targetAgentId = String(updated?.agent_id || action.agentId || "").trim().toLowerCase();
        const targetAgentName = String(updated?.name || action?.patch?.name || "").trim();
        const targetAgentLabel = targetAgentId
          ? formatChatAgentDisplayName(targetAgentId, agentDisplayIndex, {
            nameHint: targetAgentName,
          })
          : (targetAgentName || "");
        const updatedOutput = replaceAgentMentions(String(updated?.text || updated?.message || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [targetAgentId],
          nameHints: { [targetAgentId]: targetAgentName },
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "update_agent",
          output: updatedOutput
            || (targetAgentLabel ? `agent 수정 완료: ${targetAgentLabel}` : "agent 수정 완료"),
          jobId: String(jobId || ""),
        });
        results.push({
          label,
          status: "ok",
          note: targetAgentLabel || "updated",
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "create_agent_definition") {
        if (typeof callbacks.createAgentDefinition !== "function") {
          throw new Error("createAgentDefinition callback is missing");
        }
        const created = await callbacks.createAgentDefinition({
          action,
          jobId,
          chatId,
          userId,
        });
        const createdAgentId = String(
          created?.agent_id
          || created?.id
          || action?.agent_spec?.id
          || ""
        ).trim().toLowerCase();
        const createdAgentName = String(
          created?.name
          || action?.agent_spec?.name
          || ""
        ).trim();
        const createdAgentLabel = createdAgentId
          ? formatChatAgentDisplayName(createdAgentId, agentDisplayIndex, {
            nameHint: createdAgentName,
          })
          : (createdAgentName || "");
        const createdOutput = replaceAgentMentions(String(created?.text || created?.message || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [createdAgentId],
          nameHints: { [createdAgentId]: createdAgentName },
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "create_agent_definition",
          output: createdOutput
            || (createdAgentLabel ? `agent definition 생성 완료: ${createdAgentLabel}` : "agent definition 생성 완료"),
          agent_id: createdAgentId,
          created_node_id: String(created?.created_node_id || created?.node_id || "").trim() || undefined,
          added_to_conversation: created?.added_to_conversation === true,
          jobId: String(jobId || ""),
        });
        results.push({
          label,
          status: "ok",
          note: createdAgentLabel || "created",
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "fork_agent") {
        if (typeof callbacks.forkAgent !== "function") {
          throw new Error("forkAgent callback is missing");
        }
        const forked = await callbacks.forkAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        const nextId = String(
          forked?.agent_id
          || forked?.id
          || ""
        ).trim().toLowerCase();
        const nextAgentName = String(forked?.name || "").trim();
        const nextAgentLabel = nextId
          ? formatChatAgentDisplayName(nextId, agentDisplayIndex, {
            nameHint: nextAgentName,
          })
          : (nextAgentName || "");
        const sourceAgentId = String(action.agent_id || "").trim().toLowerCase();
        const forkedOutput = replaceAgentMentions(String(forked?.text || forked?.message || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [sourceAgentId, nextId],
          nameHints: { [nextId]: nextAgentName },
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "fork_agent",
          output: forkedOutput
            || (nextAgentLabel ? `agent fork 완료: ${nextAgentLabel}` : "agent fork 완료"),
          agent_id: nextId || undefined,
          source_agent_id: sourceAgentId || undefined,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: nextAgentLabel || "forked" });
        usedActions += 1;
        continue;
      }

      if (action.type === "search_public_agents") {
        if (typeof callbacks.searchPublicAgents !== "function") {
          throw new Error("searchPublicAgents callback is missing");
        }
        const found = await callbacks.searchPublicAgents({
          action,
          jobId,
          chatId,
          userId,
        });
        const list = Array.isArray(found?.items) ? found.items : [];
        const lines = list.length > 0
          ? list.map((row, index) => {
            const blueprintId = String(row?.blueprint_id || "").trim();
            const title = String(row?.title || "").trim();
            const tags = Array.isArray(row?.tags) && row.tags.length > 0 ? ` tags=${row.tags.join(",")}` : "";
            return `${index + 1}. ${title || blueprintId || "agent"}${blueprintId ? ` (blueprint=${blueprintId})` : ""}${tags}`;
          }).join("\n")
          : "검색 결과가 없습니다.";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "public_search",
          output: lines,
          items: list,
          query: String(action.query || ""),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `candidates=${list.length}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "install_agent_blueprint") {
        if (typeof callbacks.installAgentBlueprint !== "function") {
          throw new Error("installAgentBlueprint callback is missing");
        }
        const installed = await callbacks.installAgentBlueprint({
          action,
          jobId,
          chatId,
          userId,
          outputs,
          results,
        });
        const agentId = String(installed?.agent_id || "").trim().toLowerCase();
        const blueprintId = String(installed?.blueprint_id || "").trim();
        const installedAgentName = String(
          installed?.agent_name
          || installed?.name
          || installed?.title
          || ""
        ).trim();
        const installedAgentLabel = agentId
          ? formatChatAgentDisplayName(agentId, agentDisplayIndex, {
            nameHint: installedAgentName,
          })
          : installedAgentName;
        const line = installedAgentLabel
          ? `설치 완료: ${installedAgentLabel}\n이제 ${installedAgentLabel} 로 사용 가능`
          : "설치 완료";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "install_agent_blueprint",
          output: line,
          installed_agent_id: agentId,
          installed_agent_name: installedAgentName || undefined,
          installed_agent_label: installedAgentLabel || undefined,
          blueprint_id: blueprintId,
          public_node_id: String(installed?.public_node_id || "").trim(),
          node_id: String(installed?.node_id || installed?.created?.id || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: installedAgentLabel || blueprintId || "installed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "publish_agent") {
        if (typeof callbacks.publishAgent !== "function") {
          throw new Error("publishAgent callback is missing");
        }
        const requested = await callbacks.publishAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        const requestId = String(
          requested?.request_id
          || requested?.id
          || requested?.publish_request_id
          || ""
        ).trim();
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "publish_agent_request",
          output: requestId
            ? `공개 요청 접수됨: request_id=${requestId}\n관리자 승인 후 라이브러리에 반영됩니다.`
            : "공개 요청이 생성되었습니다. 관리자 승인 후 반영됩니다.",
          request_id: requestId,
          source_node_id: String(requested?.source_node_id || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: requestId || "request created" });
        usedActions += 1;
        continue;
      }

      if (action.type === "add_agent_to_conversation") {
        if (typeof callbacks.addAgentToConversation !== "function") {
          throw new Error("addAgentToConversation callback is missing");
        }
        const changed = await callbacks.addAgentToConversation({
          action,
          jobId,
          chatId,
          userId,
        });
        const targetAgentId = String(action.agent_id || changed?.agent_id || "").trim().toLowerCase();
        const enabledAgents = Array.isArray(changed?.enabled_agents) ? changed.enabled_agents : [];
        const targetAgentDisplay = formatChatAgentDisplayName(targetAgentId, agentDisplayIndex);
        const enabledAgentDisplays = enabledAgents.map((id) => formatChatAgentDisplayName(id, agentDisplayIndex));
        const baseOutput = `✅ conversation agent 추가: ${targetAgentDisplay}${enabledAgentDisplays.length > 0 ? `\nenabled=${enabledAgentDisplays.join(", ")}` : ""}`;
        const changedOutput = replaceAgentMentions(String(changed?.text || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [targetAgentId, ...enabledAgents],
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "conversation_agent_add",
          output: changedOutput && changedOutput !== baseOutput
            ? `${baseOutput}\n${changedOutput}`
            : baseOutput,
          agent_id: targetAgentId || undefined,
          enabled_agents: enabledAgents,
          membership_change: changed?.membership_change && typeof changed.membership_change === "object"
            ? changed.membership_change
            : undefined,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: targetAgentId ? targetAgentDisplay : "added" });
        usedActions += 1;
        continue;
      }

      if (action.type === "remove_agent_from_conversation") {
        if (typeof callbacks.removeAgentFromConversation !== "function") {
          throw new Error("removeAgentFromConversation callback is missing");
        }
        const changed = await callbacks.removeAgentFromConversation({
          action,
          jobId,
          chatId,
          userId,
        });
        const targetAgentId = String(action.agent_id || changed?.agent_id || "").trim().toLowerCase();
        const enabledAgents = Array.isArray(changed?.enabled_agents) ? changed.enabled_agents : [];
        const targetAgentDisplay = formatChatAgentDisplayName(targetAgentId, agentDisplayIndex);
        const enabledAgentDisplays = enabledAgents.map((id) => formatChatAgentDisplayName(id, agentDisplayIndex));
        const baseOutput = `🛑 conversation agent 제거: ${targetAgentDisplay}${enabledAgentDisplays.length > 0 ? `\nenabled=${enabledAgentDisplays.join(", ")}` : ""}`;
        const changedOutput = replaceAgentMentions(String(changed?.text || "").trim(), {
          agentIndex: agentDisplayIndex,
          agentIds: [targetAgentId, ...enabledAgents],
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "conversation_agent_remove",
          output: changedOutput && changedOutput !== baseOutput
            ? `${baseOutput}\n${changedOutput}`
            : baseOutput,
          agent_id: targetAgentId || undefined,
          enabled_agents: enabledAgents,
          membership_change: changed?.membership_change && typeof changed.membership_change === "object"
            ? changed.membership_change
            : undefined,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: targetAgentId ? targetAgentDisplay : "removed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "open_context") {
        if (typeof callbacks.openContext !== "function") {
          throw new Error("openContext callback is missing");
        }
        const opened = await callbacks.openContext({
          action,
          jobId,
          chatId,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "context_link",
          output: String(opened?.text || opened?.link || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: String(opened?.scope || action.scope || "current") });
        usedActions += 1;
        continue;
      }

      if (action.type === "disable_agent" || action.type === "enable_agent" || action.type === "disable_tool" || action.type === "enable_tool") {
        if (typeof callbacks.updateJobConfigSelection !== "function") {
          throw new Error("updateJobConfigSelection callback is missing");
        }
        const kind = action.type.endsWith("_tool") ? "tool" : "agent";
        const op = action.type.startsWith("enable_") ? "enable" : "disable";
        const targetId = kind === "tool"
          ? String(action.tool_id || "").trim().toLowerCase()
          : String(action.agent_id || "").trim().toLowerCase();
        if (!targetId) throw new Error(`${action.type} requires ${kind}_id`);

        const updated = await callbacks.updateJobConfigSelection({
          jobId,
          op,
          kind,
          id: targetId,
          action,
          chatId,
          userId,
        });
        const marker = op === "enable" ? "✅" : "🚫";
        const targetDisplay = kind === "agent"
          ? formatChatAgentDisplayName(targetId, agentDisplayIndex)
          : targetId;
        const line = kind === "agent"
          ? `${marker} ${targetDisplay} ${op === "enable" ? "enabled" : "disabled"}`
          : `${marker} tool ${targetId} ${op === "enable" ? "enabled" : "disabled"}`;
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "job_config_selection",
          output: line,
          kind,
          op,
          id: targetId,
          updated: updated || null,
          membership_change: updated?.membership_change && typeof updated.membership_change === "object"
            ? updated.membership_change
            : undefined,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: line.replace(/^[✅🚫]\s*/, "") });
        usedActions += 1;
        const immediateApply = kind === "agent"
          && String(updated?.source || "").trim().toLowerCase() === "conversation_agents";
        if (!immediateApply && i < executableActions.length - 1) {
          results.push({
            label: "selection_update",
            status: "skip",
            note: "job_config updated; apply on next /chat",
          });
        }
        if (!immediateApply) break;
        continue;
      }

      if (action.type === "list_agents") {
        let text = "";
        if (typeof callbacks.listAgents === "function") {
          const listed = await callbacks.listAgents({
            action,
            jobId,
            chatId,
            userId,
          });
          text = String(listed?.text || "").trim();
        }
        if (!text) {
          const ids = (Array.isArray(agents) ? agents : [])
            .map((row) => String(row?.id || "").trim().toLowerCase())
            .filter(Boolean);
          text = ids.length > 0
            ? `현재 job에서 사용 가능한 agent:\n${ids.map((id) => `- ${formatChatAgentDisplayName(id, agentDisplayIndex)}`).join("\n")}`
            : "현재 job에서 사용 가능한 agent가 없습니다.";
        }
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "list_agents",
          output: text,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "listed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "list_tools") {
        let text = "";
        if (typeof callbacks.listTools === "function") {
          const listed = await callbacks.listTools({
            action,
            jobId,
            chatId,
            userId,
          });
          text = String(listed?.text || "").trim();
        }
        if (!text) {
          const ids = (Array.isArray(tools) ? tools : [])
            .map((row) => String(row?.id || row?.name || "").trim().toLowerCase())
            .filter(Boolean);
          text = ids.length > 0
            ? `현재 job에서 사용 가능한 tool:\n${ids.map((id) => `- ${id}`).join("\n")}`
            : "현재 job에서 사용 가능한 tool이 없습니다.";
        }
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "list_tools",
          output: text,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "listed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "get_status") {
        if (typeof callbacks.getStatus !== "function") {
          throw new Error("getStatus callback is missing");
        }
        const status = await callbacks.getStatus({
          action,
          chatId,
          jobId,
          userId,
          sessionStore,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "get_status",
          output: String(status?.text || "").trim() || "현재 상태를 확인했습니다.",
          status: status?.status || null,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "status" });
        usedActions += 1;
        continue;
      }

      if (action.type === "interrupt") {
        if (typeof callbacks.interrupt !== "function") {
          throw new Error("interrupt callback is missing");
        }
        const interrupted = await callbacks.interrupt({
          action,
          chatId,
          jobId,
          userId,
        });
        const mode = String(action.mode || interrupted?.mode || "replan").trim().toLowerCase() === "cancel"
          ? "cancel"
          : "replan";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "interrupt",
          output: String(interrupted?.text || "").trim()
            || (mode === "cancel" ? "⛔️ 현재 실행을 중단했습니다." : "🔄 재계획을 위해 현재 실행을 선점 중단합니다."),
          interrupt_mode: mode,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `mode=${mode}` });
        usedActions += 1;
        blockedIndex = i;
        remainingActions = executableActions.slice(i + 1);
        interruptedByReplan = true;
        break;
      }

      if (action.type === "summarize") {
        if (typeof callbacks.summarize === "function") {
          const summary = await callbacks.summarize({
            action,
            jobId,
            outputs,
            results,
            detailContext,
          });
          if (summary?.text) {
            outputs.push({
              agentId: "supervisor",
              provider: "system",
              mode: "summary",
              output: String(summary.text),
              jobId: String(jobId || ""),
            });
          }
        }
        results.push({ label, status: "ok", note: action.hint || "checkpoint" });
        usedActions += 1;
        continue;
      }

      if (action.type === "checkpoint") {
        results.push({
          label,
          status: "ok",
          note: action?.inputs?.checkpoint_status || action?.hint || "checkpoint",
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "supervisor_decision") {
        if (typeof callbacks.summarize === "function") {
          const summary = await callbacks.summarize({
            action,
            jobId,
            outputs,
            results,
            detailContext,
          });
          if (summary?.text) {
            outputs.push({
              agentId: "supervisor",
              provider: "system",
              mode: "supervisor_decision",
              output: String(summary.text),
              jobId: String(jobId || ""),
            });
          }
        }
        results.push({ label, status: "ok", note: "supervisor decision" });
        usedActions += 1;
        continue;
      }

      if (action.type === "gate_wait") {
        const conditions = summarizeConditions(action?.inputs?.incoming_conditions);
        const needsApproval = action?.inputs?.approval_required === true;
        const approved = isMutatingApproved(action);
        if (needsApproval && !approved) {
          blockedActions += 1;
          blockedIndex = i;
          remainingActions = executableActions.slice(i);
          pendingApproval = buildStructuralPendingApproval({
            action,
            agentIndex: agentDisplayIndex,
            chatId,
            jobId,
            userId,
            results,
            outputs,
            blockedIndex: i,
            remainingActions,
            reason: conditions
              ? `${String(action?.label || action?.prompt || 'gate').trim()} · ${conditions}`
              : String(action?.label || action?.prompt || 'gate approval required').trim(),
            gateType: String(action?.inputs?.gate_type || 'approval').trim() || 'approval',
          });
          results.push({ label, status: "blocked", note: pendingApproval.reason });
          if (sessionStore) {
            sessionStore.upsert(chatId, {
              state: "awaiting_approval",
              pending_approval: pendingApproval,
            });
          }
          break;
        }
        outputs.push(attachRouteSignals({
          agentId: 'system',
          provider: 'system',
          mode: 'gate_wait',
          output: conditions
            ? `${String(action?.label || action?.prompt || 'gate').trim()} · ${conditions}`
            : String(action?.label || action?.prompt || 'gate reached').trim(),
          jobId: String(jobId || ''),
          approved: approved || undefined,
        }, resolveActionRouteSignals({ action, result: { route_signals: action?.inputs?.selected_route_signals || [] } }), { activeSignals: activeRouteSignals }));
        results.push({ label, status: "ok", note: conditions || action?.inputs?.gate_type || "gate" });
        usedActions += 1;
        continue;
      }

      if (action.type === "human_checkpoint") {
        const approved = isMutatingApproved(action);
        if (!approved) {
          blockedActions += 1;
          blockedIndex = i;
          remainingActions = executableActions.slice(i);
          pendingApproval = buildStructuralPendingApproval({
            action,
            agentIndex: agentDisplayIndex,
            chatId,
            jobId,
            userId,
            results,
            outputs,
            blockedIndex: i,
            remainingActions,
            reason: String(action?.label || action?.prompt || 'human checkpoint').trim(),
            gateType: 'human_checkpoint',
            runtimePolicySummary: buildPendingRuntimePolicySummary({
              action,
              runtimeSnapshot,
              agents,
            }),
          });
          results.push({ label, status: "blocked", note: pendingApproval.reason });
          if (sessionStore) {
            sessionStore.upsert(chatId, {
              state: "awaiting_approval",
              pending_approval: pendingApproval,
            });
          }
          break;
        }
        outputs.push(attachRouteSignals({
          agentId: 'system',
          provider: 'system',
          mode: 'human_checkpoint',
          output: String(action?.label || action?.prompt || 'human checkpoint approved').trim(),
          jobId: String(jobId || ''),
          approved: true,
        }, resolveActionRouteSignals({ action, result: { route_signals: action?.inputs?.selected_route_signals || [] } }), { activeSignals: activeRouteSignals }));
        results.push({ label, status: "ok", note: 'human checkpoint approved' });
        usedActions += 1;
        continue;
      }

      if (action.type === "tool_proxy_call") {
        let proxyResult = null;
        let repairLoopResult = null;
        if (typeof callbacks.toolProxyCall === "function") {
          proxyResult = await callbacks.toolProxyCall({ action, jobId, outputs, results, detailContext });
          outputs.push(attachRouteSignals({
            agentId: 'system',
            provider: 'system',
            mode: 'tool_proxy_call',
            output: String(proxyResult?.text || proxyResult?.output || action?.label || 'tool proxy step').trim(),
            jobId: String(jobId || ''),
          }, resolveActionRouteSignals({ action, result: proxyResult }), { activeSignals: activeRouteSignals }));
          const shouldRepair = proxyResult?.ok !== true
            && Array.isArray(proxyResult?.route_signals)
            && proxyResult.route_signals.includes('verification_failed')
            && (action?.inputs?.repair_target_agent_id || action?.inputs?.repair_agent_id)
            && typeof callbacks.runAgent === 'function';
          if (shouldRepair) {
            repairLoopResult = await runVerificationRepairLoop({
              action,
              initialProxyResult: proxyResult,
              callbacks,
              jobId,
              detailContext,
              outputs,
              results,
              activeRouteSignals,
              maxAttempts: Number(action?.inputs?.repair_attempt_limit || 1),
            });
            if (repairLoopResult?.proxyResult) proxyResult = repairLoopResult.proxyResult;
          }
        } else {
          const execution = normalizeParticipantExecutionSchema(action?.inputs || {});
          const requiredTools = execution.required_tool_ids.filter(Boolean);
          outputs.push(attachRouteSignals({
            agentId: 'system',
            provider: 'system',
            mode: 'tool_proxy_call',
            output: `${String(action?.label || action?.prompt || 'tool proxy step').trim()}${requiredTools.length > 0 ? ` · required_tools=${requiredTools.join(', ')}` : ''}`,
            jobId: String(jobId || ''),
          }, resolveActionRouteSignals({ action, result: proxyResult }), { activeSignals: activeRouteSignals }));
        }
        const repairRecovered = repairLoopResult?.recovered === true;
        const repairAttempted = Number(repairLoopResult?.attemptsUsed || 0) > 0;
        results.push({
          label,
          status: proxyResult?.ok === false ? "error" : "ok",
          note: repairRecovered
            ? "tool proxy repaired"
            : (repairAttempted ? "tool proxy still failing after repair" : "tool proxy"),
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "memory_sync") {
        let syncResult = null;
        if (typeof callbacks.memorySync === "function") {
          syncResult = await callbacks.memorySync({ action, jobId, outputs, results, detailContext });
          outputs.push(attachRouteSignals({
            agentId: 'system',
            provider: 'system',
            mode: 'memory_sync',
            output: String(syncResult?.text || syncResult?.output || action?.label || 'memory sync').trim(),
            jobId: String(jobId || ''),
          }, resolveActionRouteSignals({ action, result: syncResult }), { activeSignals: activeRouteSignals }));
        } else {
          const memoryKeys = (Array.isArray(action?.inputs?.memory_keys) ? action.inputs.memory_keys : []).filter(Boolean);
          outputs.push(attachRouteSignals({
            agentId: 'system',
            provider: 'system',
            mode: 'memory_sync',
            output: `${String(action?.label || action?.prompt || 'memory sync').trim()}${memoryKeys.length > 0 ? ` · keys=${memoryKeys.join(', ')}` : ''}`,
            jobId: String(jobId || ''),
          }, resolveActionRouteSignals({ action, result: syncResult }), { activeSignals: activeRouteSignals }));
        }
        results.push({ label, status: "ok", note: "memory sync" });
        usedActions += 1;
        continue;
      }

      if (action.type === "committee_consensus") {
        const coverage = summarizeCommitteeCoverage(action, outputs);
        const mode = String(action?.inputs?.consensus_mode || 'majority').trim().toLowerCase() || 'majority';
        const quorumRaw = Number(action?.inputs?.committee_quorum);
        const requiredCount = Number.isFinite(quorumRaw)
          ? Math.max(1, Math.floor(quorumRaw))
          : (mode === 'unanimous' ? coverage.member_slot_ids.length : Math.ceil(coverage.member_slot_ids.length / 2));
        const approved = isMutatingApproved(action);
        if (coverage.responded_count < requiredCount && !approved) {
          blockedActions += 1;
          blockedIndex = i;
          remainingActions = executableActions.slice(i);
          pendingApproval = buildStructuralPendingApproval({
            action,
            agentIndex: agentDisplayIndex,
            chatId,
            jobId,
            userId,
            results,
            outputs,
            blockedIndex: i,
            remainingActions,
            reason: `committee quorum not met: responded=${coverage.responded_count}/${coverage.member_slot_ids.length}, required=${requiredCount}`,
            gateType: 'committee_consensus',
          });
          pendingApproval.committee_coverage = coverage;
          results.push({ label, status: "blocked", note: pendingApproval.reason });
          if (sessionStore) {
            sessionStore.upsert(chatId, {
              state: "awaiting_approval",
              pending_approval: pendingApproval,
            });
          }
          break;
        }
        outputs.push(attachRouteSignals({
          agentId: 'system',
          provider: 'system',
          mode: 'committee_consensus',
          output: `committee readiness satisfied: responded=${coverage.responded_count}/${coverage.member_slot_ids.length}, mode=${mode}, quorum=${requiredCount}${approved && coverage.responded_count < requiredCount ? ' (approved override)' : ''}`,
          jobId: String(jobId || ''),
          committee_coverage: coverage,
          approved: approved || undefined,
        }, resolveActionRouteSignals({ action, result: { route_signals: action?.inputs?.selected_route_signals || [] } }), { activeSignals: activeRouteSignals }));
        results.push({ label, status: "ok", note: `committee_ready ${coverage.responded_count}/${coverage.member_slot_ids.length}` });
        usedActions += 1;
        continue;
      }

      blockedActions += 1;
      results.push({ label, status: "skip", note: "unsupported action" });
    } catch (e) {
      if (isAbortLikeError(e)) throw e;
      const errorMessage = String(e?.message ?? e);
      const membershipConfirmationFailed = e?.membershipConfirmationFailed === true
        || String(e?.code || "").trim().toUpperCase() === "MEMBERSHIP_CONFIRMATION_FAILED";
      if (membershipConfirmationFailed) {
        results.push({ label, status: "error", note: errorMessage });
        blockedActions += 1;
        blockedIndex = i;
        remainingActions = executableActions.slice(i + 1);
        results.push({
          label: "membership_confirmation",
          status: "blocked",
          note: "team membership verification failed; stopped remaining actions",
        });
        break;
      }
      const failure = classifyExecutionFailure({
        error: e,
        action,
        provider,
        runtimeExecutionPolicy,
        agents,
      });
      results.push({ label, status: "error", note: buildFailureResultNote(failure, errorMessage) });
      outputs.push(attachRouteSignals({
        agentId: 'system',
        provider: 'system',
        mode: 'failure',
        output: `${label} 실패 · ${failure.summary}`,
        jobId: String(jobId || ''),
        failure: {
          category: failure.category,
          recovery_strategy: failure.recovery_strategy,
          summary: failure.summary,
        },
      }, ['failure_detected', String(failure.category || '').trim() || 'unknown_failure'], { activeSignals: activeRouteSignals }));
      if (failure.user_action_required) {
        awaitUserRequest = buildAwaitUserRequestFromFailure(failure, { label, action });
        blockedActions += 1;
        blockedIndex = i;
        remainingActions = executableActions.slice(i + 1);
        results.push({ label: 'await_user', status: 'blocked', note: awaitUserRequest.followup_hint });
        break;
      }
    }

    const interruptAfter = readInterruptState(sessionStore, chatId);
    if (interruptAfter?.requested) {
      if (interruptAfter.mode === "cancel") {
        throw makeCancelledError(interruptAfter.reason || `interrupt(cancel) after ${label}`);
      }
      blockedIndex = i;
      remainingActions = executableActions.slice(i + 1);
      interruptedByReplan = true;
      results.push({
        label: "interrupt",
        status: "skip",
        note: interruptAfter.reason
          ? `replan requested after ${label}: ${interruptAfter.reason}`
          : `replan requested after ${label}`,
      });
      break;
    }
  }

  if (sessionStore) {
    sessionStore.upsert(chatId, {
      state: pendingApproval
        ? "awaiting_approval"
        : (awaitUserRequest
          ? "awaiting_user"
          : (interruptedByReplan ? "idle" : "done")),
      pending_approval: pendingApproval,
      pending_user_request: awaitUserRequest,
      interrupt: null,
      budget: {
        max_actions: maxActions,
        used_actions: usedActions,
        blocked_actions: blockedActions,
      },
    });
  }

  return {
    results,
    outputs,
    currentJobId: String(jobId || ""),
    detailContext,
    pendingApproval,
    await_user_request: awaitUserRequest,
    blocked_index: blockedIndex,
    remaining_actions: remainingActions,
  };
}
