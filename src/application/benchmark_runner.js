import fs from 'node:fs';
import path from 'node:path';

import { scoreTaskAutonomy } from './autonomy_policy.js';
import { computeProjectionStress } from './projection_stress.js';

export function readJsonl(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function writeJsonl(filePath = '', rows = []) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function normalizeText(value = '') {
  return String(value || '').toLowerCase();
}

function includesAny(text = '', needles = []) {
  const src = normalizeText(text);
  return needles.some((needle) => src.includes(normalizeText(needle)));
}

function includesAll(text = '', needles = []) {
  const src = normalizeText(text);
  return needles.every((needle) => src.includes(normalizeText(needle)));
}

export function evaluateTextExpectation(output = '', expected = {}) {
  const mustInclude = Array.isArray(expected.must_include) ? expected.must_include : [];
  const mustNotInclude = Array.isArray(expected.must_not_include) ? expected.must_not_include : [];
  const includeOk = includesAll(output, mustInclude);
  const forbiddenHit = includesAny(output, mustNotInclude);
  return {
    correct_artifact_recall: mustInclude.length ? (includeOk ? 1 : 0) : undefined,
    wrong_label_recurrence: mustNotInclude.length ? (forbiddenHit ? 1 : 0) : undefined,
    retraction_suppression: mustNotInclude.length ? (forbiddenHit ? 0 : 1) : undefined,
    include_ok: includeOk,
    forbidden_hit: forbiddenHit,
  };
}

const modeOrder = ['single', 'single_with_skill', 'hybrid', 'multi'];

export function normalizeMode(mode = '') {
  const m = String(mode || '').trim();
  if (m === 'hybrid_sidecar') return 'hybrid';
  if (m === 'multi_motif') return 'multi';
  return m || 'single';
}

export function modeDistance(actual = '', expected = '') {
  const a = modeOrder.indexOf(normalizeMode(actual));
  const e = modeOrder.indexOf(normalizeMode(expected));
  if (a < 0 || e < 0) return 2;
  return Math.abs(a - e);
}

export function evaluateModeDecision(actual = '', expected = '') {
  const distance = modeDistance(actual, expected);
  const normalizedActual = normalizeMode(actual);
  const normalizedExpected = normalizeMode(expected);
  const actualRank = modeOrder.indexOf(normalizedActual);
  const expectedRank = modeOrder.indexOf(normalizedExpected);
  return {
    mode_accuracy: distance === 0 ? 1 : 0,
    mode_distance: distance,
    under_escalation: actualRank >= 0 && expectedRank >= 0 && actualRank < expectedRank ? 1 : 0,
    over_escalation: actualRank >= 0 && expectedRank >= 0 && actualRank > expectedRank ? 1 : 0,
  };
}

export function aggregateMetrics(rows = []) {
  const sums = {};
  const counts = {};
  for (const row of rows) {
    const metrics = row.metrics || row;
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      sums[key] = (sums[key] || 0) + value;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  const out = {};
  for (const key of Object.keys(sums)) {
    out[key] = Number((sums[key] / Math.max(1, counts[key])).toFixed(4));
  }
  return out;
}

export function runModeSelectionCases(cases = [], { policy = 'current' } = {}) {
  return cases.map((item) => {
    const projectionContext = item.projection_context || item.projectionContext || {};
    const projectionStress = computeProjectionStress(projectionContext);
    const decision = scoreTaskAutonomy({
      userText: item.task || item.user_text || '',
      availableAgents: item.available_agents || 3,
      attachedSkills: item.attached_skills || [],
      traceStats: item.trace_stats || {},
      memoryStats: item.memory_stats || {},
      projectionContext: policy.includes('psi') ? projectionContext : {},
    });
    const metrics = evaluateModeDecision(decision.mode, item.gold_mode || item.expected_mode || 'single');
    return {
      id: item.id,
      policy,
      task_family: item.task_family,
      gold_mode: item.gold_mode || item.expected_mode,
      decision,
      projection_stress: projectionStress,
      metrics,
    };
  });
}
