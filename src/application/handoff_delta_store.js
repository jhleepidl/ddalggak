import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendRunContextHandoff } from './run_context_cache.js';
import { appendContextRuntimeMetric, estimateContextTokens } from './context_runtime_metrics.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function nowIso() { return new Date().toISOString(); }
function stableHash(value = '') { return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10); }
function clip(value = '', max = 1200) { const s = String(value || ''); return s.length > max ? `${s.slice(0, max)}…` : s; }
function safeRunDir({ rootDir = process.cwd(), jobId = '', runDir = '' } = {}) {
  if (runDir) return path.resolve(rootDir, runDir);
  return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', clean(jobId) || '_global');
}
function appendJsonl(filePath = '', row = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function extractBulletLines(text = '', patterns = []) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 8)
    .map((line) => line.replace(/^[-*•]\s*/, ''));
}

export function buildHandoffDeltaFromAgentResult({ agentId = '', roleId = '', goal = '', result = {}, preparedContext = null, targetAgent = '' } = {}) {
  const output = clean(result?.output || result?.text || '');
  const lowerRole = clean(roleId || agentId).toLowerCase();
  const findings = extractBulletLines(output, [/finding/i, /risk/i, /blocker/i, /issue/i, /리스크/, /문제/, /차단/]);
  const tests = extractBulletLines(output, [/test/i, /build/i, /lint/i, /typecheck/i, /검증/, /테스트/, /빌드/]);
  const changed = extractBulletLines(output, [/changed/i, /modified/i, /created/i, /updated/i, /files?/i, /수정/, /생성/]);
  const handoffType = lowerRole.includes('review')
    ? 'review_finding'
    : (lowerRole.includes('build') || lowerRole.includes('coder') || lowerRole.includes('codex') ? 'review_request' : 'agent_delta');
  const delta = {
    goal: clip(goal, 500),
    output_summary: clip(output, 900),
    findings,
    verification_notes: tests,
    changed_files_or_artifacts: changed,
    provider: clean(result?.provider || ''),
    model: clean(result?.model || ''),
    projection_id: clean(preparedContext?.context_info?.projection_id || preparedContext?.context_info?.context_projection?.projection_id || ''),
  };
  return {
    kind: 'agent_handoff_delta_v1',
    id: `handoff_${stableHash(`${agentId}:${Date.now()}:${output.slice(0, 200)}`)}`,
    timestamp: nowIso(),
    from_agent: clean(agentId),
    to_agent: clean(targetAgent),
    handoff_type: handoffType,
    snapshot_id: clean(preparedContext?.context_info?.snapshot_id || preparedContext?.context_info?.context_projection?.snapshot_id || ''),
    summary: clip(output, 220),
    delta,
  };
}

export function appendHandoffDelta(handoff = {}, options = {}) {
  const runDir = safeRunDir(options);
  const file = path.join(runDir, 'local_memory', 'handoff_deltas.jsonl');
  const row = { ...handoff, timestamp: handoff.timestamp || nowIso() };
  appendJsonl(file, row);
  appendRunContextHandoff(row, options);
  appendContextRuntimeMetric('handoff', {
    handoff_id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    handoff_type: row.handoff_type,
    snapshot_id: row.snapshot_id,
    delta_tokens: estimateContextTokens(JSON.stringify(row.delta || {})),
  }, options);
  return { ok: true, file, handoff: row };
}
