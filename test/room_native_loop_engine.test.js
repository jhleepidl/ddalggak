import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { RoomAgentRuntime } from '../src/room_runtime/room_agent_runtime.js';
import { RoomLoopEngine } from '../src/room_runtime/room_loop_engine.js';
import { RoomNativeService } from '../src/room_runtime/room_native_service.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-room-native-'));
  const control = path.join(root, 'control');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(control, { recursive: true });
  const env = {
    ROOM_EXECUTION_ENGINE: 'room_native_v2',
    ROOM_RUNTIME_ROOT: runtime,
    ROOM_WORKSPACES_ROOT: path.join(runtime, 'workspaces'),
    ROOM_STATE_ROOT: path.join(runtime, 'state'),
    DDALGGAK_CONTROL_ROOT: control,
    ROOM_AGENT_TIMEOUT_MS: '5000',
    ROOM_STAGE_MAX_ATTEMPTS: '1',
    ROOM_STAGE_RETRY_DELAY_MS: '0',
  };
  const calls = [];
  const providers = {
    antigravity: async (args) => {
      calls.push({ provider: 'antigravity', ...args });
      fs.writeFileSync(path.join(args.workspaceRoot, `.snapshot-${args.roleId}.txt`), 'snapshot-only');
      return {
        ok: true,
        stdout: [
          `${args.roleId} completed`,
          '<ROOM_STAGE_RESULT>',
          JSON.stringify({ summary: `${args.roleId} summary`, decisions: [], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: '' }),
          '</ROOM_STAGE_RESULT>',
        ].join('\n'),
      };
    },
    codex: async (args) => {
      calls.push({ provider: 'codex', ...args });
      assert.equal(args.cwd, args.workspaceRoot);
      assert.deepEqual(args.addDirs, []);
      fs.writeFileSync(path.join(args.workspaceRoot, 'implemented.txt'), `${args.roleId}:${Date.now()}`);
      return {
        ok: true,
        stdout: [
          `${args.roleId} completed`,
          '<ROOM_STAGE_RESULT>',
          JSON.stringify({ summary: `${args.roleId} summary`, decisions: ['implementation kept inside Room workspace'], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: args.roleId === 'operator' ? 'final room answer' : '' }),
          '</ROOM_STAGE_RESULT>',
        ].join('\n'),
      };
    },
  };
  const agentRuntime = new RoomAgentRuntime({ env, providers });
  const engine = new RoomLoopEngine({ env, agentRuntime });
  const service = new RoomNativeService({ env, engine });
  return { root, env, calls, service };
}

