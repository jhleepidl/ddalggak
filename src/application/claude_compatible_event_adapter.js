import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseProjectManifest, buildRoomPackageFromProjectManifest } from './static_project_manifest.js';

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

function slug(value = '', fallback = 'unknown') {
  const text = clean(value || fallback, { lower: true, maxLen: 160 })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback;
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
}

function boolish(value) {
  return /^(1|true|yes|on|accepted|accept|approved|approve)$/i.test(String(value || '').trim());
}

const RAW_FORBIDDEN_KEYS = new Set([
  'content', 'text', 'body', 'message', 'prompt', 'response', 'answer', 'transcript', 'raw', 'raw_text', 'raw_prompt', 'raw_response', 'file_content', 'diff', 'patch', 'secret', 'token', 'api_key', 'authorization', 'password',
]);

export function stripClaudeCompatibleRawFields(value) {
  if (Array.isArray(value)) return value.map(stripClaudeCompatibleRawFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = String(key || '').toLowerCase();
    if (RAW_FORBIDDEN_KEYS.has(lower)) continue;
    if (lower.includes('secret') || lower.includes('token') || lower.includes('password') || lower.includes('authorization')) continue;
    out[key] = stripClaudeCompatibleRawFields(raw);
  }
  return out;
}

function inferEventType({ eventType = '', action = '', toolName = '', outcome = null } = {}) {
  const raw = clean(eventType || action || '', { lower: true, maxLen: 160 });
  const tool = clean(toolName || '', { lower: true, maxLen: 120 });
  const out = clean(asObject(outcome).signal || '', { lower: true, maxLen: 80 });
  if (/subagent|agent/.test(raw) || tool.includes('subagent')) return 'subagent_used';
  if (/skill/.test(raw) || tool.includes('skill')) return 'skill_used';
  if (/correction|reject|revise|retry|수정|거절/.test(raw) || /reject|retry|correction/.test(out)) return 'user_correction_or_rejection';
  if (/accept|approve|apply|done|complete|승인|적용|완료/.test(raw) || /accepted|approved|success/.test(out)) return 'user_acceptance_or_success';
  if (/hook/.test(raw)) return 'hook_event';
  if (/manifest|claude\.md|agents\.md|skill\.md/.test(raw)) return 'project_manifest_used';
  if (/tool|call/.test(raw) || tool) return 'tool_used';
  return 'claude_compatible_usage';
}

function inferTaskArchetype(value = '', extra = {}) {
  const text = `${value}\n${JSON.stringify(stripClaudeCompatibleRawFields(extra))}`.toLowerCase();
  if (/code|repo|test|build|lint|bug|patch|implementation|frontend|backend|코드|버그|패치|테스트/.test(text)) return 'code_review_or_implementation';
  if (/research|paper|experiment|dataset|evaluation|논문|실험|평가/.test(text)) return 'research_or_evaluation';
  if (/strategy|competitor|customer|product|market|roadmap|전략|경쟁사|시장/.test(text)) return 'enterprise_strategy';
  return 'general_project_work';
}

function inferRoutingDepth(value = '', extra = {}) {
  const text = `${value}\n${JSON.stringify(stripClaudeCompatibleRawFields(extra))}`.toLowerCase();
  if (/loop|multi-step|long-running|background|autonomous|반복|장기/.test(text)) return 'team_loop_task';
  if (/review|compare|analyze|tool|subagent|skill|검토|분석|비교/.test(text)) return 'team_task';
  return 'ask';
}

export function buildClaudeCompatibleRoomEvent({
  source = 'claude_code',
  projectRoot = '',
  projectId = '',
  roomId = '',
  userId = '',
  sessionId = '',
  eventType = '',
  action = '',
  toolName = '',
  manifestType = '',
  manifestFilename = '',
  subagentName = '',
  skillName = '',
  taskArchetype = '',
  routingDepth = '',
  outcome = null,
  metadata = null,
  ts = new Date().toISOString(),
} = {}) {
  const meta = stripClaudeCompatibleRawFields(asObject(metadata));
  const out = stripClaudeCompatibleRawFields(asObject(outcome));
  const sourceId = slug(source, 'claude_code');
  const archetype = clean(taskArchetype, { maxLen: 120 }) || inferTaskArchetype(action || eventType || toolName, meta);
  const depth = clean(routingDepth, { maxLen: 80 }) || inferRoutingDepth(action || eventType || toolName, meta);
  const type = inferEventType({ eventType, action, toolName, outcome: out });
  return {
    kind: 'claude_compatible_room_event_v1',
    ts,
    source: sourceId,
    ids: {
      project_root_hash: stableHash(projectRoot || projectId || roomId || 'project'),
      project_id_hash: stableHash(projectId || projectRoot || roomId || 'project'),
      room_id_hash: stableHash(roomId || projectId || projectRoot || 'room'),
      user_id_hash: stableHash(userId || 'user'),
      session_id_hash: stableHash(sessionId || 'session'),
    },
    event_type: type,
    task_archetype: archetype,
    routing: {
      depth,
      execution_shape: depth === 'ask' ? 'single_agent' : (depth === 'team_task' ? 'bounded_team' : 'bounded_loop_team'),
    },
    claude_artifact: {
      manifest_type: slug(manifestType || '', ''),
      manifest_filename: clean(manifestFilename || '', { maxLen: 160 }),
      tool_name: clean(toolName || '', { maxLen: 120 }),
      subagent_name: clean(subagentName || '', { maxLen: 120 }),
      skill_name: clean(skillName || '', { maxLen: 120 }),
    },
    outcome: {
      signal: clean(out.signal || out.status || '', { maxLen: 120 }),
      accepted: out.accepted === true || boolish(out.signal || out.status || ''),
      user_corrected: out.user_corrected === true || /correction|reject|retry/.test(clean(out.signal || out.status || '', { lower: true })),
    },
    metadata: meta,
    privacy: {
      raw_text_included: false,
      raw_project_files_included: false,
      credentials_included: false,
      ids_are_hashed: true,
      suitable_for_goc_room_usage_collection: true,
    },
  };
}

