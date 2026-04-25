import fs from 'node:fs/promises';

import {
  buildRepoSnapshot,
  collectWorkspaceDiff,
  createImprovementContextBundle,
  formatRepoSnapshotPreview,
  formatWorkspaceDiffPreview,
  resolveImprovementTargetConfig,
  runCommandSequence,
  runShellCommand,
} from './improvement_runtime.js';
import { summarizeLlmTraceIndex } from './llm_trace_recorder.js';
import {
  createImprovementDebugBundle,
  evaluateImprovementGate,
  formatEvalGatePreview,
  inferReviewRisk,
} from './improvement_debug_bundle.js';

function clean(value = '') {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clip(value = '', max = 4000) {
  const raw = clean(value);
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw;
}

function summarizeReportList(reports = []) {
  return asArray(reports).map((entry) => {
    const row = asObject(entry);
    const payload = asObject(row.payload);
    return {
      id: clean(row.id),
      resource_kind: clean(payload.resource_kind),
      phase: clean(payload.phase),
      status: clean(payload.status),
      summary: clip(payload.summary, 240),
      preview_text: clip(row.text || '', 1600),
      payload: asObject(payload.payload),
      metrics: asObject(payload.metrics),
      created_at: clean(row.created_at),
    };
  });
}

export function summarizeBoardForImprovement(board = {}) {
  const lanes = asArray(board?.lanes).map((lane) => asObject(lane));
  const counts = {};
  const rawHistoryStreams = [];
  for (const lane of lanes) {
    const laneId = clean(lane.id);
    counts[laneId] = Number(lane.count || asArray(lane.cards).length || 0);
    if (laneId === 'raw_history') {
      for (const card of asArray(lane.cards)) {
        const stream = clean(card.history_stream_key || card.payload?.history_stream_key);
        if (stream) rawHistoryStreams.push(stream);
      }
    }
  }
  return {
    counts,
    raw_history_streams: rawHistoryStreams.slice(0, 24),
    candidate_count: Number(counts.promotion_candidates || 0),
    raw_history_count: Number(counts.raw_history || 0),
  };
}

async function report(client, threadId, jobId, body) {
  if (!client || typeof client.reportImprovementJob !== 'function') return null;
  return await client.reportImprovementJob(threadId, jobId, body);
}

export async function createImprovementJobWithContext({
  client,
  threadId = '',
  targetRepo = '',
  instruction = '',
  requestedBy = '',
  targetRuntime = 'forge',
  workspaceRoot = '',
  board = null,
  autoMode = false,
  autoPromote = false,
} = {}) {
  const cleanThreadId = clean(threadId);
  if (!client || typeof client.createImprovementJob !== 'function') {
    throw new Error('createImprovementJobWithContext requires client.createImprovementJob');
  }
  if (!cleanThreadId) throw new Error('threadId is required');
  const boardSummary = summarizeBoardForImprovement(board || {});
  const created = await client.createImprovementJob(cleanThreadId, {
    target_repo: clean(targetRepo),
    instruction: clean(instruction),
    target_runtime: clean(targetRuntime) || 'forge',
    requested_by: clean(requestedBy) || undefined,
    workspace_root: clean(workspaceRoot) || undefined,
    related_history_streams: boardSummary.raw_history_streams,
    meta: {
      board_counts: boardSummary.counts,
      auto_mode: autoMode === true,
      auto_promote: autoPromote === true,
    },
    labels: ['telegram', 'self-improve', autoMode ? 'auto' : 'manual'].filter(Boolean),
  });
  const job = asObject(created?.job);
  const payload = asObject(job.payload);
  const jobId = clean(payload.job_id || payload.improvement_job_id || job.id);
  if (jobId) {
    await report(client, cleanThreadId, jobId, {
      kind: 'runtime_event',
      phase: 'history_loaded',
      status: 'in_progress',
      title: 'Board snapshot',
      summary: `raw_history=${boardSummary.raw_history_count} · candidates=${boardSummary.candidate_count}`,
      preview_text: JSON.stringify(boardSummary, null, 2),
      payload: boardSummary,
      labels: ['board', 'history'],
    });
  }
  return created;
}

export async function runImprovementTests({ client, threadId = '', jobId = '', targetConfig = {} } = {}) {
  const result = await runCommandSequence(targetConfig.test_commands || [], {
    cwd: clean(targetConfig.workspace_root) || undefined,
  });
  await report(client, threadId, jobId, {
    kind: 'test_report',
    phase: result.ok ? 'tests_passed' : 'tests_failed',
    status: result.status,
    summary: result.ok
      ? `test commands passed (${Number(result.command_count || 0)})`
      : `test commands failed (${Number(result.command_count || 0)})`,
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: { results: result.results || [] },
    metrics: {
      duration_ms: Number(result.duration_ms || 0),
      command_count: Number(result.command_count || 0),
      passed: result.ok ? Number(result.command_count || 0) : Number((result.results || []).filter((entry) => entry.ok).length || 0),
      failed: result.ok ? 0 : 1,
    },
    labels: ['tests'],
  });
  return result;
}

export async function runImprovementCanary({ client, threadId = '', jobId = '', targetConfig = {} } = {}) {
  const commands = asArray(targetConfig.canary_commands).map((entry) => clean(entry)).filter(Boolean);
  if (!commands.length) {
    const skipped = {
      ok: true,
      status: 'skipped',
      command_count: 0,
      results: [],
      duration_ms: 0,
      stdout: '',
      stderr: '',
    };
    await report(client, threadId, jobId, {
      kind: 'canary_result',
      phase: 'canary_skipped',
      status: 'skipped',
      summary: 'no canary command configured',
      preview_text: 'configure SELF_IMPROVE_<TARGET>_CANARY_CMD to enable automatic canary validation',
      payload: {},
      metrics: { command_count: 0 },
      labels: ['canary'],
    });
    return skipped;
  }
  const result = await runCommandSequence(commands, {
    cwd: clean(targetConfig.workspace_root) || undefined,
  });
  await report(client, threadId, jobId, {
    kind: 'canary_result',
    phase: result.ok ? 'canary_passed' : 'canary_failed',
    status: result.status,
    summary: result.ok ? 'canary commands passed' : 'canary commands failed',
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: { results: result.results || [] },
    metrics: {
      duration_ms: Number(result.duration_ms || 0),
      command_count: Number(result.command_count || 0),
    },
    labels: ['canary'],
  });
  return result;
}

function latestReportByKind(reports = [], kind = '') {
  const cleanKind = clean(kind);
  return asArray(reports).find((entry) => clean(asObject(entry).payload?.resource_kind) === cleanKind) || null;
}

function nestedReportPayload(report = {}) {
  return asObject(asObject(report).payload?.payload || asObject(report).payload);
}

function findLatestBundleRoot(reports = []) {
  for (const kind of ['code_diff', 'patch_plan', 'review_report', 'eval_gate']) {
    const reportRow = latestReportByKind(reports, kind);
    const payload = nestedReportPayload(reportRow || {});
    const bundleRoot = clean(payload.bundle_root || payload.bundleRoot);
    if (bundleRoot) return bundleRoot;
  }
  return '';
}

async function ensureImprovementDebugBundleForReview({ workspaceRoot = '', jobId = '', targetConfig = {}, jobPayload = {}, reports = [] } = {}) {
  const existingRoot = findLatestBundleRoot(reports);
  if (existingRoot) {
    return {
      bundle_root: existingRoot,
      debug_dir: `${existingRoot}/debug`,
      review_input_path: `${existingRoot}/debug/review_input.md`,
      created: false,
    };
  }
  const root = clean(workspaceRoot || targetConfig.workspace_root);
  if (!root) {
    return { bundle_root: '', debug_dir: '', review_input_path: '', created: false };
  }
  const bundle = createImprovementContextBundle({
    workspaceRoot: root,
    jobId,
    target: clean(targetConfig.target || jobPayload.improvement_target),
    instruction: clean(jobPayload.instruction),
    jobPayload,
    reports,
    boardSummary: {},
  });
  const debugBundle = createImprovementDebugBundle({
    bundle,
    workspaceRoot: root,
    jobId,
    targetConfig,
    jobPayload,
    reports,
    diff: await collectWorkspaceDiff({ workspaceRoot: root }),
  });
  return {
    bundle_root: bundle.bundle_root,
    debug_dir: debugBundle.debug_dir,
    review_input_path: debugBundle.review_input_path,
    created: true,
  };
}

export async function runImprovementReview({ client, threadId = '', jobId = '', targetConfig = {}, jobPayload = null, reports = null } = {}) {
  const loaded = reports && jobPayload ? { jobPayload, reports, targetConfig } : await loadImprovementExecutionContext({ client, threadId, jobId });
  const resolvedTargetConfig = { ...loaded.targetConfig, ...asObject(targetConfig) };
  const reviewCommand = clean(resolvedTargetConfig.review_command);
  const workspaceRoot = clean(resolvedTargetConfig.workspace_root);
  const reviewBundle = await ensureImprovementDebugBundleForReview({
    workspaceRoot,
    jobId,
    targetConfig: resolvedTargetConfig,
    jobPayload: loaded.jobPayload,
    reports: loaded.reports,
  });
  const bundleRoot = clean(reviewBundle.bundle_root);
  const debugDir = clean(reviewBundle.debug_dir);
  const reviewInputPath = clean(reviewBundle.review_input_path);
  const reviewReportPath = debugDir ? `${debugDir}/review_report.md` : '';
  if (!reviewCommand) {
    const skipped = {
      ok: true,
      status: 'skipped',
      risk: 'unknown',
      duration_ms: 0,
      stdout: '',
      stderr: 'missing review command',
    };
    await report(client, threadId, jobId, {
      kind: 'review_report',
      phase: 'review_skipped',
      status: 'skipped',
      summary: 'no review command configured',
      preview_text: 'configure SELF_IMPROVE_<TARGET>_REVIEW_CMD to enable Gemini or external review',
      payload: { risk: 'unknown', bundle_root: bundleRoot || null, debug_dir: debugDir || null, review_input_path: reviewInputPath || null, debug_bundle_created: reviewBundle.created === true },
      metrics: { duration_ms: 0 },
      labels: ['review'],
    });
    return skipped;
  }
  const result = await runShellCommand(reviewCommand, {
    cwd: workspaceRoot || undefined,
    timeoutMs: Number(resolvedTargetConfig.review_timeout_ms || 300000),
    env: {
      SELF_IMPROVE_JOB_ID: clean(jobId),
      SELF_IMPROVE_TARGET: clean(resolvedTargetConfig.target || loaded.jobPayload.improvement_target),
      SELF_IMPROVE_THREAD_ID: clean(threadId),
      SELF_IMPROVE_WORKSPACE_ROOT: workspaceRoot,
      SELF_IMPROVE_BUNDLE_ROOT: bundleRoot,
      SELF_IMPROVE_DEBUG_DIR: debugDir,
      SELF_IMPROVE_REVIEW_INPUT_PATH: reviewInputPath,
      SELF_IMPROVE_REVIEW_REPORT_PATH: reviewReportPath,
    },
  });
  const risk = inferReviewRisk({ stdout: result.stdout, stderr: result.stderr });
  const status = result.ok ? 'completed' : 'failed';
  await report(client, threadId, jobId, {
    kind: 'review_report',
    phase: result.ok ? 'review_completed' : 'review_failed',
    status,
    summary: result.ok ? `review completed (risk=${risk})` : 'review command failed',
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: {
      command: reviewCommand,
      exit_code: result.exit_code,
      signal: result.signal,
      risk,
      bundle_root: bundleRoot || null,
      debug_dir: debugDir || null,
      review_input_path: reviewInputPath || null,
      review_report_path: reviewReportPath || null,
      debug_bundle_created: reviewBundle.created === true,
    },
    metrics: { duration_ms: Number(result.duration_ms || 0) },
    labels: ['review', risk].filter(Boolean),
  });
  return { ...result, status, risk };
}

export async function runImprovementEvalGate({ client, threadId = '', jobId = '', targetConfig = {}, jobPayload = null, reports = null, reviewResult = null } = {}) {
  const loaded = reports && jobPayload ? { jobPayload, reports, targetConfig } : await loadImprovementExecutionContext({ client, threadId, jobId });
  const resolvedTargetConfig = { ...loaded.targetConfig, ...asObject(targetConfig) };
  const diff = await collectWorkspaceDiff({ workspaceRoot: resolvedTargetConfig.workspace_root });
  const gate = evaluateImprovementGate({
    reports: loaded.reports,
    diff,
    targetConfig: resolvedTargetConfig,
    jobPayload: loaded.jobPayload,
    reviewResult,
  });
  await report(client, threadId, jobId, {
    kind: 'eval_gate',
    phase: gate.status === 'passed' ? 'gate_passed' : gate.status === 'blocked' ? 'gate_blocked' : 'gate_needs_review',
    status: gate.status,
    summary: gate.status === 'passed'
      ? 'promotion gate passed'
      : gate.status === 'blocked'
        ? `promotion gate blocked: ${asArray(gate.reasons)[0] || 'see report'}`
        : `promotion gate needs review: ${asArray(gate.warnings)[0] || 'see report'}`,
    preview_text: formatEvalGatePreview(gate),
    payload: gate,
    metrics: {
      changed_file_count: Number(gate.changed_file_count || 0),
      max_changed_files: Number(gate.max_changed_files || 0),
      blocking_reason_count: asArray(gate.reasons).length,
      warning_count: asArray(gate.warnings).length,
    },
    labels: ['eval-gate', gate.status],
  });
  return { ok: gate.status === 'passed', status: gate.status, gate, diff };
}

export async function markImprovementPromotion({ client, threadId = '', jobId = '', targetConfig = {} } = {}) {
  const promoteCommand = clean(targetConfig.promote_command || targetConfig.restart_command);
  if (!promoteCommand) {
    const result = {
      ok: true,
      status: 'ready_for_promote',
      duration_ms: 0,
      stdout: '',
      stderr: '',
    };
    await report(client, threadId, jobId, {
      kind: 'promotion_decision',
      phase: 'awaiting_approval',
      status: 'ready_for_promote',
      summary: 'manual promote required: no promote command configured',
      preview_text: 'configure SELF_IMPROVE_<TARGET>_PROMOTE_CMD or SELF_IMPROVE_<TARGET>_RESTART_CMD to automate stable promotion',
      payload: {},
      metrics: { duration_ms: 0 },
      labels: ['promote'],
    });
    return result;
  }

  const gateResult = await runImprovementEvalGate({ client, threadId, jobId, targetConfig });
  const allowNeedsReview = targetConfig.promote_allow_needs_review === true;
  if (gateResult.status !== 'passed' && !(allowNeedsReview && gateResult.status === 'needs_review')) {
    const blocked = {
      ok: false,
      status: 'blocked_by_gate',
      duration_ms: 0,
      stdout: '',
      stderr: formatEvalGatePreview(gateResult.gate),
      gate: gateResult.gate,
    };
    await report(client, threadId, jobId, {
      kind: 'promotion_decision',
      phase: 'promotion_blocked',
      status: 'blocked',
      summary: `promote blocked by eval gate (${gateResult.status})`,
      preview_text: formatEvalGatePreview(gateResult.gate),
      payload: { gate: gateResult.gate },
      metrics: { duration_ms: 0 },
      labels: ['promote', 'gate', 'blocked'],
    });
    return blocked;
  }

  const result = await runShellCommand(promoteCommand, {
    cwd: clean(targetConfig.workspace_root) || undefined,
  });
  await report(client, threadId, jobId, {
    kind: 'promotion_decision',
    phase: result.ok ? 'promoted' : 'promotion_failed',
    status: result.ok ? 'promoted' : 'failed',
    summary: result.ok ? 'promote command finished' : 'promote command failed',
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: { command: promoteCommand, exit_code: result.exit_code, signal: result.signal, gate: gateResult.gate },
    metrics: { duration_ms: Number(result.duration_ms || 0) },
    labels: ['promote'],
  });
  return result;
}

export async function runImprovementRollback({ client, threadId = '', jobId = '', targetConfig = {} } = {}) {
  const rollbackCommand = clean(targetConfig.rollback_command);
  if (!rollbackCommand) {
    const result = {
      ok: false,
      status: 'blocked',
      duration_ms: 0,
      stdout: '',
      stderr: 'missing rollback command',
    };
    await report(client, threadId, jobId, {
      kind: 'rollback_report',
      phase: 'rollback_blocked',
      status: 'blocked',
      summary: 'rollback command missing; configure SELF_IMPROVE_<TARGET>_ROLLBACK_CMD',
      preview_text: result.stderr,
      payload: {},
      metrics: { duration_ms: 0 },
      labels: ['rollback'],
    });
    return result;
  }
  const result = await runShellCommand(rollbackCommand, {
    cwd: clean(targetConfig.workspace_root) || undefined,
    env: {
      SELF_IMPROVE_JOB_ID: clean(jobId),
      SELF_IMPROVE_THREAD_ID: clean(threadId),
      SELF_IMPROVE_TARGET: clean(targetConfig.target),
      SELF_IMPROVE_WORKSPACE_ROOT: clean(targetConfig.workspace_root),
    },
  });
  await report(client, threadId, jobId, {
    kind: 'rollback_report',
    phase: result.ok ? 'rolled_back' : 'rollback_failed',
    status: result.ok ? 'rolled_back' : 'failed',
    summary: result.ok ? 'rollback command finished' : 'rollback command failed',
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: { command: rollbackCommand, exit_code: result.exit_code, signal: result.signal },
    metrics: { duration_ms: Number(result.duration_ms || 0) },
    labels: ['rollback'],
  });
  return { ...result, status: result.ok ? 'rolled_back' : 'failed' };
}


export async function inspectAndPrepareImprovementJob({
  client,
  threadId = '',
  targetRepo = '',
  instruction = '',
  requestedBy = '',
  board = null,
  workspaceRoot = '',
  autoMode = false,
  autoPromote = false,
} = {}) {
  const targetConfig = resolveImprovementTargetConfig(targetRepo, { workspaceRoot, autoPromote });
  const created = await createImprovementJobWithContext({
    client,
    threadId,
    targetRepo,
    instruction,
    requestedBy,
    targetRuntime: targetConfig.target_runtime,
    workspaceRoot: targetConfig.workspace_root,
    board,
    autoMode,
    autoPromote: targetConfig.auto_promote || autoPromote,
  });
  const job = asObject(created?.job);
  const payload = asObject(job.payload);
  const jobId = clean(payload.job_id || payload.improvement_job_id || job.id);
  const snapshot = buildRepoSnapshot({
    target: targetRepo,
    workspaceRoot: targetConfig.workspace_root,
    inspectPaths: targetConfig.inspect_paths,
  });
  if (jobId) {
    await report(client, clean(threadId), jobId, {
      kind: 'repo_snapshot',
      phase: 'scoped',
      status: 'in_progress',
      title: 'Repo snapshot',
      summary: `workspace=${clean(targetConfig.workspace_root) || '-'} · runtime=${clean(targetConfig.target_runtime) || '-'}${targetConfig.patch_command ? ' · patch=enabled' : ' · patch=missing'}`,
      preview_text: formatRepoSnapshotPreview(snapshot),
      payload: {
        ...snapshot,
        patch_command_configured: Boolean(targetConfig.patch_command),
        auto_promote: targetConfig.auto_promote === true,
      },
      labels: ['repo', 'snapshot'],
    });
  }
  return {
    jobId,
    targetConfig,
    created,
    snapshot,
  };
}

export async function loadImprovementExecutionContext({ client, threadId = '', jobId = '' } = {}) {
  if (!client || typeof client.getImprovementJob !== 'function') {
    throw new Error('loadImprovementExecutionContext requires client.getImprovementJob');
  }
  const cleanThreadId = clean(threadId);
  const cleanJobId = clean(jobId);
  if (!cleanThreadId || !cleanJobId) throw new Error('threadId and jobId are required');
  const payload = await client.getImprovementJob(cleanThreadId, cleanJobId);
  const job = asObject(payload?.job);
  const jobPayload = asObject(job.payload);
  const targetConfig = resolveImprovementTargetConfig(jobPayload.improvement_target, {
    targetRuntime: jobPayload.target_runtime,
    workspaceRoot: jobPayload.workspace_root,
    autoPromote: Boolean(jobPayload?.meta?.auto_promote),
  });
  return {
    job: payload,
    jobPayload,
    reports: summarizeReportList(payload?.reports),
    targetConfig,
  };
}

export async function runImprovementPatch({
  client,
  threadId = '',
  jobId = '',
  targetConfig = {},
  jobPayload = {},
  reports = [],
  boardSummary = {},
} = {}) {
  const cleanJobId = clean(jobId);
  const workspaceRoot = clean(targetConfig.workspace_root);
  const patchCommand = clean(targetConfig.patch_command);
  const bundle = createImprovementContextBundle({
    workspaceRoot,
    jobId: cleanJobId,
    target: clean(targetConfig.target || jobPayload.improvement_target),
    instruction: clean(jobPayload.instruction),
    jobPayload,
    reports,
    boardSummary,
  });
  const initialDebugBundle = createImprovementDebugBundle({
    bundle,
    workspaceRoot,
    jobId: cleanJobId,
    targetConfig,
    jobPayload,
    reports,
    diff: await collectWorkspaceDiff({ workspaceRoot }),
  });

  await report(client, threadId, cleanJobId, {
    kind: 'patch_plan',
    phase: 'patch_planned',
    status: patchCommand ? 'planned' : 'blocked',
    summary: patchCommand
      ? 'patch command configured; context bundle prepared'
      : 'patch command missing; configure SELF_IMPROVE_<TARGET>_PATCH_CMD',
    preview_text: JSON.stringify({
      bundle_root: bundle.bundle_root,
      manifest_path: bundle.manifest_path,
      instruction_path: bundle.instruction_path,
      reports_path: bundle.reports_path,
      llm_trace_dir: bundle.llm_trace_dir,
      llm_trace_index_path: bundle.llm_trace_index_path,
      debug_dir: initialDebugBundle.debug_dir,
      failure_summary_path: initialDebugBundle.failure_summary_path,
      reproduction_path: initialDebugBundle.reproduction_path,
      artifact_index_path: initialDebugBundle.artifact_index_path,
      review_input_path: initialDebugBundle.review_input_path,
      auto_promote: targetConfig.auto_promote === true,
    }, null, 2),
    payload: {
      bundle_root: bundle.bundle_root,
      manifest_path: bundle.manifest_path,
      instruction_path: bundle.instruction_path,
      reports_path: bundle.reports_path,
      patch_plan_path: bundle.patch_plan_path,
      llm_trace_dir: bundle.llm_trace_dir,
      llm_trace_index_path: bundle.llm_trace_index_path,
      debug_dir: initialDebugBundle.debug_dir,
      failure_summary_path: initialDebugBundle.failure_summary_path,
      reproduction_path: initialDebugBundle.reproduction_path,
      artifact_index_path: initialDebugBundle.artifact_index_path,
      review_input_path: initialDebugBundle.review_input_path,
      auto_promote: targetConfig.auto_promote === true,
    },
    labels: ['patch', 'plan'],
  });

  if (!patchCommand) {
    return {
      ok: false,
      status: 'blocked',
      duration_ms: 0,
      stdout: '',
      stderr: 'missing patch command',
      bundle,
      diff: await collectWorkspaceDiff({ workspaceRoot }),
    };
  }

  const patchEnv = {
    SELF_IMPROVE_JOB_ID: cleanJobId,
    SELF_IMPROVE_TARGET: clean(targetConfig.target || jobPayload.improvement_target),
    SELF_IMPROVE_THREAD_ID: clean(threadId),
    SELF_IMPROVE_WORKSPACE_ROOT: workspaceRoot,
    SELF_IMPROVE_BUNDLE_ROOT: bundle.bundle_root,
    SELF_IMPROVE_MANIFEST_PATH: bundle.manifest_path,
    SELF_IMPROVE_INSTRUCTION_PATH: bundle.instruction_path,
    SELF_IMPROVE_REPORTS_PATH: bundle.reports_path,
    SELF_IMPROVE_PATCH_PLAN_PATH: bundle.patch_plan_path,
    SELF_IMPROVE_PATCH_STDOUT_PATH: bundle.patch_stdout_path,
    SELF_IMPROVE_PATCH_STDERR_PATH: bundle.patch_stderr_path,
    SELF_IMPROVE_DIFF_STAT_PATH: bundle.diff_stat_path,
    SELF_IMPROVE_DIFF_PATCH_PATH: bundle.diff_patch_path,
    SELF_IMPROVE_LLM_TRACE_DIR: bundle.llm_trace_dir,
    SELF_IMPROVE_LLM_TRACE_INDEX_PATH: bundle.llm_trace_index_path,
    SELF_IMPROVE_DEBUG_LLM_TRACE_DIR: bundle.llm_trace_dir,
    SELF_IMPROVE_DEBUG_DIR: initialDebugBundle.debug_dir,
    SELF_IMPROVE_FAILURE_SUMMARY_PATH: initialDebugBundle.failure_summary_path,
    SELF_IMPROVE_REPRODUCTION_PATH: initialDebugBundle.reproduction_path,
    SELF_IMPROVE_ARTIFACT_INDEX_PATH: initialDebugBundle.artifact_index_path,
    SELF_IMPROVE_REVIEW_INPUT_PATH: initialDebugBundle.review_input_path,
    SELF_IMPROVE_ENVIRONMENT_SANITIZED_PATH: initialDebugBundle.environment_sanitized_path,
    SELF_IMPROVE_FORBIDDEN_PATHS_PATH: initialDebugBundle.forbidden_paths_path,
    SELF_IMPROVE_SECRETS_REDACTION_REPORT_PATH: initialDebugBundle.secrets_redaction_report_path,
    SELF_IMPROVE_INSTRUCTION: clean(jobPayload.instruction),
  };

  const patchResult = await runShellCommand(patchCommand, {
    cwd: workspaceRoot || undefined,
    timeoutMs: Number(targetConfig.patch_timeout_ms || 600000),
    env: patchEnv,
  });
  await writePatchLogs(bundle, patchResult);
  const diff = await collectWorkspaceDiff({ workspaceRoot });
  const changed = Number(diff.changed_file_count || 0) > 0;
  await persistDiffBundle(bundle, diff);
  const debugBundle = createImprovementDebugBundle({
    bundle,
    workspaceRoot,
    jobId: cleanJobId,
    targetConfig,
    jobPayload,
    reports,
    diff,
    patchResult,
  });

  const traceSummary = summarizeLlmTraceIndex({ traceDir: bundle.llm_trace_dir, limit: 12 });
  if (Number(traceSummary.total_traces || 0) > 0) {
    await report(client, threadId, cleanJobId, {
      kind: 'llm_trace_summary',
      phase: 'trace_collected',
      status: 'recorded',
      title: 'LLM trace summary',
      summary: `captured ${Number(traceSummary.total_traces || 0)} LLM trace(s) during patch`,
      preview_text: JSON.stringify(traceSummary, null, 2),
      payload: traceSummary,
      metrics: {
        total_traces: Number(traceSummary.total_traces || 0),
        ok_traces: Number(traceSummary.ok_traces || 0),
        failed_traces: Number(traceSummary.failed_traces || 0),
      },
      labels: ['llm-trace', 'debug'],
    });
  }

  const previewParts = [
    formatWorkspaceDiffPreview(diff),
    patchResult.stdout ? `stdout:\n${patchResult.stdout}` : '',
    patchResult.stderr ? `stderr:\n${patchResult.stderr}` : '',
  ].filter(Boolean);

  await report(client, threadId, cleanJobId, {
    kind: 'code_diff',
    phase: patchResult.ok ? (changed ? 'patch_applied' : 'patch_noop') : 'patch_failed',
    status: patchResult.ok ? (changed ? 'applied' : 'no_changes') : 'failed',
    summary: patchResult.ok
      ? (changed ? `patch command changed ${Number(diff.changed_file_count || 0)} file(s)` : 'patch command finished but no workspace diff was detected')
      : 'patch command failed',
    preview_text: previewParts.join('\n\n') || 'no output',
    payload: {
      command: patchCommand,
      exit_code: patchResult.exit_code,
      signal: patchResult.signal,
      bundle_root: bundle.bundle_root,
      debug_dir: debugBundle.debug_dir,
      failure_summary_path: debugBundle.failure_summary_path,
      artifact_index_path: debugBundle.artifact_index_path,
      review_input_path: debugBundle.review_input_path,
      changed_files: diff.changed_files || [],
      diff_stat_path: bundle.diff_stat_path,
      diff_patch_path: bundle.diff_patch_path,
      stdout_path: bundle.patch_stdout_path,
      stderr_path: bundle.patch_stderr_path,
    },
    metrics: {
      duration_ms: Number(patchResult.duration_ms || 0),
      changed_file_count: Number(diff.changed_file_count || 0),
    },
    labels: ['patch', changed ? 'changed' : 'noop'],
  });

  return {
    ...patchResult,
    status: patchResult.ok ? (changed ? 'applied' : 'no_changes') : 'failed',
    ok: patchResult.ok && changed,
    bundle,
    diff,
  };
}

async function writePatchLogs(bundle = {}, patchResult = {}) {
  const stdout = clean(patchResult.stdout);
  const stderr = clean(patchResult.stderr);
  const combinedPlan = [
    `command: ${clean(patchResult.command) || '-'}`,
    `exit_code: ${String(patchResult.exit_code ?? '-')}`,
    `signal: ${String(patchResult.signal ?? '-')}`,
    '',
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n\n');
  if (bundle.patch_stdout_path) await BunLike.write(bundle.patch_stdout_path, `${stdout}${stdout ? '\n' : ''}`);
  if (bundle.patch_stderr_path) await BunLike.write(bundle.patch_stderr_path, `${stderr}${stderr ? '\n' : ''}`);
  if (bundle.patch_plan_path) await BunLike.write(bundle.patch_plan_path, `${combinedPlan}${combinedPlan ? '\n' : ''}`);
}

async function persistDiffBundle(bundle = {}, diff = {}) {
  if (bundle.diff_stat_path) await BunLike.write(bundle.diff_stat_path, `${clean(diff.diff_stat)}${clean(diff.diff_stat) ? '\n' : ''}`);
  if (bundle.diff_patch_path) await BunLike.write(bundle.diff_patch_path, `${clean(diff.diff_patch)}${clean(diff.diff_patch) ? '\n' : ''}`);
}

const BunLike = {
  async write(filePath, content) {
    const fsModule = await import('node:fs/promises');
    await fsModule.mkdir(new URL(`file://${clean(new URL(`file://${filePath}`).pathname)}`), { recursive: true }).catch(() => null);
  },
};

BunLike.write = async function write(filePath, content) {
  const fsModule = await import('node:fs/promises');
  const pathModule = await import('node:path');
  await fsModule.mkdir(pathModule.dirname(filePath), { recursive: true });
  await fsModule.writeFile(filePath, String(content || ''), 'utf8');
};

export async function runImprovementAutomation({
  client,
  threadId = '',
  jobId = '',
  targetConfig = {},
  autoPromote = false,
  board = null,
} = {}) {
  const loaded = await loadImprovementExecutionContext({ client, threadId, jobId });
  const resolvedTargetConfig = {
    ...loaded.targetConfig,
    ...asObject(targetConfig),
  };
  const effectiveAutoPromote = autoPromote === true || resolvedTargetConfig.auto_promote === true;
  const boardSummary = summarizeBoardForImprovement(board || {});

  await report(client, threadId, jobId, {
    kind: 'runtime_event',
    phase: 'automation_started',
    status: 'in_progress',
    summary: effectiveAutoPromote ? 'automatic improvement pipeline started (auto-promote enabled)' : 'automatic improvement pipeline started',
    preview_text: JSON.stringify({
      target: resolvedTargetConfig.target,
      workspace_root: resolvedTargetConfig.workspace_root,
      auto_promote: effectiveAutoPromote,
    }, null, 2),
    payload: {
      board_summary: boardSummary,
      auto_promote: effectiveAutoPromote,
    },
    labels: ['automation'],
  });

  const patchResult = await runImprovementPatch({
    client,
    threadId,
    jobId,
    targetConfig: resolvedTargetConfig,
    jobPayload: loaded.jobPayload,
    reports: loaded.reports,
    boardSummary,
  });
  if (!patchResult.ok) {
    await report(client, threadId, jobId, {
      kind: 'runtime_event',
      phase: patchResult.status === 'blocked' ? 'automation_blocked' : patchResult.status === 'no_changes' ? 'automation_no_changes' : 'automation_failed',
      status: patchResult.status,
      summary: patchResult.status === 'blocked'
        ? 'automation stopped because no patch command was configured'
        : patchResult.status === 'no_changes'
          ? 'automation stopped because the patch step produced no detectable code changes'
          : 'automation stopped because the patch step failed',
      preview_text: [patchResult.stdout, patchResult.stderr].filter(Boolean).join('\n\n') || 'no patch output',
      payload: {
        patch_status: patchResult.status,
        changed_file_count: Number(patchResult.diff?.changed_file_count || 0),
      },
      metrics: { duration_ms: Number(patchResult.duration_ms || 0) },
      labels: ['automation', 'patch'],
    });
    return {
      ok: false,
      status: patchResult.status,
      patch: patchResult,
      tests: null,
      canary: null,
      promotion: null,
    };
  }

  const testResult = await runImprovementTests({ client, threadId, jobId, targetConfig: resolvedTargetConfig });
  if (!testResult.ok) {
    await report(client, threadId, jobId, {
      kind: 'runtime_event',
      phase: 'automation_failed',
      status: 'tests_failed',
      summary: 'automation stopped because tests failed',
      preview_text: [testResult.stdout, testResult.stderr].filter(Boolean).join('\n\n') || 'no test output',
      payload: {},
      metrics: { duration_ms: Number(testResult.duration_ms || 0) },
      labels: ['automation', 'tests'],
    });
    return {
      ok: false,
      status: 'tests_failed',
      patch: patchResult,
      tests: testResult,
      canary: null,
      promotion: null,
    };
  }

  const canaryResult = await runImprovementCanary({ client, threadId, jobId, targetConfig: resolvedTargetConfig });
  if (!canaryResult.ok) {
    await report(client, threadId, jobId, {
      kind: 'runtime_event',
      phase: 'automation_failed',
      status: 'canary_failed',
      summary: 'automation stopped because canary validation failed',
      preview_text: [canaryResult.stdout, canaryResult.stderr].filter(Boolean).join('\n\n') || 'no canary output',
      payload: {},
      metrics: { duration_ms: Number(canaryResult.duration_ms || 0) },
      labels: ['automation', 'canary'],
    });
    return {
      ok: false,
      status: 'canary_failed',
      patch: patchResult,
      tests: testResult,
      canary: canaryResult,
      promotion: null,
    };
  }

  let reviewResult = null;
  if (clean(resolvedTargetConfig.review_command)) {
    reviewResult = await runImprovementReview({ client, threadId, jobId, targetConfig: resolvedTargetConfig });
  }

  const gateResult = await runImprovementEvalGate({ client, threadId, jobId, targetConfig: resolvedTargetConfig, reviewResult });
  if (!gateResult.ok) {
    await report(client, threadId, jobId, {
      kind: 'runtime_event',
      phase: gateResult.status === 'blocked' ? 'automation_blocked' : 'needs_review',
      status: gateResult.status,
      summary: gateResult.status === 'blocked'
        ? 'automation stopped because the eval gate blocked promotion'
        : 'automation completed but needs review before promotion',
      preview_text: formatEvalGatePreview(gateResult.gate),
      payload: { gate: gateResult.gate },
      metrics: {},
      labels: ['automation', 'eval-gate'],
    });
    return {
      ok: false,
      status: gateResult.status,
      patch: patchResult,
      tests: testResult,
      canary: canaryResult,
      review: reviewResult,
      gate: gateResult,
      promotion: null,
    };
  }

  let promotionResult = null;
  if (effectiveAutoPromote) {
    promotionResult = await markImprovementPromotion({ client, threadId, jobId, targetConfig: resolvedTargetConfig });
    return {
      ok: promotionResult.ok,
      status: promotionResult.status,
      patch: patchResult,
      tests: testResult,
      canary: canaryResult,
      review: reviewResult,
      gate: gateResult,
      promotion: promotionResult,
    };
  }

  await report(client, threadId, jobId, {
    kind: 'runtime_event',
    phase: 'awaiting_approval',
    status: 'ready_for_promote',
    summary: 'automation finished; eval gate passed; waiting for manual promote approval',
    preview_text: 'use /improve promote <jobId> to run the configured promotion command',
    payload: { gate: gateResult.gate },
    metrics: {},
    labels: ['automation', 'approval'],
  });
  return {
    ok: true,
    status: 'ready_for_promote',
    patch: patchResult,
    tests: testResult,
    canary: canaryResult,
    review: reviewResult,
    gate: gateResult,
    promotion: null,
  };
}
