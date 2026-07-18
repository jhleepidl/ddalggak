import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  appendRoomRunEvent,
  createRoomRun,
  readRoomRunControl,
  updateRoomRunState,
  writeStageResult,
  writeWorkingMemory,
} from './room_run_store.js';
import { buildRoomStagePrompt, parseRoomStageResult } from './room_prompt_builder.js';
import { RoomAgentRuntime } from './room_agent_runtime.js';
import { appendJsonl, cleanText, readJson, sha256, writeJsonAtomic } from './fs_utils.js';
import { createRoomProviderProgressTracker } from './room_provider_progress.js';
import { buildExecutionReceipt, summarizeExecutionReceipt } from './room_execution_receipt.js';
import {
  buildProviderNeutralCheckpoint,
  computeWorkspaceRevision,
  validateResumeCheckpoint,
  writeProviderNeutralCheckpoint,
} from './room_checkpoint.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values = []) {
  return [...new Set(values.map((item) => cleanText(item)).filter(Boolean))];
}

function uniqueObjects(values = [], keySelector = (item) => JSON.stringify(item), limit = 128) {
  const out = [];
  const seen = new Set();
  for (const item of values) {
    if (!item) continue;
    const key = cleanText(keySelector(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function buildProgress({ run, stage = null, event = '', message = '', details = {} } = {}) {
  const total = run.spec.execution_graph.stages.length;
  const index = stage ? stage.order : Math.max(0, Number(run.state.stage_index || 0) + 1);
  return {
    event,
    run_id: run.paths.runId,
    room_id: run.spec.room_id,
    status: run.state.status,
    stage_id: stage?.stage_id || run.state.current_stage_id,
    stage_index: index,
    stage_total: total,
    provider: stage?.provider || null,
    role: stage?.role || null,
    collaboration_profile_id: run.spec.execution_graph.collaboration_profile_id || run.spec.execution_graph.topology_id,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}

function loadCompletedStageResults(run) {
  const completed = new Set(run.state.completed_stage_ids || []);
  return run.spec.execution_graph.stages
    .filter((stage) => completed.has(stage.stage_id))
    .map((stage) => readJson(path.join(run.paths.stagesRoot, `${stage.stage_id}.json`), null))
    .filter(Boolean)
    .map((row) => ({
      stage_id: row.stage_id,
      structured: row.structured || {},
      visible_output: String(row.visible_output || '').slice(0, 12000),
      output_excerpt: String(row.visible_output || '').slice(0, 1600),
      receipt: row.receipt_file ? readJson(row.receipt_file, null) : null,
    }));
}

function appendDiscussionRecords(paths, stage, parsed) {
  for (const decision of parsed.structured.decisions || []) {
    appendJsonl(paths.discussionPath, { record_type: 'decision', stage_id: stage.stage_id, role: stage.role, text: decision, status: 'accepted', at: new Date().toISOString() });
  }
  for (const blocker of parsed.structured.blocking_issues || []) {
    appendJsonl(paths.discussionPath, { record_type: 'objection', stage_id: stage.stage_id, role: stage.role, text: blocker, severity: 'blocking', status: 'open', at: new Date().toISOString() });
  }
  for (const resolved of parsed.structured.resolved_issues || []) {
    appendJsonl(paths.discussionPath, { record_type: 'resolution', stage_id: stage.stage_id, role: stage.role, text: resolved, status: 'resolved', at: new Date().toISOString() });
  }
}

function writeVerifiedGzipArchive(source, target) {
  const sourceBytes = fs.readFileSync(source);
  const compressed = zlib.gzipSync(sourceBytes);
  fs.writeFileSync(target, compressed);
  const restored = zlib.gunzipSync(fs.readFileSync(target));
  if (!restored.equals(sourceBytes)) throw new Error(`Cold archive round-trip verification failed: ${target}`);
  return {
    source_file: path.basename(source),
    archive_file: path.basename(target),
    source_bytes: sourceBytes.length,
    archive_bytes: compressed.length,
    source_sha256: sha256(sourceBytes),
    archive_sha256: sha256(compressed),
    round_trip_verified: true,
  };
}

function finalizeRoomRunArtifacts(run, workingMemory, finalStage, checkpoint) {
  const archiveRoot = path.join(run.paths.runRoot, 'archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archives = [];
  for (const [source, name] of [[run.paths.eventsPath, 'events.jsonl.gz'], [run.paths.discussionPath, 'discussion.jsonl.gz']]) {
    if (!fs.existsSync(source)) continue;
    archives.push(writeVerifiedGzipArchive(source, path.join(archiveRoot, name)));
  }
  writeJsonAtomic(path.join(archiveRoot, 'manifest.json'), {
    schema_version: 'ai_rooms.cold_archive_manifest/v3',
    run_id: run.paths.runId,
    room_id: run.spec.room_id,
    archives,
    receipt_count: Array.isArray(checkpoint?.receipt_index) ? checkpoint.receipt_index.length : 0,
    checkpoint_hash: checkpoint?.checkpoint_hash || null,
    all_round_trips_verified: archives.every((row) => row.round_trip_verified === true),
    created_at: new Date().toISOString(),
  });
  const proposals = [
    ...(workingMemory.decisions || []).map((text) => ({ proposal_type: 'decision', text, status: 'pending_review' })),
    ...(workingMemory.stage_summaries || []).map((row) => ({ proposal_type: 'milestone', stage_id: row.stage_id, text: row.summary, status: 'pending_review' })),
  ];
  writeJsonAtomic(path.join(run.paths.runRoot, 'memory_proposals.json'), {
    schema_version: 'ai_rooms.memory_proposals/v3',
    run_id: run.paths.runId,
    room_id: run.spec.room_id,
    proposals,
    durable_memory_mutated: false,
    created_at: new Date().toISOString(),
  });
  writeJsonAtomic(path.join(run.paths.runRoot, 'finalization.json'), {
    schema_version: 'ai_rooms.run_finalization/v3',
    raw_trace_preserved: true,
    cold_archive_created: true,
    cold_archive_verified: archives.every((row) => row.round_trip_verified === true),
    archived_file_count: archives.length,
    execution_receipt_count: Array.isArray(checkpoint?.receipt_index) ? checkpoint.receipt_index.length : 0,
    provider_neutral_checkpoint_created: Boolean(checkpoint?.checkpoint_hash),
    memory_proposal_count: proposals.length,
    final_stage_id: finalStage?.stage_id || null,
    finalized_at: new Date().toISOString(),
  });
}

function isTransientStageError(error) {
  if (!error) return false;
  if ([
    'ROOM_WORKSPACE_BOUNDARY', 'ROOM_WORKSPACE_REQUIRED', 'ROOM_READ_ONLY_MUTATION', 'ROOM_RUN_CANCELLED',
    'ROOM_PROVIDER_CAPABILITY_MISMATCH', 'ROOM_CONTRACT_REVISION_DRIFT', 'ROOM_WORKSPACE_REVISION_DRIFT',
  ].includes(error.code)) return false;
  const result = error.result || {};
  if (result.timedOut === true) return true;
  const text = `${error.message || ''} ${result.stderr || ''}`.toLowerCase();
  return /(timeout|timed out|rate limit|429|temporar|connection reset|econnreset|service unavailable|\b50[0234]\b)/i.test(text);
}

function shouldRunStage(stage, priorStageResults, workingMemory) {
  const condition = stage?.run_if;
  if (!condition) return { run: true, reason: 'unconditional' };
  if (condition.kind === 'open_blockers') {
    const count = Array.isArray(workingMemory?.open_blockers) ? workingMemory.open_blockers.length : 0;
    return { run: count > 0, reason: count > 0 ? 'open_blockers_present' : 'no_open_blockers' };
  }
  if (condition.kind === 'stage_reported_blockers') {
    const source = priorStageResults.find((row) => row.stage_id === condition.stage_id);
    const count = Array.isArray(source?.structured?.blocking_issues) ? source.structured.blocking_issues.length : 0;
    return { run: count > 0, reason: count > 0 ? `${condition.stage_id}_reported_blockers` : `${condition.stage_id}_reported_no_blockers` };
  }
  return { run: false, reason: `unsupported_condition:${condition.kind || 'unknown'}` };
}

function writeCheckpointForRun({ run, spec, workingMemory, receipt = null, roomPaths, stage = null, status = '', env = process.env } = {}) {
  let workspaceRevision = receipt?.workspace?.revision_after || '';
  if (!workspaceRevision) {
    try { workspaceRevision = computeWorkspaceRevision(roomPaths.workspaceRoot, env).revision; } catch {}
  }
  const checkpoint = buildProviderNeutralCheckpoint({ run, spec, workingMemory, receipt, workspaceRevision, status });
  writeProviderNeutralCheckpoint(run.paths, checkpoint, stage);
  appendRoomRunEvent(run.paths, {
    event_type: 'checkpoint_written',
    stage_id: stage?.stage_id || null,
    checkpoint_hash: checkpoint.checkpoint_hash,
    workspace_revision: checkpoint.workspace_revision,
    next_stage_id: checkpoint.next_stage_id,
  });
  return checkpoint;
}

export class RoomLoopEngine {
  constructor({ env = process.env, agentRuntime = null } = {}) {
    this.env = env;
    this.agentRuntime = agentRuntime || new RoomAgentRuntime({ env });
  }

  async waitUntilRunnable(paths, signal) {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Room run cancelled'), { code: 'ROOM_RUN_CANCELLED' });
      const control = readRoomRunControl(paths);
      if (control.status === 'cancelled') throw Object.assign(new Error(control.reason || 'Room run cancelled'), { code: 'ROOM_RUN_CANCELLED' });
      if (control.status !== 'paused') return;
      await wait(250);
    }
  }

  async execute({ roomPaths, spec, existingRun = null, signal = null, onProgress = null } = {}) {
    const created = existingRun || createRoomRun({ roomStateRoot: roomPaths.roomStateRoot, spec });
    const run = { ...created, spec: created.spec || spec, state: created.state };
    spec = run.spec;
    const emit = async (payload) => {
      if (typeof onProgress === 'function') await onProgress(payload);
    };
    let workingMemory = created.workingMemory || readJson(run.paths.workingMemoryPath, null) || {
      schema_version: 'ai_rooms.working_memory/v3',
      objective: spec.objective,
      decisions: [],
      open_blockers: [],
      milestones: [],
      stage_summaries: [],
      next_actions: [],
      artifacts: [],
      claims: [],
      receipt_index: [],
      updated_at: new Date().toISOString(),
    };
    const priorStageResults = existingRun ? loadCompletedStageResults(run) : [];
    const completedStages = new Set(run.state.completed_stage_ids || []);
    const skippedStages = new Set(run.state.skipped_stage_ids || []);
    let lastCheckpoint = readJson(run.paths.checkpointPath, null);
    try {
      if (existingRun) {
        const resumeValidation = validateResumeCheckpoint({ paths: run.paths, spec, workspaceRoot: roomPaths.workspaceRoot, env: this.env });
        if (resumeValidation.drift) {
          appendRoomRunEvent(run.paths, {
            event_type: 'workspace_revision_drift_accepted',
            expected_revision: resumeValidation.expected_revision,
            current_revision: resumeValidation.current_revision,
          });
        }
      }
      run.state = updateRoomRunState(run.paths, { status: 'running', started_at: run.state.started_at || new Date().toISOString(), error: null });
      const lifecycleEvent = existingRun ? 'run_resumed' : 'run_started';
      appendRoomRunEvent(run.paths, {
        event_type: lifecycleEvent,
        collaboration_profile_id: spec.execution_graph.collaboration_profile_id || spec.execution_graph.topology_id,
        contract_hash: spec.room_contract?.contract_hash || spec.contract_hash || null,
      });
      await emit(buildProgress({ run, event: lifecycleEvent, message: `Room run ${existingRun ? 'resumed' : 'started'} with ${spec.execution_graph.collaboration_profile_id || spec.execution_graph.topology_id}.` }));
      if (!lastCheckpoint) lastCheckpoint = writeCheckpointForRun({ run, spec, workingMemory, roomPaths, status: 'running', env: this.env });

      for (const stage of spec.execution_graph.stages) {
        if (completedStages.has(stage.stage_id) || skippedStages.has(stage.stage_id)) continue;
        const stageDecision = shouldRunStage(stage, priorStageResults, workingMemory);
        if (!stageDecision.run) {
          skippedStages.add(stage.stage_id);
          run.state = updateRoomRunState(run.paths, {
            skipped_stage_ids: unique([...(run.state.skipped_stage_ids || []), stage.stage_id]),
          });
          writeStageResult(run.paths, stage.stage_id, {
            schema_version: 'ai_rooms.stage_result/v3',
            run_id: run.paths.runId,
            room_id: spec.room_id,
            stage_id: stage.stage_id,
            kind: stage.kind,
            role: stage.role,
            provider: stage.provider,
            access: stage.access,
            skipped: true,
            skip_reason: stageDecision.reason,
            completed_at: new Date().toISOString(),
          });
          appendRoomRunEvent(run.paths, { event_type: 'stage_skipped', stage_id: stage.stage_id, reason: stageDecision.reason });
          lastCheckpoint = writeCheckpointForRun({ run, spec, workingMemory, roomPaths, stage, status: 'running', env: this.env });
          await emit(buildProgress({ run, stage, event: 'stage_skipped', message: `${stage.stage_id} skipped: ${stageDecision.reason}` }));
          continue;
        }
        await this.waitUntilRunnable(run.paths, signal);
        const stageStartedAt = new Date().toISOString();
        run.state = updateRoomRunState(run.paths, { status: 'running', current_stage_id: stage.stage_id, stage_index: stage.order - 1 });
        appendRoomRunEvent(run.paths, {
          event_type: 'stage_started', stage_id: stage.stage_id, kind: stage.kind, role: stage.role,
          provider: stage.provider, access: stage.access, context_policy: stage.context_policy || null,
          required_capabilities: stage.required_capabilities || [],
        });
        await emit(buildProgress({ run, stage, event: 'stage_started', message: `${stage.role} started: ${stage.purpose}` }));

        const deliveredBlockers = stage.kind === 'revise' ? [...(workingMemory.open_blockers || [])] : [];
        const feedbackDelivery = deliveredBlockers.length ? {
          source_stage_ids: Array.isArray(stage?.context_policy?.prior_stage_ids) ? stage.context_policy.prior_stage_ids : [],
          blocker_count: deliveredBlockers.length,
          blockers: deliveredBlockers,
          blocker_hashes: deliveredBlockers.map((text) => sha256(text)),
          delivered_at: new Date().toISOString(),
        } : null;
        if (feedbackDelivery) {
          appendRoomRunEvent(run.paths, {
            event_type: 'review_feedback_delivered', stage_id: stage.stage_id,
            source_stage_ids: feedbackDelivery.source_stage_ids,
            blocker_count: feedbackDelivery.blocker_count,
            blocker_hashes: feedbackDelivery.blocker_hashes,
          });
        }

        const outputTracker = createRoomProviderProgressTracker({
          maxProjectedEvents: Number(this.env.ROOM_STAGE_PROGRESS_MAX_EVENTS || 80),
          onProjection: async (projection) => {
            appendRoomRunEvent(run.paths, {
              event_type: 'stage_output', stage_id: stage.stage_id, provider: stage.provider, role: stage.role,
              stream: projection.stream, output_kind: projection.kind, sequence: projection.sequence,
              elapsed_ms: projection.elapsed_ms, provider_attempt: projection.provider_attempt, message: projection.message,
            });
            await emit(buildProgress({
              run, stage, event: 'stage_output', message: projection.message,
              details: { stream: projection.stream, output_kind: projection.kind, sequence: projection.sequence, elapsed_ms: projection.elapsed_ms, provider_attempt: projection.provider_attempt },
            }));
          },
        });

        const prompt = buildRoomStagePrompt({ spec, stage, workingMemory, priorStageResults });
        const maxAttempts = Math.max(1, Math.min(5, Number(this.env.ROOM_STAGE_MAX_ATTEMPTS || 2)));
        const retryDelayMs = Math.max(0, Number(this.env.ROOM_STAGE_RETRY_DELAY_MS || 2000));
        let execution = null;
        let lastStageError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            execution = await this.agentRuntime.execute({
              roomId: spec.room_id, roomPaths, runPaths: run.paths, stage, prompt, signal,
              modelPolicy: spec.model_policy || {}, onOutput: (event) => outputTracker.observe(event),
            });
            break;
          } catch (error) {
            await outputTracker.flush();
            lastStageError = error;
            const transient = isTransientStageError(error);
            appendRoomRunEvent(run.paths, {
              event_type: 'stage_attempt_failed', stage_id: stage.stage_id, attempt, max_attempts: maxAttempts,
              transient, error: { code: error?.code || 'ROOM_STAGE_FAILED', message: String(error?.message || error) },
            });
            if (!transient || attempt >= maxAttempts) throw error;
            appendRoomRunEvent(run.paths, { event_type: 'stage_retry', stage_id: stage.stage_id, attempt: attempt + 1, max_attempts: maxAttempts, delay_ms: retryDelayMs * attempt });
            await emit(buildProgress({ run, stage, event: 'stage_retry', message: `${stage.stage_id} transient failure; retrying (${attempt + 1}/${maxAttempts}).` }));
            await wait(retryDelayMs * attempt);
          }
        }
        if (!execution) throw lastStageError || new Error(`Room stage did not produce an execution result: ${stage.stage_id}`);
        await outputTracker.flush();
        const streamSummary = outputTracker.summary();
        const projectedEvents = outputTracker.events();
        const parsed = parseRoomStageResult(execution.output);
        const stageCompletedAt = new Date().toISOString();
        const receipt = buildExecutionReceipt({
          spec, stage, parsed, execution, streamSummary, projectedEvents,
          startedAt: stageStartedAt, completedAt: stageCompletedAt,
        });
        const receiptFile = path.join(run.paths.receiptsRoot, `${String(stage.order).padStart(2, '0')}-${stage.stage_id}.json`);
        writeJsonAtomic(receiptFile, receipt);
        const receiptSummary = summarizeExecutionReceipt(receipt);
        appendRoomRunEvent(run.paths, { event_type: 'execution_receipt_recorded', stage_id: stage.stage_id, ...receiptSummary });

        const stageResult = {
          schema_version: 'ai_rooms.stage_result/v3',
          run_id: run.paths.runId,
          room_id: spec.room_id,
          stage_id: stage.stage_id,
          kind: stage.kind,
          role: stage.role,
          provider: stage.provider,
          access: stage.access,
          started_at: stageStartedAt,
          completed_at: stageCompletedAt,
          contract_observed: parsed.contract_observed,
          structured: parsed.structured,
          visible_output: parsed.visible_output,
          raw_file: execution.raw_file,
          execution_root: execution.execution_root,
          canonical_workspace_root: roomPaths.workspaceRoot,
          stream_summary: streamSummary,
          receipt_file: receiptFile,
          receipt_hash: receipt.receipt_hash,
          receipt_summary: receiptSummary,
          ...(feedbackDelivery ? { feedback_delivery: feedbackDelivery } : {}),
        };
        if (feedbackDelivery) {
          const deliveredSet = new Set(deliveredBlockers);
          const resolvedDelivered = parsed.structured.resolved_issues.filter((item) => deliveredSet.has(item));
          const unresolvedDelivered = deliveredBlockers.filter((item) => !resolvedDelivered.includes(item));
          stageResult.revision_consumption = {
            delivered_blocker_count: deliveredBlockers.length,
            resolved_delivered_count: resolvedDelivered.length,
            unresolved_delivered_count: unresolvedDelivered.length,
            resolved_blockers: resolvedDelivered,
            unresolved_blockers: unresolvedDelivered,
            exact_match_required: true,
            attested_at: new Date().toISOString(),
          };
          appendRoomRunEvent(run.paths, {
            event_type: 'review_feedback_consumed', stage_id: stage.stage_id,
            delivered_blocker_count: deliveredBlockers.length,
            resolved_delivered_count: resolvedDelivered.length,
            unresolved_delivered_count: unresolvedDelivered.length,
          });
        }
        writeStageResult(run.paths, stage.stage_id, stageResult);
        appendDiscussionRecords(run.paths, stage, parsed);
        priorStageResults.push({
          stage_id: stage.stage_id,
          structured: parsed.structured,
          visible_output: parsed.visible_output.slice(0, 12000),
          output_excerpt: parsed.visible_output.slice(0, 1600),
          receipt,
        });
        workingMemory = writeWorkingMemory(run.paths, {
          ...workingMemory,
          decisions: unique([...workingMemory.decisions, ...parsed.structured.decisions]),
          open_blockers: unique([
            ...workingMemory.open_blockers.filter((item) => !parsed.structured.resolved_issues.includes(item)),
            ...parsed.structured.blocking_issues,
          ]),
          next_actions: unique([...parsed.structured.next_actions, ...(workingMemory.next_actions || [])]).slice(0, 64),
          artifacts: uniqueObjects([...(workingMemory.artifacts || []), ...parsed.structured.artifacts], (item) => item.path || item.uri || item.location || JSON.stringify(item), 128),
          claims: uniqueObjects([...(workingMemory.claims || []), ...parsed.structured.claims], (item) => item.claim || JSON.stringify(item), 128),
          receipt_index: uniqueObjects([...(workingMemory.receipt_index || []), receiptSummary], (item) => item.receipt_id, 256),
          milestones: [...workingMemory.milestones, `${stage.stage_id}: ${parsed.structured.summary}`].slice(-24),
          stage_summaries: [...workingMemory.stage_summaries, { stage_id: stage.stage_id, summary: parsed.structured.summary }].slice(-32),
        });
        run.state = updateRoomRunState(run.paths, { completed_stage_ids: unique([...(run.state.completed_stage_ids || []), stage.stage_id]) });
        completedStages.add(stage.stage_id);
        lastCheckpoint = writeCheckpointForRun({ run, spec, workingMemory, receipt, roomPaths, stage, status: 'running', env: this.env });
        appendRoomRunEvent(run.paths, {
          event_type: 'stage_completed', stage_id: stage.stage_id, summary: parsed.structured.summary,
          blocker_count: parsed.structured.blocking_issues.length, contract_observed: parsed.contract_observed,
          stream_summary: streamSummary, receipt_hash: receipt.receipt_hash,
        });
        await emit(buildProgress({ run, stage, event: 'stage_completed', message: parsed.structured.summary, details: { receipt_hash: receipt.receipt_hash } }));
      }
      const hasOpenBlockers = workingMemory.open_blockers.length > 0;
      const terminalStatus = hasOpenBlockers ? 'completed_with_blockers' : 'completed';
      const terminalEvent = hasOpenBlockers ? 'run_completed_with_blockers' : 'run_completed';
      run.state = updateRoomRunState(run.paths, { status: terminalStatus, current_stage_id: null, completed_at: new Date().toISOString() });
      const finalStage = priorStageResults.at(-1);
      lastCheckpoint = writeCheckpointForRun({ run, spec, workingMemory, roomPaths, status: terminalStatus, env: this.env });
      appendRoomRunEvent(run.paths, { event_type: terminalEvent, open_blocker_count: workingMemory.open_blockers.length, checkpoint_hash: lastCheckpoint.checkpoint_hash });
      finalizeRoomRunArtifacts(run, workingMemory, finalStage, lastCheckpoint);
      writeJsonAtomic(path.join(run.paths.runRoot, 'final.json'), {
        schema_version: 'ai_rooms.room_run_final/v3',
        run_id: run.paths.runId,
        room_id: spec.room_id,
        status: terminalStatus,
        quality_gate_passed: !hasOpenBlockers,
        collaboration_profile_id: spec.execution_graph.collaboration_profile_id || spec.execution_graph.topology_id,
        room_contract_hash: spec.room_contract?.contract_hash || spec.contract_hash || null,
        workspace_root: roomPaths.workspaceRoot,
        workspace_revision: lastCheckpoint.workspace_revision,
        checkpoint_hash: lastCheckpoint.checkpoint_hash,
        receipt_index: lastCheckpoint.receipt_index,
        artifacts: lastCheckpoint.artifacts,
        final_summary: finalStage?.structured?.summary || 'Room run completed.',
        final_user_message: finalStage?.structured?.user_message || finalStage?.output_excerpt || finalStage?.structured?.summary || '',
        open_blockers: workingMemory.open_blockers,
        next_actions: workingMemory.next_actions || [],
        completed_at: run.state.completed_at,
      });
      const progressMessage = hasOpenBlockers
        ? `Execution finished with ${workingMemory.open_blockers.length} unresolved blocker(s).`
        : finalStage?.structured?.summary || 'Room run completed.';
      await emit(buildProgress({ run, event: terminalEvent, message: progressMessage, details: { checkpoint_hash: lastCheckpoint.checkpoint_hash } }));
      return { ok: true, needs_attention: hasOpenBlockers, run: { ...run, state: run.state }, workingMemory, finalStage, checkpoint: lastCheckpoint };
    } catch (error) {
      const cancelled = error?.code === 'ROOM_RUN_CANCELLED' || signal?.aborted;
      const control = cancelled ? readRoomRunControl(run.paths) : null;
      const cancellationReason = cancelled ? cleanText(control?.reason || '') : '';
      const userMessage = cancellationReason === 'correction_redirect'
        ? '새 정정을 적용하기 위해 현재 실행을 종료하고 다시 시작합니다.'
        : String(error?.message || error);
      run.state = updateRoomRunState(run.paths, {
        status: cancelled ? 'cancelled' : 'failed', failed_stage_id: run.state.current_stage_id,
        completed_at: new Date().toISOString(), error: { code: error?.code || 'ROOM_RUN_FAILED', message: userMessage },
      });
      try { lastCheckpoint = writeCheckpointForRun({ run, spec, workingMemory, roomPaths, status: run.state.status, env: this.env }); } catch {}
      appendRoomRunEvent(run.paths, {
        event_type: cancelled ? 'run_cancelled' : 'run_failed', stage_id: run.state.current_stage_id,
        error: run.state.error, checkpoint_hash: lastCheckpoint?.checkpoint_hash || null,
      });
      await emit(buildProgress({ run, event: cancelled ? 'run_cancelled' : 'run_failed', message: run.state.error.message }));
      return { ok: false, cancelled, error, run: { ...run, state: run.state }, workingMemory, checkpoint: lastCheckpoint };
    }
  }
}
