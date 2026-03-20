import { parseJsonMaybeLoose } from "../shared/json_extract.js";

const DEFAULT_QUALITY_STOP_SIGNALS = [
  'quality_threshold_met',
  'ready_for_user',
  'final_answer_ready',
  'done_enough',
];

const DEFAULT_QUALITY_CONTINUE_SIGNALS = [
  'needs_more_research',
  'needs_more_revision',
  'quality_gap_remaining',
  'evidence_gap_remaining',
  'not_ready_yet',
  'verification_failed',
];

const DEFAULT_QUALITY_SIGNALS = [
  ...DEFAULT_QUALITY_STOP_SIGNALS,
  ...DEFAULT_QUALITY_CONTINUE_SIGNALS,
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeRouteSignal(value = "") {
  return String(value || "").trim().toLowerCase();
}

function uniqueSignals(values = [], { allowedSet = null } = {}) {
  const out = [];
  const seen = new Set();
  const allow = allowedSet instanceof Set ? allowedSet : null;
  for (const value of values) {
    const signal = normalizeRouteSignal(value);
    if (!signal) continue;
    if (allow && allow.size > 0 && !allow.has(signal)) continue;
    if (seen.has(signal)) continue;
    seen.add(signal);
    out.push(signal);
  }
  return out;
}

export function summarizeConditions(entries = []) {
  return asArray(entries)
    .map((entry) => {
      const condition = String(entry?.condition || '').trim();
      const fromSlotId = String(entry?.from_slot_id || '').trim();
      if (!condition) return '';
      return fromSlotId ? `${condition} (from ${fromSlotId})` : condition;
    })
    .filter(Boolean)
    .join(', ');
}

function extractSignalsFromObject(raw, { allowedSet = null } = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const nestedRouting = row.routing && typeof row.routing === 'object' ? row.routing : null;
  return uniqueSignals([
    ...asArray(row.route_signals),
    ...asArray(row.routeSignals),
    ...asArray(row.satisfied_conditions),
    ...asArray(row.satisfiedConditions),
    ...asArray(row.signals),
    ...asArray(row.quality_signals),
    ...asArray(row.qualitySignals),
    ...asArray(row.stop_signals),
    ...asArray(row.stopSignals),
    ...asArray(nestedRouting?.route_signals),
    ...asArray(nestedRouting?.signals),
    ...asArray(nestedRouting?.quality_signals),
  ], { allowedSet });
}

function parseTaggedJsonBlock(raw = '', tag = 'ROUTE_SIGNALS_JSON') {
  const src = String(raw || '');
  const jsonPattern = new RegExp(String(tag || 'ROUTE_SIGNALS_JSON') + String.raw`\s*\`\`\`json\s*([\s\S]*?)\`\`\``, 'i');
  const plainPattern = new RegExp(String(tag || 'ROUTE_SIGNALS_JSON') + String.raw`\s*\`\`\`\s*([\s\S]*?)\`\`\``, 'i');
  const match = src.match(jsonPattern) || src.match(plainPattern);
  return match?.[1] ? parseJsonMaybeLoose(match[1]) : null;
}

function extractQualitySignalsFromObject(raw, { allowedSet = null } = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const decision = normalizeRouteSignal(row?.decision || row?.status || row?.quality_decision || row?.qualityDecision);
  const explicit = uniqueSignals([
    ...asArray(row?.signals),
    ...asArray(row?.route_signals),
    ...asArray(row?.quality_signals),
    ...asArray(row?.stop_signals),
  ], { allowedSet });
  if (explicit.length > 0) return explicit;
  if (decision === 'stop' || decision === 'done' || decision === 'ready') {
    return uniqueSignals(['quality_threshold_met', 'ready_for_user'], { allowedSet });
  }
  if (decision === 'continue' || decision === 'revise' || decision === 'not_ready') {
    return uniqueSignals(['needs_more_revision'], { allowedSet });
  }
  return [];
}

function extractSignalsFromText(text = '', { allowedSet = null } = {}) {
  const raw = String(text || '');
  const parsedTagged = parseTaggedJsonBlock(raw, 'ROUTE_SIGNALS_JSON');
  const taggedSignals = parsedTagged ? extractSignalsFromObject(parsedTagged, { allowedSet }) : [];
  if (taggedSignals.length > 0) return taggedSignals;

  const parsedQuality = parseTaggedJsonBlock(raw, 'QUALITY_DECISION_JSON')
    || parseTaggedJsonBlock(raw, 'QUALITY_STATUS_JSON');
  const qualitySignals = parsedQuality ? extractQualitySignalsFromObject(parsedQuality, { allowedSet }) : [];
  if (qualitySignals.length > 0) return qualitySignals;

  const parsed = parseJsonMaybeLoose(raw);
  const parsedSignals = parsed ? extractSignalsFromObject(parsed, { allowedSet }) : [];
  if (parsedSignals.length > 0) return parsedSignals;
  const parsedQualitySignals = parsed ? extractQualitySignalsFromObject(parsed, { allowedSet }) : [];
  if (parsedQualitySignals.length > 0) return parsedQualitySignals;

  if (!(allowedSet instanceof Set) || allowedSet.size === 0) return [];
  if (allowedSet.size === 1) return [...allowedSet];

  const lowered = raw.toLowerCase();
  return [...allowedSet].filter((signal) => lowered.includes(signal));
}

export function resolveActionRouteSignals({ action = {}, result = null, fallbackSignals = [] } = {}) {
  const outgoingConditions = asArray(action?.inputs?.outgoing_conditions)
    .map((entry) => normalizeRouteSignal(entry?.condition))
    .filter(Boolean);
  const fallback = uniqueSignals(fallbackSignals);
  const allowedSet = new Set([
    ...outgoingConditions,
    ...fallback,
    ...DEFAULT_QUALITY_SIGNALS,
  ]);

  const structuredSignals = extractSignalsFromObject(result, { allowedSet });
  if (structuredSignals.length > 0) return structuredSignals;

  const resultText = [
    String(result?.output || '').trim(),
    String(result?.text || '').trim(),
    String(result?.message || '').trim(),
  ].filter(Boolean).join('\n\n');
  const textSignals = extractSignalsFromText(resultText, { allowedSet });
  if (textSignals.length > 0) return textSignals;

  if (fallback.length > 0) return fallback;
  return outgoingConditions.length === 1 ? outgoingConditions : [];
}

export function collectActiveRouteSignals(outputs = []) {
  const seen = new Set();
  for (const row of asArray(outputs)) {
    const routeSignals = asArray(row?.route_signals)
      .map((entry) => normalizeRouteSignal(entry))
      .filter(Boolean);
    for (const signal of routeSignals) seen.add(signal);
  }
  return seen;
}

export function evaluateIncomingConditions(action = {}, { activeSignals = null } = {}) {
  const incomingConditions = asArray(action?.inputs?.incoming_conditions)
    .map((entry) => ({
      ...entry,
      condition: String(entry?.condition || '').trim(),
      normalized: normalizeRouteSignal(entry?.condition),
    }))
    .filter((entry) => entry.normalized);
  if (incomingConditions.length === 0) {
    return {
      allowed: true,
      matched_conditions: [],
      missing_conditions: [],
      condition_match_mode: 'any',
    };
  }

  const signalSet = activeSignals instanceof Set ? activeSignals : new Set();
  const conditionMatchMode = String(action?.inputs?.condition_match_mode || action?.metadata?.condition_match_mode || 'any')
    .trim()
    .toLowerCase() === 'all'
    ? 'all'
    : 'any';
  const matched = incomingConditions.filter((entry) => signalSet.has(entry.normalized));
  const missing = incomingConditions.filter((entry) => !signalSet.has(entry.normalized));
  const allowed = conditionMatchMode === 'all'
    ? missing.length === 0
    : matched.length > 0;

  return {
    allowed,
    matched_conditions: matched.map((entry) => entry.condition),
    missing_conditions: missing.map((entry) => entry.condition),
    condition_match_mode: conditionMatchMode,
  };
}

export function attachRouteSignals(outputRow = {}, routeSignals = [], { activeSignals = null } = {}) {
  const cleanSignals = uniqueSignals(routeSignals);
  if (activeSignals instanceof Set) {
    for (const signal of cleanSignals) activeSignals.add(signal);
  }
  if (cleanSignals.length === 0) return outputRow;
  return {
    ...(outputRow && typeof outputRow === 'object' ? outputRow : {}),
    route_signals: cleanSignals,
  };
}
