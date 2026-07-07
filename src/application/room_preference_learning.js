import fs from 'node:fs';
import path from 'node:path';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function safeId(value = '') { return String(value || 'unknown').replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 120) || 'unknown'; }
function rootFor(chatId, { rootDir = process.env.DDALGGAK_ROOM_PREFERENCE_DATASET_DIR || 'runs/room_preference_dataset' } = {}) {
  return path.resolve(process.cwd(), rootDir, safeId(chatId));
}
function countBy(rows, getter) {
  const out = {};
  for (const row of asArray(rows)) {
    const key = cleanText(getter(row), { maxLen: 120 }) || '(none)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

const EXPLICIT_POSITIVE_RE = /(approve|approved|accept|accepted|applied|preset_applied|materialized|promote|sync|exported|delivered|완료|승인|적용|수락)/i;
const EXPLICIT_NEGATIVE_RE = /(reject|rejected|rollback|stop|stopped|correction|correct|retry|failed|blocked|declined|거절|중단|정정|수정|실패|다시|아냐|아니)/i;
const SAFETY_RE = /(risk|safety|verifier|review|approval|required|source|ground|claim|finance|health|legal|보수|검증|승인|근거|출처|위험|안전)/i;
const ARTIFACT_RE = /(artifact|file|bundle|zip|patch|test|build|code|experiment|latex|doc|moc|sync|코드|파일|번들|실험|테스트|문서)/i;
const COST_RE = /(token|cost|latency|cheap|fast|budget|loop|agent|model|토큰|비용|지연|빠르게)/i;

function summarizePackage(roomPackage = {}, room = {}) {
  const pkg = asObject(roomPackage);
  const r = asObject(room);
  return {
    package_id: cleanText(pkg.package_id || r.package_id || r.domain_label || '', { maxLen: 160 }),
    domain_label: cleanText(pkg.domain_label || r.domain_label || '', { maxLen: 160 }),
    default_depth: cleanText(pkg.default_depth || r.default_depth || '', { maxLen: 80 }),
    agents: asArray(pkg.agents || r.default_agents).slice(0, 24),
    skills: asArray(pkg.skills).slice(0, 24),
    memory_object_types: asArray(pkg.memory_hierarchy?.object_types || r.memory_object_types).slice(0, 24),
  };
}

export function classifyRoomPreferenceSignal(event = {}) {
  const row = asObject(event);
  const extra = asObject(row.extra);
  const hay = cleanText([
    row.event_type,
    row.command,
    row.goal,
    extra.user_feedback,
    extra.reason,
    extra.status,
    JSON.stringify(extra),
    JSON.stringify(row.signal_pack || {}),
  ].join(' '), { lower: true, maxLen: 4000 });
  const explicitPositive = EXPLICIT_POSITIVE_RE.test(hay);
  const explicitNegative = EXPLICIT_NEGATIVE_RE.test(hay);
  const hasSafety = SAFETY_RE.test(hay);
  const hasArtifact = ARTIFACT_RE.test(hay);
  const hasCost = COST_RE.test(hay);
  let label = 'unlabeled_observation';
  let polarity = 0;
  let confidence = 0.2;
  let source = 'implicit_runtime_observation';
  if (explicitPositive && !explicitNegative) {
    label = 'positive_preference';
    polarity = 1;
    confidence = 0.95;
    source = 'explicit_or_strong_positive_event';
  } else if (explicitNegative && !explicitPositive) {
    label = 'negative_preference';
    polarity = -1;
    confidence = 0.9;
    source = 'explicit_or_strong_negative_event';
  } else if (explicitPositive && explicitNegative) {
    label = 'mixed_preference';
    polarity = 0;
    confidence = 0.55;
    source = 'mixed_runtime_event';
  } else if (hasArtifact || hasSafety || hasCost) {
    label = 'weak_preference_feature';
    polarity = 0;
    confidence = 0.35;
    source = 'weak_implicit_signal';
  }
  return {
    label,
    polarity,
    confidence,
    source,
    facets: {
      task_success: explicitPositive && /done|success|pass|completed|완료|통과|delivered|delivered/i.test(hay),
      user_approval: /approve|approved|accept|accepted|승인|수락/i.test(hay),
      user_rejection: /reject|rejected|declined|거절/i.test(hay),
      correction: /correction|correct|정정|수정|아냐|아니/i.test(hay),
      stop_or_rollback: /stop|stopped|rollback|중단|롤백/i.test(hay),
      artifact_relevant: hasArtifact,
      safety_or_grounding: hasSafety,
      cost_or_latency: hasCost,
    },
  };
}

export function computeRoomRewardFeatures(events = []) {
  const rows = asArray(events);
  const signals = rows.map(classifyRoomPreferenceSignal);
  const count = rows.length || 1;
  const positives = signals.filter((s) => s.polarity > 0).length;
  const negatives = signals.filter((s) => s.polarity < 0).length;
  const corrections = signals.filter((s) => s.facets.correction).length;
  const stops = signals.filter((s) => s.facets.stop_or_rollback).length;
  const approvals = signals.filter((s) => s.facets.user_approval).length;
  const rejections = signals.filter((s) => s.facets.user_rejection).length;
  const artifactEvents = signals.filter((s) => s.facets.artifact_relevant).length;
  const safetyEvents = signals.filter((s) => s.facets.safety_or_grounding).length;
  const costEvents = signals.filter((s) => s.facets.cost_or_latency).length;
  const weightedPreference = signals.reduce((acc, s) => acc + (s.polarity * s.confidence), 0);
  return {
    event_count: rows.length,
    positive_preference_events: positives,
    negative_preference_events: negatives,
    approvals,
    rejections,
    corrections,
    stop_or_rollback: stops,
    artifact_relevant_events: artifactEvents,
    safety_or_grounding_events: safetyEvents,
    cost_or_latency_events: costEvents,
    weighted_preference_score: Number(weightedPreference.toFixed(3)),
    correction_rate: Number((corrections / count).toFixed(3)),
    stop_rate: Number((stops / count).toFixed(3)),
    approval_rate: Number((approvals / count).toFixed(3)),
    guardrail: 'reward is room-local and decision-support only; it must not directly mutate room state',
  };
}

function eventToPreferenceRow({ event = {}, roomPackage = {}, profile = null, history = [] } = {}) {
  const row = asObject(event);
  const signal = classifyRoomPreferenceSignal(row);
  const reward = computeRoomRewardFeatures([...asArray(history), row]);
  const target = inferLearningTarget(row);
  return {
    schema_version: 'ddalggak.room_preference_event/v1',
    id: `${safeId(row.chat_id || 'chat')}:${safeId(row.ts || row.created_at || Date.now())}:${safeId(row.event_type || 'event')}`,
    created_at: new Date().toISOString(),
    learning_target: target,
    input: {
      room_intent: cleanText(row.goal || row.signal_pack?.summary || '', { maxLen: 1000 }),
      command: cleanText(row.command || '', { maxLen: 120 }),
      event_type: cleanText(row.event_type || row.type || '', { maxLen: 120 }),
      current_package: summarizePackage(roomPackage, row.room || profile || {}),
      room_snapshot: row.room || profile || null,
      candidate_change: inferCandidateChange(row),
    },
    label: {
      preference_label: signal.label,
      polarity: signal.polarity,
      confidence: signal.confidence,
      source: signal.source,
      facets: signal.facets,
    },
    reward_features: reward,
    training_use: {
      room_package_scorer: ['room_package', 'room_recipe', 'room_setting'].includes(target),
      recipe_router: ['work_depth', 'loop_policy', 'room_recipe'].includes(target),
      memory_skill_selector: ['memory_policy', 'skill_policy', 'room_recipe'].includes(target),
      agent_model_policy_scorer: ['agent_policy', 'model_policy', 'room_recipe'].includes(target),
      dpo_or_preference_finetune_ready: signal.polarity !== 0 && signal.confidence >= 0.8,
    },
    witness: {
      source_event_ts: row.ts || row.created_at || '',
      source_event_type: row.event_type || row.type || '',
      source_chat_id: row.chat_id || '',
      raw_transcript_exported: false,
      provenance: 'room_usage_event',
    },
    guardrail: {
      use_as_decision_support: true,
      model_may_suggest: true,
      model_may_mutate_room_state: false,
      durable_change_requires: 'trial_then_user_or_goc_approval',
      private_memory_export: 'never_by_default',
    },
  };
}

export function inferLearningTarget(event = {}) {
  const row = asObject(event);
  const hay = cleanText([row.event_type, row.command, row.goal, JSON.stringify(row.extra || {})].join(' '), { lower: true, maxLen: 3000 });
  if (/agent|roster|activation|specialization|companion/.test(hay)) return 'agent_policy';
  if (/model|provider|multi_model|concierge|codex|gemini|gpt/.test(hay)) return 'model_policy';
  if (/memory|remember|correction|correct|schema/.test(hay)) return 'memory_policy';
  if (/skill|protocol|docs|moc|action/.test(hay)) return 'skill_policy';
  if (/loop|team|depth|topology|workflow|recipe/.test(hay)) return 'room_recipe';
  if (/preset|package|room apply|room_applied|composition|alternatives/.test(hay)) return 'room_package';
  return 'room_setting';
}

export function inferCandidateChange(event = {}) {
  const row = asObject(event);
  const extra = asObject(row.extra);
  const et = cleanText(row.event_type || '', { lower: true, maxLen: 120 });
  if (extra.package_id) return { type: 'package_choice', package_id: extra.package_id };
  if (extra.base_package) return { type: 'package_composition', base_package: extra.base_package, borrowed_count: extra.borrowed_count || 0 };
  if (extra.action_count && /agent/.test(et)) return { type: 'agent_roster_change', action_count: extra.action_count, status: extra.status || '' };
  if (extra.row_count && /topology/.test(et)) return { type: 'training_export', row_count: extra.row_count };
  if (/approve/.test(et)) return { type: 'approval', target: et.replace(/_approved.*/, '') };
  if (/reject/.test(et)) return { type: 'rejection', target: et.replace(/_rejected.*/, '') };
  if (/stop/.test(et)) return { type: 'stop_or_interruption' };
  if (/correction|correct/.test(et)) return { type: 'correction' };
  return { type: 'observation', event_type: row.event_type || '' };
}

export function buildRoomPreferenceDataset({ events = [], profile = null, roomPackage = null, limit = 500 } = {}) {
  const rows = asArray(events).slice(-Math.max(1, Math.min(Number(limit) || 500, 5000)));
  const prefRows = rows.map((event, idx) => eventToPreferenceRow({ event, profile, roomPackage, history: rows.slice(0, idx) }));
  const reward = computeRoomRewardFeatures(rows);
  return {
    schema_version: 'ddalggak.room_preference_dataset/v1',
    generated_at: new Date().toISOString(),
    row_count: prefRows.length,
    summary: {
      by_learning_target: countBy(prefRows, (row) => row.learning_target),
      by_preference_label: countBy(prefRows, (row) => row.label?.preference_label),
      by_event_type: countBy(rows, (row) => row.event_type || row.type),
      dpo_ready_rows: prefRows.filter((row) => row.training_use?.dpo_or_preference_finetune_ready).length,
      reward_features: reward,
    },
    rows: prefRows,
    policy: {
      name: 'Room Preference Learning',
      purpose: 'learn room-level package/recipe/memory/skill/agent/model-policy scorers from user-governed choices',
      not_rlhf_first: true,
      base_model_finetune: 'defer_until_dataset_quality_is_sufficient',
      recommended_order: ['event_normalization', 'offline_scorer', 'shadow_trial', 'proposal_generation', 'human_or_goc_approval', 'optional_dpo_or_small_router_training'],
    },
  };
}

export function exportRoomPreferenceDataset({ chatId = 'unknown', events = [], profile = null, roomPackage = null, rootDir = process.env.DDALGGAK_ROOM_PREFERENCE_DATASET_DIR || 'runs/room_preference_dataset', format = 'jsonl', limit = 1000 } = {}) {
  const dataset = buildRoomPreferenceDataset({ events, profile, roomPackage, limit });
  const dir = rootFor(chatId, { rootDir });
  fs.mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(dir, 'room_preference_dataset.json');
  const jsonlFile = path.join(dir, 'room_preference_dataset.jsonl');
  fs.writeFileSync(jsonFile, JSON.stringify(dataset, null, 2), 'utf8');
  fs.writeFileSync(jsonlFile, dataset.rows.map((row) => JSON.stringify(row)).join('\n') + (dataset.rows.length ? '\n' : ''), 'utf8');
  return {
    ok: true,
    root: dir,
    dataset,
    files: {
      json: jsonFile,
      jsonl: jsonlFile,
      selected: format === 'json' ? jsonFile : jsonlFile,
    },
  };
}

export function formatRoomPreferenceLearningSummaryForTelegram(dataset = {}) {
  const ds = asObject(dataset);
  const summary = asObject(ds.summary);
  const reward = asObject(summary.reward_features);
  const lines = [
    '🎛️ Room preference learning',
    '',
    '목표: base model을 바로 fine-tune하는 것이 아니라, 사용자 선택으로 room package / recipe / memory / skill / agent / model-policy scorer를 개선합니다.',
    '',
    `rows: ${Number(ds.row_count || 0)}`,
    `dpo-ready strong preference rows: ${Number(summary.dpo_ready_rows || 0)}`,
    '',
    'Preference labels:',
    ...Object.entries(asObject(summary.by_preference_label)).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Learning targets:',
    ...Object.entries(asObject(summary.by_learning_target)).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Reward features:',
    `- weighted preference score: ${reward.weighted_preference_score ?? 0}`,
    `- approvals: ${reward.approvals ?? 0}`,
    `- rejections: ${reward.rejections ?? 0}`,
    `- corrections: ${reward.corrections ?? 0}`,
    `- stop/rollback: ${reward.stop_or_rollback ?? 0}`,
    `- artifact-relevant: ${reward.artifact_relevant_events ?? 0}`,
    '',
    'Policy:',
    '- 학습 모델은 room state를 직접 바꾸지 않습니다.',
    '- scorer/router는 proposal 또는 trial을 만들고, durable 변경은 user/GoC approval을 요구합니다.',
    '- private memory/raw transcript는 export하지 않습니다.',
    '',
    'Export: /room learning export',
  ];
  return lines.join('\n');
}

export function formatRoomPreferenceDatasetExportForTelegram(result = {}) {
  const dataset = asObject(result.dataset);
  const summary = asObject(dataset.summary);
  const reward = asObject(summary.reward_features);
  return [
    '🧪 Room preference dataset exported',
    '',
    `rows: ${Number(dataset.row_count || 0)}`,
    result.root ? `root: ${result.root}` : '',
    result.files?.jsonl ? `jsonl: ${result.files.jsonl}` : '',
    result.files?.json ? `json: ${result.files.json}` : '',
    '',
    'Learning targets:',
    ...Object.entries(asObject(summary.by_learning_target)).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Strong preference rows:',
    `- dpo_ready_rows: ${Number(summary.dpo_ready_rows || 0)}`,
    `- weighted_preference_score: ${reward.weighted_preference_score ?? 0}`,
    '',
    'Use:',
    '- offline room package scorer / recipe router training',
    '- contextual-bandit style trial policy analysis',
    '- optional DPO-style generator training after enough high-quality pair data',
    '',
    'Guardrail:',
    '- trained models may recommend, score, or propose changes',
    '- trained models must not directly mutate durable room state',
    '- user/GoC approval remains required for durable evolution',
  ].filter(Boolean).join('\n');
}
