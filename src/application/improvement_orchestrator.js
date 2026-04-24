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
  const result = await runShellCommand(promoteCommand, {
    cwd: clean(targetConfig.workspace_root) || undefined,
  });
  await report(client, threadId, jobId, {
    kind: 'promotion_decision',
    phase: result.ok ? 'promoted' : 'promotion_failed',
    status: result.ok ? 'promoted' : 'failed',
    summary: result.ok ? 'promote command finished' : 'promote command failed',
    preview_text: [result.stdout, result.stderr].filter(Boolean).join('\n\n') || 'no output',
    payload: { command: promoteCommand, exit_code: result.exit_code, signal: result.signal },
    metrics: { duration_ms: Number(result.duration_ms || 0) },
    labels: ['promote'],
  });
  return result;
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

  let promotionResult = null;
  if (effectiveAutoPromote) {
    promotionResult = await markImprovementPromotion({ client, threadId, jobId, targetConfig: resolvedTargetConfig });
    return {
      ok: promotionResult.ok,
      status: promotionResult.status,
      patch: patchResult,
      tests: testResult,
      canary: canaryResult,
      promotion: promotionResult,
    };
  }

  await report(client, threadId, jobId, {
    kind: 'runtime_event',
    phase: 'awaiting_approval',
    status: 'ready_for_promote',
    summary: 'automation finished; waiting for manual promote approval',
    preview_text: 'use /improve promote <jobId> to run the configured promotion command',
    payload: {},
    metrics: {},
    labels: ['automation', 'approval'],
  });
  return {
    ok: true,
    status: 'ready_for_promote',
    patch: patchResult,
    tests: testResult,
    canary: canaryResult,
    promotion: null,
  };
}
