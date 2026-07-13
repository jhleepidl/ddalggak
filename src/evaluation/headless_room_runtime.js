import path from 'node:path';

import { ChatRunManager } from '../chat/run_manager.js';
import { getAgentRoomProfile, upsertAgentRoomProfile } from '../application/agent_room_profile.js';
import { getCollaborationProfile } from '../application/collaboration_profile_catalog.js';
import {
  appendRoomCompanionEvent,
  buildCorrectionMergeProposalEvent,
  classifyRoomCorrectionIntent,
  deriveRoomCompanionState,
  readRoomCompanionEvents,
} from '../application/room_companions.js';
import { runRoomIdleMemoryStructuring } from '../application/room_idle_memory.js';
import {
  deriveRoomMemoryView,
  updateRoomMemoryCandidateDecision,
} from '../application/room_memory_view.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function nowIso() { return new Date().toISOString(); }

function normalizeRuleText(value = '') {
  return clean(value)
    .replace(/^\/?rule\s+/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function inferRuleTopic(value = '') {
  const text = clean(value).toLowerCase();
  if (/(artifact|deliverable|workspace|file|document|산출물|결과물|파일|문서)/i.test(text)) return 'artifacts';
  if (/(memory|remember|retain|메모리|기억)/i.test(text)) return 'memory';
  if (/(answer|response|tone|style|format|답변|응답|말투|형식)/i.test(text)) return 'answer_style';
  if (/(source|citation|search|web|출처|인용|검색|웹)/i.test(text)) return 'search';
  if (/(model|agent|router|routing|모델|에이전트|라우팅)/i.test(text)) return 'agent_behavior';
  return 'general';
}

function addRuntimeRule(sessionStore, roomId, value = '') {
  const text = normalizeRuleText(value);
  if (!text) return null;
  const topic = inferRuleTopic(text);
  const now = nowIso();
  const rule = {
    id: `rule_${Date.now().toString(36)}`,
    text,
    display_text: text,
    source_original_text: text,
    source_original_language: 'unknown',
    original_language: 'unknown',
    canonical_language: 'en',
    canonical_text_en: '',
    canonical_projection_status: 'not_requested',
    enabled: true,
    scope: 'chat',
    source: 'user',
    origin: 'headless_room_journey',
    topic,
    created_at: now,
  };
  sessionStore.upsert(roomId, (session = {}) => {
    const rows = asArray(session.runtime_rules)
      .filter((row) => row?.enabled !== false && clean(row?.text));
    const normalized = text.toLowerCase();
    const next = rows
      .filter((row) => clean(row.text).toLowerCase() !== normalized)
      .filter((row) => topic === 'general' || clean(row.topic || inferRuleTopic(row.text)).toLowerCase() !== topic);
    return { ...session, runtime_rules: [...next, rule].slice(-14) };
  });
  return rule;
}

export function createHeadlessResponseSink() {
  let sequence = 0;
  const messages = [];
  const record = (method, roomId, text = '', extra = {}) => {
    sequence += 1;
    const row = {
      sequence,
      method,
      room_id: clean(roomId),
      chat_id: clean(roomId),
      text: String(text ?? ''),
      ts: nowIso(),
      ...asObject(extra),
    };
    messages.push(row);
    return row;
  };
  const target = {
    messages,
    mark() { return sequence; },
    messagesSince(mark = 0, roomId = '') {
      const id = clean(roomId);
      return messages.filter((row) => row.sequence > Number(mark || 0) && (!id || row.room_id === id));
    },
    async sendMessage(roomId, text, options = {}) {
      const row = record('sendMessage', roomId, text, { options: asObject(options) });
      return { message_id: row.sequence, chat: { id: roomId }, text: String(text ?? ''), date: Math.floor(Date.now() / 1000) };
    },
    async editMessageText(text, options = {}) {
      const row = record('editMessageText', options.chat_id || options.room_id, text, { options: asObject(options) });
      return { message_id: options.message_id || row.sequence, chat: { id: options.chat_id || options.room_id }, text: String(text ?? '') };
    },
    async sendDocument(roomId, document, options = {}) {
      const caption = clean(options.caption || '');
      const row = record('sendDocument', roomId, caption, {
        document: typeof document === 'string' ? document : '[buffer]',
        options: asObject(options),
      });
      return { message_id: row.sequence, chat: { id: roomId }, document: { file_name: path.basename(String(document || 'artifact')) }, caption };
    },
    async sendChatAction(roomId, action) { record('sendChatAction', roomId, action); return true; },
    async deleteMessage(roomId, messageId) { record('deleteMessage', roomId, '', { message_id: messageId }); return true; },
    async answerCallbackQuery(callbackQueryId, options = {}) { record('answerCallbackQuery', '', clean(options.text), { callback_query_id: callbackQueryId }); return true; },
    async editMessageReplyMarkup(replyMarkup = {}, options = {}) { record('editMessageReplyMarkup', options.chat_id || options.room_id, '', { reply_markup: replyMarkup, options }); return true; },
    async getMe() { return { id: 'room_journey_benchmark', username: 'room_journey_headless' }; },
    async getChat(roomId) { return { id: roomId, type: 'private', title: 'Headless Room Journey' }; },
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        const value = Reflect.get(object, property, receiver);
        return typeof value === 'function' ? value.bind(object) : value;
      }
      if (typeof property !== 'string') return undefined;
      return async (...args) => {
        const roomId = args[0] ?? '';
        record(property, roomId, typeof args[1] === 'string' ? args[1] : '', { argument_count: args.length });
        return true;
      };
    },
  });
}

