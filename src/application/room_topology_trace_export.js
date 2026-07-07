import fs from 'node:fs';
import path from 'node:path';
import { buildDefaultAgentActivationPolicy } from './room_agent_policy.js';
import { buildRoomTopologyLearningCard } from './room_topology_learning.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 1000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function safeId(value = '') { return String(value || 'unknown').replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 120) || 'unknown'; }
function rootFor(chatId, { rootDir = process.env.DDALGGAK_TOPOLOGY_DATASET_DIR || 'runs/room_topology_dataset' } = {}) {
  return path.resolve(process.cwd(), rootDir, safeId(chatId));
}
function countBy(rows, getter) {
  const out = {};
  for (const row of rows) {
    const key = cleanText(getter(row), { maxLen: 120 }) || '(none)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function summarizeAgentActivationPolicy(roomPackage = {}, profile = {}) {
  const policy = buildDefaultAgentActivationPolicy(roomPackage, { profile });
  return policy.roster.slice(0, 24).map((row) => `${row.agent}:${row.state}:${row.model_role_hint || '-'}`).join(', ');
}

function summarizeModelPolicy(roomPackage = {}, profile = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const policy = asObject(pkg.model_policy || prof.model_policy || {});
  const assignments = asArray(policy.default_assignment).map((item) => asObject(item).role || '').filter(Boolean);
  if (assignments.length) return assignments.slice(0, 12).join(', ');
  return 'room_scoped_model_portfolio:concierge_router,delivery_synthesizer,idle_structurer';
}

function inferOutcomeSignals(event = {}) {
  const row = asObject(event);
  const hay = cleanText([row.event_type, row.command, row.goal, JSON.stringify(row.extra || {})].join(' '), { maxLen: 2000 }).toLowerCase();
  return {
    task_completion_signal: /artifact|완료|done|final|delivery|delivered|success|pass|passed/.test(hay) ? 'positive' : 'unknown',
    user_intervention_signal: /stop|중단|reject|correction|correct|retry|다시|아냐|아니/.test(hay) ? 'intervention' : 'none_observed',
    safety_signal: /review|required|approval|blocked|source|ground|verify|검증|승인/.test(hay) ? 'review_or_grounding_needed' : 'none_observed',
    artifact_signal: /artifact|file|bundle|zip|patch|test|build|코드|파일|번들/.test(hay) ? 'artifact_relevant' : 'none',
  };
}
function eventToTrainingRow({ event = {}, profile = null, roomPackage = null, history = [] } = {}) {
  const row = asObject(event);
  const card = buildRoomTopologyLearningCard({ roomPackage, profile: profile || row.room || null, events: history });
  const candidate = asArray(card.candidates).find((item) => item.id === card.primary_topology) || asArray(card.candidates)[0] || {};
  const outcome = inferOutcomeSignals(row);
  const signalPack = asObject(row.signal_pack);
  return {
    schema_version: 'ddalggak.room_topology_training/v1',
    id: `${cleanText(row.chat_id || 'chat', { maxLen: 80 })}:${cleanText(row.ts || row.created_at || Date.now(), { maxLen: 80 })}:${cleanText(row.event_type || 'event', { maxLen: 60 })}`,
    created_at: new Date().toISOString(),
    input: {
      special_tokens: {
        ROOM_INTENT: cleanText(row.goal || signalPack.summary || '', { maxLen: 1000 }),
        PACKAGE: cleanText(asObject(roomPackage).package_id || row.room?.package_id || row.room?.domain_label || '', { maxLen: 160 }),
        MEMORY_GRAPH: asArray(row.room?.memory_object_types || []).join(', '),
        SKILL_SET: asArray(asObject(roomPackage).skills || []).slice(0, 24).join(', '),
        MODEL_POLICY: summarizeModelPolicy(roomPackage, profile || row.room || {}),
        AGENT_ACTIVATION_POLICY: summarizeAgentActivationPolicy(roomPackage, profile || row.room || {}),
        TOPOLOGY: card.primary_topology,
        WITNESS: 'projection_trace:event_payload+room_profile+topology_card',
        OUTCOME: Object.entries(outcome).map(([k, v]) => `${k}=${v}`).join('; '),
        HUMAN_FEEDBACK: cleanText(asObject(row.extra).user_feedback || row.command || '', { maxLen: 300 }),
      },
      room: row.room || null,
      command: row.command || '',
      event_type: row.event_type || row.type || '',
      signal_pack: signalPack,
    },
    labels: {
      topology_choice: card.primary_topology,
      topology_score: Number(candidate.score || 0),
      skill_bundle_choice: asArray(asObject(roomPackage).skills || []).slice(0, 24),
      memory_projection_quality: 'unlabeled_shadow',
      model_role_assignment: summarizeModelPolicy(roomPackage, profile || row.room || {}),
      agent_activation_policy: summarizeAgentActivationPolicy(roomPackage, profile || row.room || {}),
      safe_commit_policy: outcome.safety_signal === 'review_or_grounding_needed' ? 'review_or_grounded' : 'auto_low_risk_or_append',
      user_acceptance: outcome.user_intervention_signal === 'intervention' ? 'negative_or_needs_review' : 'unlabeled',
    },
    witness: {
      source_event_ts: row.ts || row.created_at || '',
      source_event_type: row.event_type || row.type || '',
      source_chat_id: row.chat_id || '',
      projection_trace_available: true,
      runtime_witness_available: false,
      raw_transcript_exported: false,
    },
    outcome,
    guardrail: {
      router_may_suggest: true,
      router_may_mutate_room_state: false,
      durable_change_requires: 'trial_then_user_or_goc_approval',
    },
  };
}
export function buildRoomTopologyTrainingDataset({ events = [], profile = null, roomPackage = null, limit = 200 } = {}) {
  const rows = asArray(events).slice(-Math.max(1, Math.min(Number(limit) || 200, 2000)));
  const trainingRows = rows.map((event, idx) => eventToTrainingRow({ event, profile, roomPackage, history: rows.slice(0, idx + 1) }));
  return {
    schema_version: 'ddalggak.room_topology_dataset/v1',
    generated_at: new Date().toISOString(),
    row_count: trainingRows.length,
    summary: {
      by_topology: countBy(trainingRows, (row) => row.labels?.topology_choice),
      by_event_type: countBy(rows, (row) => row.event_type || row.type),
      interventions: trainingRows.filter((row) => row.outcome?.user_intervention_signal === 'intervention').length,
      artifact_relevant: trainingRows.filter((row) => row.outcome?.artifact_signal === 'artifact_relevant').length,
    },
    rows: trainingRows,
  };
}
export function exportRoomTopologyTrainingDataset({ chatId = 'unknown', events = [], profile = null, roomPackage = null, rootDir = process.env.DDALGGAK_TOPOLOGY_DATASET_DIR || 'runs/room_topology_dataset', format = 'jsonl', limit = 500 } = {}) {
  const dataset = buildRoomTopologyTrainingDataset({ events, profile, roomPackage, limit });
  const dir = rootFor(chatId, { rootDir });
  fs.mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(dir, 'topology_training_dataset.json');
  const jsonlFile = path.join(dir, 'topology_training_dataset.jsonl');
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
export function formatRoomTopologyDatasetExportForTelegram(result = {}) {
  const dataset = asObject(result.dataset);
  const summary = asObject(dataset.summary);
  return [
    '🧪 Room topology training dataset exported',
    '',
    `rows: ${Number(dataset.row_count || 0)}`,
    result.root ? `root: ${result.root}` : '',
    result.files?.jsonl ? `jsonl: ${result.files.jsonl}` : '',
    result.files?.json ? `json: ${result.files.json}` : '',
    '',
    'Topology labels:',
    ...Object.entries(asObject(summary.by_topology)).map(([k, v]) => `- ${k}: ${v}`),
    '',
    'Outcome signals:',
    `- interventions: ${Number(summary.interventions || 0)}`,
    `- artifact_relevant: ${Number(summary.artifact_relevant || 0)}`,
    '',
    'Policy:',
    '- dataset is for router/evaluator training or replay only',
    '- a trained router must not directly mutate room state',
    '- durable topology/package changes still require trial + user/GoC approval',
  ].join('\n');
}
