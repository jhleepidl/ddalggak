import {
  buildFailureRecoveryScoutGoal,
  buildRecoveryAttemptEvent,
  classifyExecutionFailure,
  findRecoveryScoutAgentId,
} from "../application/failure_recovery_policy.js";
import {
  attachRouteSignals,
  resolveActionRouteSignals,
} from "./structural_runtime.js";
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

export function isAbortLikeError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "ECANCELLED" || code === "ABORT_ERR") return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("cancelled")
    || message.includes("aborted")
    || message.includes("aborterror");
}

export function makeCancelledError(reason = "cancelled") {
  const e = new Error(String(reason || "cancelled"));
  e.code = "ECANCELLED";
  return e;
}

export function readInterruptState(sessionStore, chatId) {
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

export function summarizeVerificationResult(proxyResult = {}) {
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

export function buildRepairPrompt({
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

export function buildVerifierPrompt({
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

export function summarizeCommitteeCoverage(action = {}, outputs = []) {
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

export async function runVerificationRepairLoop({
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

export function appendSessionForkEvent(sessionStore, chatId, event = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function') return;
  const cleanChatId = String(chatId || '').trim();
  if (!cleanChatId) return;
  sessionStore.upsert(cleanChatId, (session = {}) => {
    const events = Array.isArray(session?.fork_events) ? session.fork_events.slice(-11) : [];
    const nextEvents = [...events, event].slice(-12);
    return {
      fork_events: nextEvents,
      last_fork_event: event,
      fork_state: {
        status: String(event?.status || '').trim().toLowerCase() || 'forked',
        source_agent_id: String(event?.source_agent_id || '').trim().toLowerCase() || undefined,
        forked_agent_id: String(event?.forked_agent_id || event?.agent_id || '').trim().toLowerCase() || undefined,
        updated_at: String(event?.ts || new Date().toISOString()),
      },
    };
  });
}

export function appendSessionRejoinEvent(sessionStore, chatId, event = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function') return;
  const cleanChatId = String(chatId || '').trim();
  if (!cleanChatId) return;
  sessionStore.upsert(cleanChatId, (session = {}) => {
    const events = Array.isArray(session?.rejoin_events) ? session.rejoin_events.slice(-11) : [];
    const nextEvents = [...events, event].slice(-12);
    return {
      rejoin_events: nextEvents,
      last_rejoin_event: event,
      fork_state: {
        status: String(event?.status || '').trim().toLowerCase() || 'rejoined',
        source_agent_id: String(event?.source_agent_id || '').trim().toLowerCase() || undefined,
        forked_agent_id: String(event?.agent_id || event?.forked_agent_id || '').trim().toLowerCase() || undefined,
        updated_at: String(event?.ts || new Date().toISOString()),
      },
    };
  });
}

export function appendSessionRecoveryEvent(sessionStore, chatId, event = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function') return;
  const cleanChatId = String(chatId || '').trim();
  if (!cleanChatId) return;
  sessionStore.upsert(cleanChatId, (session = {}) => {
    const events = Array.isArray(session?.recovery_events) ? session.recovery_events.slice(-11) : [];
    const nextEvents = [...events, event].slice(-12);
    return {
      recovery_events: nextEvents,
      last_recovery_event: event,
      recovery_state: {
        status: String(event?.status || '').trim().toLowerCase() || 'classified',
        category: String(event?.category || '').trim().toLowerCase() || 'unknown_failure',
        recovery_strategy: String(event?.recovery_strategy || '').trim().toLowerCase() || 'stop',
        updated_at: String(event?.ts || new Date().toISOString()),
      },
    };
  });
}

export function buildAwaitUserRequestFromFailure(failure = {}, { label = '', action = {} } = {}) {
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

export async function tryResolveAwaitUserRequestByDelegate({
  awaitUserRequest = null,
  action = {},
  callbacks = {},
  jobId = '',
  detailContext = '',
  agents = [],
  outputs = [],
  results = [],
  activeRouteSignals = new Set(),
  sessionStore = null,
  chatId = '',
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

export async function executeRunAgentWithRecovery({
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
  sessionStore = null,
  chatId = '',
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
      appendSessionRecoveryEvent(sessionStore, chatId, buildRecoveryAttemptEvent({ action, failure, attempt: 1, stage: 'classified', status: 'blocked' }));
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
      appendSessionRecoveryEvent(sessionStore, chatId, buildRecoveryAttemptEvent({ action, failure, attempt: 1, stage: 'retry_scheduled', status: 'retrying' }));
      results.push({ label: `${label} retry`, status: 'ok', note: `auto retry · ${failure.category}` });
      const retried = await callbacks.runAgent({ action, jobId, detailContext });
      appendSessionRecoveryEvent(sessionStore, chatId, buildRecoveryAttemptEvent({ action, failure, attempt: 1, stage: 'retry_succeeded', status: 'resolved' }));
      return { runResult: retried, detailContext, recovered: true, failure, awaitUserRequest: null };
    }

    if (failure.recovery_strategy === 'search_then_retry') {
      const scoutAgentId = findRecoveryScoutAgentId(agents, { excludeAgentId: String(action?.agent_id || '').trim().toLowerCase() });
      if (scoutAgentId) {
        appendSessionRecoveryEvent(sessionStore, chatId, buildRecoveryAttemptEvent({ action, failure, attempt: 1, stage: 'scout_scheduled', status: 'retrying', scoutAgentId }));
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
        appendSessionRecoveryEvent(sessionStore, chatId, buildRecoveryAttemptEvent({ action, failure, attempt: 1, stage: 'scout_retry_succeeded', status: 'resolved', scoutAgentId }));
        return { runResult: retried, detailContext: recoveredDetailContext, recovered: true, failure, awaitUserRequest: null };
      }
    }

    throw error;
  }
}

