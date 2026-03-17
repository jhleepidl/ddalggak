const VALID_SCOPE_GRANT_IDS = [
  'shared_summary',
  'global_memory',
  'conversation_tail',
  'upstream_results',
  'upstream_summaries',
  'user_pinned_nodes',
  'explicit_uploaded_files',
];

const RESOURCE_LABELS = {
  shared_summary: 'Shared summary',
  global_memory: 'Global memory',
  conversation_tail: 'Conversation tail',
  upstream_results: 'Upstream results',
  upstream_summaries: 'Upstream summaries',
  user_pinned_nodes: 'User pinned nodes',
  explicit_uploaded_files: 'Explicit uploaded files',
};

function asObject(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeBoolean(raw, fallback = false) {
  if (raw === true) return true;
  if (raw === false) return false;
  const text = normalizeText(raw, { lower: true });
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function normalizeScopeGrantSet(raw = {}) {
  const row = asObject(raw);
  return VALID_SCOPE_GRANT_IDS.reduce((acc, key) => {
    acc[key] = normalizeBoolean(row[key] ?? row[key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())], false);
    return acc;
  }, {});
}

export function listEnabledScopeGrantIds(raw = {}) {
  const grants = normalizeScopeGrantSet(raw);
  return VALID_SCOPE_GRANT_IDS.filter((key) => grants[key] === true);
}

export function hasScopeGrant(raw = {}, grantId = '') {
  const cleanGrantId = normalizeText(grantId, { lower: true });
  if (!VALID_SCOPE_GRANT_IDS.includes(cleanGrantId)) return false;
  const grants = normalizeScopeGrantSet(raw);
  return grants[cleanGrantId] === true;
}

export function defaultScopeGrantsForRole({ roleId = '', mode = 'shared_memory' } = {}) {
  const role = normalizeText(roleId, { lower: true });
  const scoped = normalizeText(mode, { lower: true }) === 'scoped_context';
  const grants = normalizeScopeGrantSet({});
  if (!scoped) {
    grants.shared_summary = true;
    grants.conversation_tail = role === 'researcher' || role === 'builder' || role === 'operator';
    grants.global_memory = role === 'builder' || role === 'operator';
    grants.user_pinned_nodes = role !== 'synthesizer';
    grants.explicit_uploaded_files = role === 'builder' || role === 'reviewer';
    grants.upstream_results = role === 'reviewer' || role === 'synthesizer';
    grants.upstream_summaries = role === 'reviewer' || role === 'synthesizer' || role === 'operator';
    return grants;
  }

  if (role === 'builder') {
    grants.explicit_uploaded_files = true;
    grants.user_pinned_nodes = true;
  }
  if (role === 'reviewer') {
    grants.upstream_results = true;
    grants.upstream_summaries = true;
    grants.explicit_uploaded_files = true;
  }
  if (role === 'synthesizer') {
    grants.upstream_results = true;
    grants.upstream_summaries = true;
  }
  if (role === 'operator') {
    grants.upstream_summaries = true;
    grants.conversation_tail = true;
    grants.user_pinned_nodes = true;
  }
  if (role === 'researcher') {
    grants.user_pinned_nodes = true;
  }
  return grants;
}

export function deriveScopeGrantRecords(scopeSpecs = []) {
  return asArray(scopeSpecs).flatMap((spec) => {
    const scopeId = normalizeText(spec?.scope_id || spec?.scopeId);
    if (!scopeId) return [];
    const explicitGrantId = normalizeText(spec?.grant_id || spec?.grantId, { lower: true });
    if (explicitGrantId && VALID_SCOPE_GRANT_IDS.includes(explicitGrantId)) {
      return [{
        scope_id: scopeId,
        target_instance_id: normalizeText(spec?.target_instance_id || spec?.targetInstanceId) || undefined,
        target_slot_id: normalizeText(spec?.target_slot_id || spec?.targetSlotId) || undefined,
        grant_id: explicitGrantId,
        resource_class: explicitGrantId,
        resource_label: RESOURCE_LABELS[explicitGrantId] || explicitGrantId,
        enabled: spec?.enabled !== false,
      }];
    }
    const grants = normalizeScopeGrantSet(spec?.memory_grants ?? spec?.memoryGrants ?? {});
    return listEnabledScopeGrantIds(grants).map((grantId) => ({
      scope_id: scopeId,
      target_instance_id: normalizeText(spec?.target_instance_id || spec?.targetInstanceId) || undefined,
      target_slot_id: normalizeText(spec?.target_slot_id || spec?.targetSlotId) || undefined,
      grant_id: grantId,
      resource_class: grantId,
      resource_label: RESOURCE_LABELS[grantId] || grantId,
      enabled: true,
    }));
  });
}

export function summarizeScopeGrantUsage(scopeSpecs = [], scopeGrants = []) {
  const records = asArray(scopeGrants).length > 0 ? asArray(scopeGrants) : deriveScopeGrantRecords(scopeSpecs);
  const counts = {};
  for (const row of records) {
    const grantId = normalizeText(row?.grant_id || row?.grantId, { lower: true });
    if (!grantId) continue;
    counts[grantId] = (counts[grantId] || 0) + 1;
  }
  return counts;
}