function currentJobContext(runtimeCore, roomId) {
  const jobId = clean(runtimeCore.resolveCurrentJobIdForChat?.(roomId));
  let jobDir = '';
  if (jobId) {
    try { jobDir = runtimeCore.jobs?.jobDir?.(jobId) || ''; } catch {}
  }
  return { jobId, jobDir };
}

function companionContext(runtimeCore, roomId) {
  const session = runtimeCore.chatSessionStore.get(roomId) || {};
  const { jobId, jobDir } = currentJobContext(runtimeCore, roomId);
  const events = readRoomCompanionEvents({ jobDir, session, limit: 120 });
  return {
    session,
    jobId,
    jobDir,
    state: deriveRoomCompanionState({ events, session }),
  };
}

function appendCompanionEvent(runtimeCore, roomId, userId, event) {
  const { jobId, jobDir } = currentJobContext(runtimeCore, roomId);
  return appendRoomCompanionEvent({
    jobDir,
    chatSessionStore: runtimeCore.chatSessionStore,
    chatId: roomId,
    userId,
    jobId,
    event,
  });
}

export async function executeHeadlessRoomCommand({ runtimeCore, sink, roomId = '', userId = '', commandText = '' } = {}) {
  const command = clean(commandText);
  if (!command.startsWith('/')) throw new Error(`Headless Room command must start with /: ${command}`);
  const firstSpace = command.indexOf(' ');
  const name = (firstSpace < 0 ? command : command.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace < 0 ? '' : clean(command.slice(firstSpace + 1));
  const store = runtimeCore.chatSessionStore;

  if (name === '/rule') {
    const rule = addRuntimeRule(store, roomId, args);
    if (!rule) throw new Error('Usage: /rule <instruction>');
    await sink.sendMessage(roomId, `Room rule saved: ${rule.text}`);
    return { ok: true, command: name, rule };
  }

  if (name === '/rules') {
    const rules = asArray(store.get(roomId)?.runtime_rules).filter((row) => row?.enabled !== false && clean(row?.text));
    await sink.sendMessage(roomId, JSON.stringify({ rules }, null, 2));
    return { ok: true, command: name, rules };
  }

  if (name === '/collab' || name === '/collaboration') {
    const [subRaw = '', ...rest] = args.split(/\s+/).filter(Boolean);
    const sub = clean(subRaw).toLowerCase();
    const profileId = clean(rest.join(' ') || (sub && !['use', 'apply', 'set', 'reset', 'auto', 'show', 'list'].includes(sub) ? sub : ''));
    if (['reset', 'auto'].includes(sub)) {
      const profile = upsertAgentRoomProfile(store, roomId, {
        collaboration_profile_id: 'auto',
        collaboration_profile_source: 'headless_room_journey_reset',
      });
      await sink.sendMessage(roomId, 'Room collaboration profile reset to auto');
      return { ok: true, command: name, profile };
    }
    if (['use', 'apply', 'set'].includes(sub)) {
      const target = getCollaborationProfile(profileId);
      if (!target) throw new Error(`Collaboration profile not found: ${profileId}`);
      if (target.runtime_support !== 'native') throw new Error(`Collaboration profile is not runtime-native: ${profileId}`);
      const profile = upsertAgentRoomProfile(store, roomId, {
        collaboration_profile_id: target.id,
        collaboration_profile_source: 'headless_room_journey_explicit',
      });
      await sink.sendMessage(roomId, `Room collaboration profile applied: ${target.id}`);
      return { ok: true, command: name, collaboration_profile: target, profile };
    }
    const current = getAgentRoomProfile(store, roomId) || {};
    await sink.sendMessage(roomId, JSON.stringify({ collaboration_profile_id: current.collaboration_profile_id || 'auto' }, null, 2));
    return { ok: true, command: name, profile: current };
  }

  if (name === '/memory') {
    const [subRaw = '', targetRaw = '', ...reasonParts] = args.split(/\s+/).filter(Boolean);
    const sub = clean(subRaw).toLowerCase();
    const session = store.get(roomId) || {};
    if (sub === 'idle') {
      const context = companionContext(runtimeCore, roomId);
      const result = runRoomIdleMemoryStructuring({
        chatSessionStore: store,
        chatId: roomId,
        roomProfile: getAgentRoomProfile(store, roomId),
        companionState: context.state,
        force: true,
        minIntervalMs: 0,
        source: 'headless_room_journey_benchmark',
        appendEvent: (event) => appendCompanionEvent(runtimeCore, roomId, userId, event),
      });
      await sink.sendMessage(roomId, JSON.stringify({ candidates_created: result.candidates_created, candidate_ids: asArray(result.candidates).map((row) => row.candidate_id) }, null, 2));
      return { ...result, command: name, ok: result.ok !== false };
    }
    if (sub === 'approve' || sub === 'reject') {
      const result = updateRoomMemoryCandidateDecision({
        chatSessionStore: store,
        chatId: roomId,
        target: targetRaw || 'latest',
        decision: sub,
        userId,
        reason: reasonParts.join(' '),
      });
      await sink.sendMessage(roomId, JSON.stringify({ status: result.status, candidate_id: result.candidate?.candidate_id || null, memory_id: result.memory_item?.memory_id || null, reason: result.reason || null }, null, 2));
      return { ...result, command: name };
    }
    const view = deriveRoomMemoryView({ session, companionState: companionContext(runtimeCore, roomId).state, includeRejected: true });
    await sink.sendMessage(roomId, JSON.stringify(view, null, 2));
    return { ok: true, command: name, memory_view: view };
  }

  if (name === '/correct') {
    if (!args) throw new Error('Usage: /correct <correction>');
    const intent = classifyRoomCorrectionIntent(args);
    const correction = appendCompanionEvent(runtimeCore, roomId, userId, {
      event_type: 'user_correction',
      correction_text: args,
      scope: intent.correction_scope,
      promotion_status: intent.promotion_status,
      command: '/correct',
      source: 'headless_room_journey',
      payload: {
        durability: intent.durability,
        risk_level: intent.risk_level,
        rationale: intent.rationale,
      },
    });
    let proposal = null;
    if (correction) {
      const state = companionContext(runtimeCore, roomId).state;
      proposal = buildCorrectionMergeProposalEvent({ correction: { ...correction, text: args }, state });
      if (proposal) appendCompanionEvent(runtimeCore, roomId, userId, { ...proposal, command: '/correct', source: 'headless_room_journey' });
    }
    await sink.sendMessage(roomId, JSON.stringify({ correction_event_id: correction?.event_id || null, scope: intent.correction_scope, durable_proposal_created: Boolean(proposal) }, null, 2));
    return { ok: Boolean(correction), command: name, correction, proposal, intent };
  }

  throw new Error(`Unsupported headless Room command: ${name}`);
}

let defaultRuntime = null;
let defaultRuntimeRoot = '';

export async function createHeadlessRoomRuntime({ runtimeRoot = '', traceRoot = '' } = {}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || 'runs/room_journey_headless_runtime');
  if (defaultRuntime) {
    if (defaultRuntimeRoot !== resolvedRuntimeRoot) {
      throw new Error(`Headless Room runtime is already initialized at ${defaultRuntimeRoot}; start a new process to use ${resolvedRuntimeRoot}`);
    }
    return defaultRuntime;
  }

  process.env.RUNS_DIR = resolvedRuntimeRoot;
  process.env.MEMORY_MODE = 'local';
  if (traceRoot) process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR = path.resolve(traceRoot);

  const runtimeCore = await import('../application/telegram_runtime_ops.js');
  const sink = createHeadlessResponseSink();
  const chatRunManager = new ChatRunManager({
    sessionStore: runtimeCore.chatSessionStore,
    interruptDebounceMs: 0,
    cancelCurrent: async ({ chatId, mode, reason }) => runtimeCore.requestChatInterrupt?.(chatId, { mode, reason }),
    onAck: async ({ chatId, mode }) => {
      if (mode === 'cancel') await sink.sendMessage(chatId, 'Headless Room run cancelled');
    },
    onRunError: async ({ chatId, error }) => {
      await sink.sendMessage(chatId, `Headless Room run failed: ${clean(error?.message || error)}`);
    },
    runChat: async ({ chatId, userId, message, inputKind, pendingCount, forceMode, chatInfo, teamConfig }) => {
      await runtimeCore.runSupervisorChat(
        sink,
        chatId,
        userId,
        message,
        {
          debug: false,
          chatInfo: chatInfo && typeof chatInfo === 'object' ? chatInfo : { chat_id: String(chatId || '') },
          inputKind: inputKind || (pendingCount > 1 ? 'interrupt_update' : 'chat_message'),
          forceMode: runtimeCore.normalizeForceMode?.(forceMode) || forceMode || 'normal',
          teamConfig: teamConfig && typeof teamConfig === 'object' ? teamConfig : null,
        },
      );
    },
  });

  const handleRoomCommand = async ({ chatId = '', userId = '', text = '' } = {}) => executeHeadlessRoomCommand({
    runtimeCore,
    sink,
    roomId: chatId,
    userId,
    commandText: text,
  });

  defaultRuntimeRoot = resolvedRuntimeRoot;
  defaultRuntime = {
    bot: sink,
    responseSink: sink,
    chatRunManager,
    handleRoomCommand,
    runtimeCore,
    runtimeRoot: resolvedRuntimeRoot,
    transport: 'headless',
    telegramConnected: false,
  };
  return defaultRuntime;
}
