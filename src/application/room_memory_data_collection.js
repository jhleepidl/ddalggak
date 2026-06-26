import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', { maxLen = 500, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}

function nowIso() {
  return new Date().toISOString();
}

function boolEnv(value = '') {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
}

function safeId(value = '', fallback = '') {
  const id = clean(value || fallback, { maxLen: 180, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || fallback;
}

function stripRawTextFields(value) {
  if (Array.isArray(value)) return value.map(stripRawTextFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (['text', 'raw_text', 'rawtext', 'body', 'content', 'message', 'prompt', 'answer', 'response', 'question', 'freeform_note', 'note'].includes(lower)) continue;
    if (lower.includes('transcript') || lower.includes('attachment_bytes')) continue;
    out[key] = stripRawTextFields(raw);
  }
  return out;
}

export function buildRoomMemoryCaptureConfig(env = process.env) {
  return {
    kind: 'room_memory_capture_config_v1',
    enabled: boolEnv(env.ROOM_MEMORY_TRIALS_DATA_COLLECTION_ENABLED),
    out_dir: env.ROOM_MEMORY_TRIALS_DATA_DIR || path.join(process.cwd(), 'room_memory_data'),
    event_file: env.ROOM_MEMORY_TRIALS_EVENT_FILE || 'room_events.jsonl',
    include_raw_text: false,
  };
}

export function buildRoomMemoryEvent({
  taskText = '',
  chatId = '',
  roomId = '',
  turnId = '',
  command = '',
  workMode = '',
  roomTurnRoute = null,
  roomEvolution = null,
  skillDiscovery = null,
  outcome = null,
  componentRanking = null,
  roomPackageQuestionPlan = null,
  roomPackageElicitationEvent = null,
  roomConciergeDecision = null,
  source = 'ddalggak_runtime',
  ts = nowIso(),
} = {}) {
  const route = asObject(roomTurnRoute);
  const evolution = asObject(roomEvolution);
  const discovery = asObject(skillDiscovery || evolution.skill_discovery);
  const trialPlan = asObject(evolution.room_memory_trial_plan || discovery.room_memory_schema_trial_plan);
  const aggregate = asObject(evolution.aggregate);
  const counts = asObject(aggregate.counts);
  const task = clean(taskText, { maxLen: 2000 });
  return {
    kind: 'room_memory_event_v1',
    ts,
    source,
    ids: {
      chat_id_hash: stableHash(chatId || roomId || 'room'),
      room_id_hash: stableHash(roomId || chatId || 'room'),
      turn_id: clean(turnId || '', { maxLen: 120 }),
    },
    turn: {
      command: safeId(command),
      work_mode: safeId(workMode || route.depth || ''),
      task_hash: task ? stableHash(task) : '',
      task_length_chars: task.length,
      task_token_estimate: task ? task.split(/\s+/g).filter(Boolean).length : 0,
    },
    routing: stripRawTextFields({
      depth: route.depth || '',
      execution_shape: route.execution_shape || '',
      reason_codes: asArray(route.reason_codes).slice(0, 20),
      memory_policy: route.memory_policy || {},
      tool_policy: route.tool_policy || {},
    }),
    room_evolution: stripRawTextFields({
      maturity: evolution.maturity || '',
      top_object_types: asArray(aggregate.top_objects).slice(0, 12).map((row) => asObject(row).id).filter(Boolean),
      counts: {
        total_events: counts.total_events || 0,
        preference: counts.preference || 0,
        observation_event: counts.observation_event || 0,
        aggregate_query: counts.aggregate_query || 0,
        correction: counts.correction || 0,
        image_input: counts.image_input || 0,
        external_search: counts.external_search || 0,
        gateway_need: counts.gateway_need || 0,
        database_need: counts.database_need || 0,
      },
      proposal_types: asArray(evolution.proposals).map((p) => asObject(p).proposal_type).filter(Boolean).slice(0, 20),
    }),
    room_memory_trials: stripRawTextFields({
      candidate_object_types: asArray(trialPlan.candidate_object_types || trialPlan.candidateObjectTypes).slice(0, 12),
      treatment_ids: asArray(trialPlan.treatments).map((t) => typeof t === 'string' ? t : asObject(t).id).filter(Boolean).slice(0, 12),
      probe_count: asArray(asObject(discovery.probe_suite).probes).length,
      replay_probe_ids: asArray(asObject(discovery.cross_time_replay_plan).probes || asObject(discovery.cross_time_replay_plan).probe_ids).slice(0, 20),
    }),
    ranking: stripRawTextFields(componentRanking || {}),
    room_concierge: stripRawTextFields({
      decision: roomConciergeDecision || {},
    }),
    room_package_elicitation: stripRawTextFields({
      plan: roomPackageQuestionPlan || {},
      answer_event: roomPackageElicitationEvent || {},
    }),
    outcome: stripRawTextFields(outcome || {}),
    privacy: {
      includes_raw_text: false,
      includes_private_memory_content: false,
      includes_uploaded_file_content: false,
      ids_are_hashed: true,
    },
  };
}

export function validateRoomMemoryEvent(event = {}) {
  const row = asObject(event);
  const serialized = JSON.stringify(row);
  const forbiddenKeys = ['raw_text', 'rawText', 'transcript', 'attachment_bytes'];
  for (const key of forbiddenKeys) {
    if (serialized.includes(`"${key}"`)) return { ok: false, reason: `forbidden_key:${key}` };
  }
  if (asObject(row.privacy).includes_raw_text === true) return { ok: false, reason: 'raw_text_marked_present' };
  if (asObject(row.privacy).includes_private_memory_content === true) return { ok: false, reason: 'private_memory_marked_present' };
  return { ok: true };
}

export function appendRoomMemoryEventJsonl(event = {}, { config = buildRoomMemoryCaptureConfig(), enabled = null } = {}) {
  const cfg = asObject(config);
  const shouldWrite = enabled === null ? cfg.enabled === true : enabled === true;
  const validation = validateRoomMemoryEvent(event);
  if (!validation.ok) return { ok: false, wrote: false, reason: validation.reason };
  if (!shouldWrite) return { ok: true, wrote: false, reason: 'disabled' };
  const outDir = path.resolve(cfg.out_dir || path.join(process.cwd(), 'room_memory_data'));
  const file = path.join(outDir, clean(cfg.event_file || 'room_events.jsonl', { maxLen: 180 }) || 'room_events.jsonl');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  return { ok: true, wrote: true, file };
}

export function maybeCaptureRoomMemoryEvent(args = {}, options = {}) {
  const event = buildRoomMemoryEvent(args);
  const result = appendRoomMemoryEventJsonl(event, options);
  return { event, result };
}
