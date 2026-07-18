import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';

function makeContract() {
  return {
    schema_version: 'ai_rooms.room_contract/v1',
    contract_revision: 3,
    contract_hash: 'abcdef1234567890',
    room_id: 'telegram-chat-1',
    goal: 'Ship the safe patch',
    objective: 'Fix the failing tests',
    completion_contract: ['tests pass'],
    constraints: ['Do not change the public API.'],
    sources: { authoritative: ['requirements.md'], excluded: ['stale-notes.md'] },
    corrections: [{ correction_id: 'c1', text: 'Keep the approved API.', status: 'active' }],
    requested_artifacts: [],
    approval_policy: { mode: 'bounded', require_for: [] },
    provider_policy: {},
    continuity: { next_action: 'Review the patch', branches: [], pending_review_count: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function harness({ status = {}, contract = makeContract() } = {}) {
  const sent = [];
  const starts = [];
  const resumes = [];
  const inboxDecisions = [];
  const corrections = [];
  const restarts = [];
  const documents = [];
  const pending = new Promise(() => {});
  const service = {
    isEnabled: () => true,
    hasState: () => true,
    status: () => ({
      room_id: 'telegram-chat-1',
      workspace_root: '/rooms/chat-1/workspace',
      focus_run_id: 'run-1',
      active_run_id: 'run-1',
      focus_status: 'running',
      goal: 'Ship the safe patch',
      objective: 'Fix the failing tests',
      current_stage_id: 'execute',
      next_stage_id: null,
      stage_done_count: 0,
      stage_total: 1,
      receipt_count: 1,
      open_blockers: [],
      next_action: 'Review the patch',
      ...status,
    }),
    contract: () => contract,
    startRun: async (args) => {
      starts.push(args);
      return {
        room: { roomId: args.roomId, workspaceRoot: '/rooms/chat-1/workspace' },
        run_id: 'run-new',
        spec: { execution_graph: { collaboration_profile_id: 'solo' } },
        completion: pending,
      };
    },
    resumeRun: async (args) => {
      resumes.push(args);
      return { run_id: 'run-1', completion: pending };
    },
    receipts: () => ({ room_id: 'telegram-chat-1', run_id: 'run-1', status: 'running', receipts: [] }),
    artifacts: () => ({ room_id: 'telegram-chat-1', run_id: 'run-1', status: 'running', contract_revision: 3, artifacts: [{ artifact_id: 'artifact-result', relative_path: 'reports/result.md', location: 'reports/result.md', absolute_path: '/rooms/chat-1/workspace/reports/result.md', label: 'Result report', available: true, previewable: true, sendable: true, bytes: 42, provider: 'codex', stage_id: 'execute', receipt_hash: '1234567890abcdef', approval_state: 'not_required' }] }),
    artifact: () => ({ room_id: 'telegram-chat-1', run_id: 'run-1', status: 'running', contract_revision: 3, artifact: { artifact_id: 'artifact-result', relative_path: 'reports/result.md', absolute_path: '/rooms/chat-1/workspace/reports/result.md', label: 'Result report', available: true, previewable: true, sendable: true, bytes: 42, provider: 'codex', stage_id: 'execute', receipt_hash: '1234567890abcdef', approval_state: 'not_required' } }),
    previewArtifact: () => ({ room_id: 'telegram-chat-1', run_id: 'run-1', artifact: { artifact_id: 'artifact-result', relative_path: 'reports/result.md', label: 'Result report', bytes: 42, receipt_hash: '1234567890abcdef' }, preview: { artifact: { artifact_id: 'artifact-result', relative_path: 'reports/result.md', label: 'Result report', bytes: 42, receipt_hash: '1234567890abcdef' }, text: '# Result\nPassed.', total_bytes: 42, bytes_read: 42, truncated: false } }),
    recordArtifactDelivery: () => null,
    inbox: () => ({ room_id: 'telegram-chat-1', run_id: 'run-1', status: 'completed_with_blockers', totals: { approvals: 0, blockers: 1, failed_validations: 0, total: 1 }, items: [{ item_id: 'blocker:abc', kind: 'blocker', title: 'Need user decision', detail: 'run run-1', actions: ['resolve'] }] }),
    decideInboxItem: (_roomId, payload) => { inboxDecisions.push(payload); return { item: { item_id: 'blocker:abc', kind: 'blocker' }, decision: { action: 'resolve' }, control: null }; },
    recordCorrection: (_roomId, payload) => { corrections.push(payload); return { active_run_id: 'run-1', contract: { contract_revision: 4 }, applies_to: 'next_run' }; },
    restartWithCorrection: async (_roomId, payload) => { restarts.push(payload); return { correction: { contract: { contract_revision: 4 } }, restarted: true, previous_run_id: 'run-1', started: { run_id: 'run-2', completion: pending } }; },
    initializeRoom: () => ({ roomId: 'telegram-chat-1', workspaceRoot: '/rooms/chat-1/workspace' }),
    setVisibility: (_roomId, value) => value,
    timeline: () => ({ run_id: 'run-1', events: [] }),
    control: () => ({ ok: true, status: 'paused' }),
  };
  const session = {
    runtime_rules: [{ text: 'Use the supported Node version.', enabled: true }],
    room_companion_events: [{ event_type: 'user_correction', correction_text: 'Do not remove compatibility mode.', ts: new Date().toISOString() }],
  };
  const handler = createTelegramCommandHandler({
    bot: {
      async sendMessage(chatId, text, options = {}) {
        sent.push({ chatId, text: String(text), options });
        return { message_id: sent.length };
      },
      async sendDocument(chatId, filePath, options = {}) {
        documents.push({ chatId, filePath, options });
        return { message_id: sent.length + documents.length };
      },
    },
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text: String(text), options: {} });
      return { message_id: sent.length };
    },
    runtimeEnv: { ROOM_EXECUTION_ENGINE: 'room_native_v2', ROOM_NATIVE_PRIMARY_USER_PATH: 'true' },
    roomNativeService: service,
    chatSessionStore: { get: () => session, upsert: () => {} },
    resolveLiveJobIdForChat: () => '',
  });
  return { handler, sent, starts, resumes, inboxDecisions, corrections, restarts, documents, service };
}