export function claudeEventToRoomUsageEvent(event = {}) {
  const row = asObject(event);
  const artifact = asObject(row.claude_artifact);
  return {
    kind: 'room_usage_event_v1',
    ts: row.ts || new Date().toISOString(),
    chat_id: row.ids?.room_id_hash || '',
    user_id: row.ids?.user_id_hash || '',
    event_type: row.event_type || 'claude_compatible_usage',
    command: row.source || 'claude_compatible_surface',
    goal: '',
    room: {
      name: 'Claude-compatible Room',
      domain_label: row.task_archetype || 'general_project_work',
      default_depth: row.routing?.depth || 'ask',
      default_agents: [artifact.subagent_name, artifact.skill_name].filter(Boolean),
      memory_object_types: ['static_manifest_usage', 'component_usage', 'outcome_signal'],
      package_id: artifact.manifest_type ? `claude_${artifact.manifest_type}` : 'claude_compatible_room',
    },
    recommendation: {
      recommended: row.routing?.depth || 'ask',
      action: row.outcome?.accepted ? 'consider_promote_component' : (row.outcome?.user_corrected ? 'review_component_or_schema' : 'collect_more_usage'),
    },
    signal_pack: {
      task_archetype: row.task_archetype || 'general_project_work',
      claude_compatible_source: row.source || 'claude_code',
      artifact_type: artifact.manifest_type || artifact.tool_name || '',
      accepted: row.outcome?.accepted === true,
      user_corrected: row.outcome?.user_corrected === true,
      raw_text_included: false,
    },
    evolution: {
      formation_mode: 'imported_from_claude_compatible_usage_signal',
      ai_role: 'adapter_collector_not_authoritative_memory',
      auto_apply: false,
      schema_is_dynamic: true,
      private_content_export: 'never_by_default',
    },
    extra: {
      claude_compatible_event: row,
    },
  };
}

export function discoverClaudeCompatibleArtifacts(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  const artifacts = [];
  const manifestNames = ['CLAUDE.md', 'AGENTS.md', 'SKILL.md', 'ROOM.md', 'PROJECT.md'];
  for (const name of manifestNames) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      artifacts.push({ kind: 'project_manifest', filename: name, path: file, relative_path: name });
    }
  }
  const claudeAgentsDir = path.join(root, '.claude', 'agents');
  if (fs.existsSync(claudeAgentsDir)) {
    for (const name of fs.readdirSync(claudeAgentsDir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const file = path.join(claudeAgentsDir, name);
      if (fs.statSync(file).isFile()) artifacts.push({ kind: 'claude_subagent', filename: name, path: file, relative_path: path.join('.claude', 'agents', name) });
    }
  }
  const settingsFile = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(settingsFile) && fs.statSync(settingsFile).isFile()) {
    artifacts.push({ kind: 'claude_settings', filename: 'settings.json', path: settingsFile, relative_path: path.join('.claude', 'settings.json') });
  }
  return artifacts;
}

export function buildClaudeCompatibleImportPreview({ projectRoot = process.cwd(), maxManifestBytes = 128_000 } = {}) {
  const artifacts = discoverClaudeCompatibleArtifacts(projectRoot);
  const manifests = [];
  const roomPackageCandidates = [];
  for (const artifact of artifacts) {
    if (!['project_manifest', 'claude_subagent'].includes(artifact.kind)) continue;
    const raw = fs.readFileSync(artifact.path, 'utf8').slice(0, maxManifestBytes);
    const manifest = parseProjectManifest({ filename: artifact.relative_path, content: raw, source: `claude_compatible_${artifact.kind}` });
    manifests.push({ artifact: stripClaudeCompatibleRawFields({ ...artifact, path: undefined }), manifest });
    roomPackageCandidates.push(buildRoomPackageFromProjectManifest(manifest));
  }
  return {
    kind: 'claude_compatible_import_preview_v1',
    project_root_hash: stableHash(projectRoot),
    artifact_count: artifacts.length,
    artifacts: artifacts.map((a) => stripClaudeCompatibleRawFields({ ...a, path: undefined })),
    manifests,
    room_package_candidates: roomPackageCandidates,
    collection_policy: {
      reads_project_guidance_files_for_preview: true,
      stores_raw_files_by_default: false,
      persistent_install_requires_user_approval: true,
    },
  };
}

export function validateClaudeCompatibleRoomEvent(event = {}) {
  const encoded = JSON.stringify(event || {});
  for (const key of RAW_FORBIDDEN_KEYS) {
    if (encoded.includes(`"${key}"`)) return { ok: false, reason: `forbidden_key:${key}` };
  }
  const privacy = asObject(event.privacy);
  if (privacy.raw_text_included === true || privacy.credentials_included === true || privacy.raw_project_files_included === true) {
    return { ok: false, reason: 'privacy_boundary_violation' };
  }
  return { ok: true };
}
