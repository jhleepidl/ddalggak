function clean(value = '') {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasAny(text = '', patterns = []) {
  const lower = clean(text).toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

const FAST_OPS = new Set([
  'append_event',
  'record_activity',
  'record_usage',
  'record_skill_activation',
  'record_rule_activation',
  'record_skill_outcome',
  'record_rule_outcome',
  'invalidate_materialization',
]);

const SLOW_OPS = new Set([
  'publish_package',
  'canonical_memory_switch',
  'activate_learned_rule',
  'enable_write_operation',
  'delete_atom',
  'destructive_write',
]);

export function classifyContextCommitLane(intent = {}) {
  const row = asObject(intent);
  const op = clean(row.intent_type || row.op || row.operation || 'assert_atom').toLowerCase();
  const risk = clean(row.risk || row.risk_level || row.policy?.risk).toLowerCase();
  const atomType = clean(row.payload?.atom_type || row.atom_type).toLowerCase();
  const text = `${row.payload?.text_original || ''} ${row.payload?.canonical_text_en || ''} ${row.payload?.title || ''}`;
  const requested = clean(row.requested_commit_mode || row.commit_mode || row.policy?.commit_mode).toLowerCase();

  if (requested === 'review_required' || requested === 'proposal') {
    return {
      lane: 'slow',
      commit_mode: 'review_required',
      reasons: ['requested_review'],
    };
  }

  const slowReasons = [];
  if (SLOW_OPS.has(op)) slowReasons.push(`slow_op:${op}`);
  if (['high', 'critical'].includes(risk)) slowReasons.push(`risk:${risk}`);
  if (['learned_rule', 'skill_candidate', 'agent_package', 'external_claim', 'financial_claim', 'legal_claim', 'medical_claim'].includes(atomType)) slowReasons.push(`atom_type:${atomType}`);
  if (hasAny(text, ['financial recommendation', 'investment advice', 'medical advice', 'legal advice', 'credential', 'api key', 'deployment'])) slowReasons.push('sensitive_text');
  if (slowReasons.length) {
    return {
      lane: 'slow',
      commit_mode: 'review_required',
      reasons: slowReasons,
    };
  }

  if (FAST_OPS.has(op) || atomType === 'event' || atomType === 'usage_event') {
    return {
      lane: 'fast',
      commit_mode: 'auto',
      reasons: [`fast_op:${op}`],
    };
  }

  return {
    lane: 'normal',
    commit_mode: 'auto',
    reasons: ['normal_low_risk'],
  };
}

export function formatContextCommitLane(result = {}) {
  return [
    `lane=${result.lane || 'normal'}`,
    `commit_mode=${result.commit_mode || 'auto'}`,
    `reasons=${(result.reasons || []).join(',') || 'none'}`,
  ].join(' · ');
}