async function run(h, text) {
  return h.handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' }, message_id: 1 }, text, chatId: 'chat-1', userId: 'user-1' });
}

test('/home uses the Room-native state and provides tappable primary actions', async () => {
  const h = harness();
  await run(h, '/home');
  assert.match(h.sent.at(-1).text, /🏠 AI Room/);
  assert.match(h.sent.at(-1).text, /Ship the safe patch/);
  assert.match(h.sent.at(-1).text, /상태: 작업 중/);
  const keyboard = h.sent.at(-1).options?.reply_markup?.keyboard?.flat?.().map((row) => row.text) || [];
  assert.ok(keyboard.includes('/continue'));
  assert.ok(keyboard.includes('/artifacts'));
});

test('/run starts the Room-native execution path by default', async () => {
  const h = harness({ status: { focus_run_id: null, active_run_id: null, focus_status: null } });
  await run(h, '/run fix the failing tests');
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].objective, 'fix the failing tests');
  assert.match(h.sent.at(-1).text, /Room 작업을 시작했습니다/);
});

test('/continue resumes the Room-native run when no legacy job id is given', async () => {
  const h = harness({ status: { focus_status: 'paused', active_run_id: 'run-1' } });
  await run(h, '/continue');
  assert.equal(h.resumes.length, 1);
  assert.match(h.sent.at(-1).text, /Room 작업을 이어갑니다/);
});

test('primary status, sources, rules, and artifacts read from the same Room surface', async () => {
  const h = harness();
  await run(h, '/status');
  assert.match(h.sent.at(-1).text, /Room Brief/);
  assert.match(h.sent.at(-1).text, /현재 단계: execute/);

  await run(h, '/sources');
  assert.match(h.sent.at(-1).text, /requirements\.md/);
  assert.match(h.sent.at(-1).text, /stale-notes\.md/);

  await run(h, '/rules');
  assert.match(h.sent.at(-1).text, /Do not change the public API/);
  assert.match(h.sent.at(-1).text, /Use the supported Node version/);
  assert.match(h.sent.at(-1).text, /Do not remove compatibility mode/);

  await run(h, '/artifacts');
  assert.match(h.sent.at(-1).text, /Result report/);
  assert.match(h.sent.at(-1).text, /reports\/result\.md/);
});

test('/home gives a one-command first-run path when no Room state exists', async () => {
  const h = harness({ status: { focus_run_id: null, active_run_id: null, focus_status: null, contract_revision: null, goal: '', objective: '' }, contract: null });
  h.service.hasState = () => false;
  await run(h, '/home');
  assert.match(h.sent.at(-1).text, /\/run <하고 싶은 일>/);
  assert.doesNotMatch(h.sent.at(-1).text, /\/room apply/);
});


test('Room-native artifacts support preview and direct Telegram delivery', async () => {
  const h = harness();
  await run(h, '/artifacts');
  assert.match(h.sent.at(-1).text, /미리보기: \/artifacts preview/);
  assert.match(h.sent.at(-1).text, /receipt 1234567890ab/);

  await run(h, '/artifacts preview 1');
  assert.match(h.sent.at(-1).text, /Artifact Preview/);
  assert.match(h.sent.at(-1).text, /Passed/);

  await run(h, '/send 1');
  assert.equal(h.documents.length, 1);
  assert.equal(h.documents[0].filePath, '/rooms/chat-1/workspace/reports/result.md');
  assert.match(h.sent.at(-1).text, /Room 산출물을 전송/);
});

test('Room-native inbox exposes blockers and records explicit resolution', async () => {
  const h = harness();
  await run(h, '/inbox');
  assert.match(h.sent.at(-1).text, /Room Inbox/);
  assert.match(h.sent.at(-1).text, /Need user decision/);

  await run(h, '/inbox resolve 1 accepted-risk');
  assert.equal(h.inboxDecisions.length, 1);
  assert.equal(h.inboxDecisions[0].itemId, '1');
  assert.equal(h.inboxDecisions[0].note, 'accepted-risk');
  assert.match(h.sent.at(-1).text, /resolve 처리/);
});

test('corrections clearly distinguish next-run application from controlled restart', async () => {
  const h = harness();
  await run(h, '/correct Keep compatibility mode');
  assert.equal(h.corrections.length, 1);
  assert.match(h.sent.at(-1).text, /현재 실행 run-1의 contract는 변경하지 않았습니다/);
  assert.match(h.sent.at(-1).text, /다음 \/run부터 적용/);

  await run(h, '/correct now Never remove compatibility mode');
  assert.equal(h.restarts.length, 1);
  assert.match(h.sent.at(-1).text, /새 run run-2으로 재시작/);
  assert.match(h.sent.at(-1).text, /실행 이력은 불변/);
});