test('review loop executes only against canonical Room workspace or isolated snapshots', async () => {
  const fx = fixture();
  try {
    const room = fx.service.initializeRoom('telegram-42');
    fs.writeFileSync(path.join(room.workspaceRoot, 'input.txt'), 'hello');
    const started = await fx.service.startRun({ roomId: 'telegram-42', objective: 'Implement and review a small change', collaborationProfile: 'builder_reviewer', visibility: 'debug' });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.equal(result.run.state.status, 'completed');
    assert.equal(fs.existsSync(path.join(room.workspaceRoot, 'implemented.txt')), true);
    assert.equal(fs.existsSync(path.join(room.workspaceRoot, '.snapshot-reviewer.txt')), false);
    const codexCalls = fx.calls.filter((row) => row.provider === 'codex');
    const antigravityCalls = fx.calls.filter((row) => row.provider === 'antigravity');
    assert.ok(codexCalls.length >= 2);
    assert.ok(antigravityCalls.length >= 1);
    assert.ok(codexCalls.every((row) => row.workspaceRoot === room.workspaceRoot));
    assert.ok(antigravityCalls.every((row) => row.workspaceRoot !== room.workspaceRoot));
    assert.ok(antigravityCalls.every((row) => row.workspaceRoot.startsWith(started.room.roomStateRoot)));
    assert.deepEqual(result.run.state.skipped_stage_ids, ['revise_1', 'review_2', 'revise_2']);
    assert.equal(result.finalStage.structured.user_message, 'final room answer');
    const archiveManifest = JSON.parse(fs.readFileSync(path.join(result.run.paths.runRoot, 'archive', 'manifest.json'), 'utf8'));
    assert.equal(archiveManifest.all_round_trips_verified, true);
    assert.ok(archiveManifest.archives.length >= 1);
    const originalEvents = fs.readFileSync(result.run.paths.eventsPath);
    const restoredEvents = zlib.gunzipSync(fs.readFileSync(path.join(result.run.paths.runRoot, 'archive', 'events.jsonl.gz')));
    assert.deepEqual(restoredEvents, originalEvents);
    assert.match(restoredEvents.toString('utf8'), /"event_type":"run_completed"/);
    const finalization = JSON.parse(fs.readFileSync(path.join(result.run.paths.runRoot, 'finalization.json'), 'utf8'));
    assert.equal(finalization.cold_archive_verified, true);
    assert.ok(finalization.execution_receipt_count >= 3);
    const checkpoint = JSON.parse(fs.readFileSync(result.run.paths.checkpointPath, 'utf8'));
    assert.equal(checkpoint.provider_sessions_required, false);
    assert.equal(checkpoint.resume_contract.provider_may_change, true);
    assert.ok(checkpoint.receipt_index.length >= 3);
    assert.equal(fs.readdirSync(result.run.paths.receiptsRoot).filter((name) => name.endsWith('.json')).length, checkpoint.receipt_index.length);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('only one active run is allowed per Room', async () => {
  const fx = fixture();
  try {
    let release;
    fx.service.engine.agentRuntime.providers.codex = async (args) => {
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, stdout: '<ROOM_STAGE_RESULT>{"summary":"done","decisions":[],"blocking_issues":[],"resolved_issues":[],"next_actions":[],"user_message":""}</ROOM_STAGE_RESULT>' };
    };
    const first = await fx.service.startRun({ roomId: 'telegram-99', objective: 'first', collaborationProfile: 'solo' });
    await assert.rejects(() => fx.service.startRun({ roomId: 'telegram-99', objective: 'second', collaborationProfile: 'solo' }), /active run/);
    fx.service.control('telegram-99', 'cancel', 'test');
    release?.();
    await first.completion;
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('persisted failed Room run resumes from the first incomplete stage', async () => {
  const fx = fixture();
  try {
    let failReviewOnce = true;
    fx.service.engine.agentRuntime.providers.antigravity = async (args) => {
      fx.calls.push({ provider: 'antigravity', ...args });
      if (args.roleId === 'reviewer' && failReviewOnce) {
        failReviewOnce = false;
        return { ok: false, stderr: 'simulated review failure' };
      }
      return {
        ok: true,
        stdout: '<ROOM_STAGE_RESULT>{"summary":"review resumed","decisions":[],"blocking_issues":[],"resolved_issues":[],"next_actions":[],"user_message":""}</ROOM_STAGE_RESULT>',
      };
    };
    const first = await fx.service.startRun({ roomId: 'telegram-resume', objective: 'resume test', collaborationProfile: 'builder_reviewer' });
    const firstResult = await first.completion;
    assert.equal(firstResult.ok, false);
    assert.equal(firstResult.run.state.status, 'failed');
    assert.deepEqual(firstResult.run.state.completed_stage_ids, ['execute']);

    const resumed = await fx.service.resumeRun({ roomId: 'telegram-resume' });
    const resumedResult = await resumed.completion;
    assert.equal(resumedResult.ok, true);
    assert.equal(resumedResult.run.state.status, 'completed');
    assert.ok(resumedResult.run.state.completed_stage_ids.includes('execute'));
    assert.ok(resumedResult.run.state.completed_stage_ids.includes('verify'));
    assert.equal(fs.existsSync(path.join(resumed.room.workspaceRoot, 'implemented.txt')), true);
    const executeCalls = fx.calls.filter((row) => row.provider === 'codex' && row.surface === 'room_native_execute');
    assert.equal(executeCalls.length, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('transient stage failures are retried but boundary failures are not', async () => {
  const fx = fixture();
  try {
    fx.env.ROOM_STAGE_MAX_ATTEMPTS = '2';
    let attempts = 0;
    fx.service.engine.agentRuntime.providers.codex = async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('429 rate limit');
        error.code = 'ROOM_PROVIDER_EXECUTION_FAILED';
        error.result = { stderr: '429 rate limit' };
        throw error;
      }
      return { ok: true, stdout: '<ROOM_STAGE_RESULT>{"summary":"recovered","decisions":[],"blocking_issues":[],"resolved_issues":[],"next_actions":[],"user_message":""}</ROOM_STAGE_RESULT>' };
    };
    const started = await fx.service.startRun({ roomId: 'telegram-retry', objective: 'retry test', collaborationProfile: 'solo' });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
    const events = fs.readFileSync(result.run.paths.eventsPath, 'utf8');
    assert.match(events, /"event_type":"stage_retry"/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});


test('malformed stage output is bounded, persisted, and does not crash the Room run', async () => {
  const fx = fixture();
  try {
    fx.service.engine.agentRuntime.providers.codex = async (args) => ({
      ok: true,
      stdout: `${args.roleId} produced plain output without the structured block`,
    });
    const started = await fx.service.startRun({ roomId: 'telegram-malformed', objective: 'malformed contract fallback', collaborationProfile: 'solo' });
    const result = await started.completion;
    assert.equal(result.ok, true);
    const execute = JSON.parse(fs.readFileSync(path.join(result.run.paths.stagesRoot, 'execute.json'), 'utf8'));
    assert.equal(execute.contract_observed, false);
    assert.match(execute.structured.summary, /plain output without the structured block/);
    assert.ok(execute.structured.summary.length <= 2400);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});


test('review blockers trigger bounded revision and independent re-review', async () => {
  const fx = fixture();
  try {
    fx.service.engine.agentRuntime.providers.antigravity = async (args) => {
      fx.calls.push({ provider: 'antigravity', ...args });
      const reviewOne = String(args.surface || '').endsWith('review_1');
      const reviewTwo = String(args.surface || '').endsWith('review_2');
      const body = reviewOne
        ? { summary: 'review found one blocker', decisions: [], blocking_issues: ['bug A must be fixed'], resolved_issues: [], next_actions: [], user_message: '' }
        : reviewTwo
          ? { summary: 'second review found no blockers', decisions: [], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: '' }
          : { summary: `${args.roleId} summary`, decisions: [], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: '' };
      return { ok: true, stdout: `<ROOM_STAGE_RESULT>${JSON.stringify(body)}</ROOM_STAGE_RESULT>` };
    };
    fx.service.engine.agentRuntime.providers.codex = async (args) => {
      fx.calls.push({ provider: 'codex', ...args });
      const revision = String(args.surface || '').endsWith('revise_1');
      const body = {
        summary: revision ? 'fixed bug A' : `${args.roleId} summary`,
        decisions: [],
        blocking_issues: [],
        resolved_issues: revision ? ['bug A must be fixed'] : [],
        next_actions: [],
        user_message: args.roleId === 'operator' ? 'bounded loop done' : '',
      };
      return { ok: true, stdout: `<ROOM_STAGE_RESULT>${JSON.stringify(body)}</ROOM_STAGE_RESULT>` };
    };
    const started = await fx.service.startRun({ roomId: 'telegram-feedback', objective: 'bounded review loop', collaborationProfile: 'builder_reviewer' });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.ok(result.run.state.completed_stage_ids.includes('review_1'));
    assert.ok(result.run.state.completed_stage_ids.includes('revise_1'));
    assert.ok(result.run.state.completed_stage_ids.includes('review_2'));
    assert.ok(result.run.state.skipped_stage_ids.includes('revise_2'));
    assert.deepEqual(result.workingMemory.open_blockers, []);
    assert.equal(result.finalStage.structured.user_message, 'bounded loop done');
    const revision = JSON.parse(fs.readFileSync(path.join(result.run.paths.stagesRoot, 'revise_1.json'), 'utf8'));
    assert.equal(revision.feedback_delivery.blocker_count, 1);
    assert.equal(revision.revision_consumption.resolved_delivered_count, 1);
    assert.equal(revision.revision_consumption.unresolved_delivered_count, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});



test('provider intermediate output becomes bounded Room progress events and timeline evidence', async () => {
  const fx = fixture();
  try {
    const progress = [];
    fx.service.engine.agentRuntime.providers.codex = async (args) => {
      await args.onOutput?.({ stream: 'stdout', chunk: 'Running npm test\n', sequence: 1, elapsedMs: 5 });
      await args.onOutput?.({ stream: 'stdout', chunk: 'Updated src/example.js\n', sequence: 2, elapsedMs: 10 });
      return { ok: true, stdout: '<ROOM_STAGE_RESULT>{"summary":"codex done","decisions":[],"blocking_issues":[],"resolved_issues":[],"next_actions":[],"user_message":"final answer"}</ROOM_STAGE_RESULT>' };
    };
    const started = await fx.service.startRun({ roomId: 'telegram-stream', objective: 'stream progress', collaborationProfile: 'solo', onProgress: async (event) => progress.push(event) });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.ok(progress.some((event) => event.event === 'stage_output' && /Running npm test/.test(event.message)));
    const events = fs.readFileSync(result.run.paths.eventsPath, 'utf8');
    assert.match(events, /"event_type":"stage_output"/);
    const execute = JSON.parse(fs.readFileSync(path.join(result.run.paths.stagesRoot, 'execute.json'), 'utf8'));
    assert.ok(execute.stream_summary.projected_event_count >= 2);
    const terminal = progress.findLast((event) => event.event === 'run_completed');
    assert.equal(terminal.message, 'codex done');
    assert.doesNotMatch(terminal.message, /final answer/);
    const timeline = fx.service.timeline('telegram-stream', { limit: 50 });
    assert.ok(timeline.events.some((event) => event.event_type === 'stage_output'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unresolved blocking issues produce an honest completed_with_blockers outcome', async () => {
  const fx = fixture();
  try {
    fx.service.engine.agentRuntime.providers.antigravity = async (args) => {
      const isReview = String(args.surface || '').includes('review_');
      const body = isReview
        ? { summary: 'blocking defect remains', decisions: [], blocking_issues: ['critical defect remains'], resolved_issues: [], next_actions: [], user_message: '' }
        : { summary: `${args.roleId} summary`, decisions: [], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: '' };
      return { ok: true, stdout: `<ROOM_STAGE_RESULT>${JSON.stringify(body)}</ROOM_STAGE_RESULT>` };
    };
    fx.service.engine.agentRuntime.providers.codex = async (args) => ({
      ok: true,
      stdout: `<ROOM_STAGE_RESULT>${JSON.stringify({ summary: 'attempted fix', decisions: [], blocking_issues: [], resolved_issues: [], next_actions: [], user_message: args.roleId === 'operator' ? 'manual attention required' : '' })}</ROOM_STAGE_RESULT>`,
    });
    const started = await fx.service.startRun({ roomId: 'telegram-blocked', objective: 'honest blocker outcome', collaborationProfile: 'builder_reviewer' });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.equal(result.needs_attention, true);
    assert.equal(result.run.state.status, 'completed_with_blockers');
    const final = JSON.parse(fs.readFileSync(path.join(result.run.paths.runRoot, 'final.json'), 'utf8'));
    assert.equal(final.quality_gate_passed, false);
    assert.deepEqual(final.open_blockers, ['critical defect remains']);
    const events = fs.readFileSync(result.run.paths.eventsPath, 'utf8');
    assert.match(events, /run_completed_with_blockers/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});


test('explicit profile flag overrides a stored or caller-provided collaboration profile', async () => {
  const fx = fixture();
  try {
    const started = await fx.service.startRun({
      roomId: 'telegram-profile-override',
      objective: '--profile solo fix one file',
      collaborationProfile: 'builder_reviewer',
    });
    const result = await started.completion;
    assert.equal(result.ok, true);
    assert.equal(started.spec.execution_graph.collaboration_profile_id, 'solo');
    assert.deepEqual(started.spec.execution_graph.stages.map((stage) => stage.stage_id), ['execute']);
    assert.equal(started.spec.objective, 'fix one file');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
