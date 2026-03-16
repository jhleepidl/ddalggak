function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const CANONICAL_ROLE_LABELS = {
  researcher: 'Researcher',
  builder: 'Builder',
  reviewer: 'Reviewer',
  synthesizer: 'Synthesizer',
  operator: 'Operator',
  supervisor: 'Supervisor',
};

export function normalizeAgentId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeAgentName(value = '') {
  return String(value || '').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeAgentName(value);
    if (text) return text;
  }
  return '';
}

function humanizeIdentifier(value = '') {
  const text = normalizeAgentName(value);
  if (!text) return '';
  return text
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function looksOpaqueInternalId(value = '') {
  const text = normalizeAgentName(value).toLowerCase();
  if (!text) return false;
  if (/^[0-9a-f]{8,}$/.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{8,}$/.test(text)) return true;
  if (/^(rt|slot|ctx|cell|cp|sup|tp)_[a-z0-9_:-]+$/.test(text)) return true;
  if (/^[a-z]{1,4}[0-9a-f]{6,}$/.test(text)) return true;
  return false;
}

export function canonicalRoleDisplayName(roleId = '') {
  const clean = normalizeAgentId(roleId);
  if (!clean) return '';
  return CANONICAL_ROLE_LABELS[clean] || humanizeIdentifier(clean);
}

function pushAgentRows(index, rows = []) {
  for (const rowRaw of asArray(rows)) {
    const row = asObject(rowRaw);
    const ids = [
      row.id,
      row.agent_id,
      row.agentId,
      row.instance_id,
      row.instanceId,
      row.runtime_instance_id,
      row.runtimeInstanceId,
      row.template_id,
      row.templateId,
      row.preset_id,
      row.presetId,
      row.slot_id,
      row.slotId,
      row.role_id,
      row.roleId,
      row.role_label,
      row.roleLabel,
      row.command_ref,
      row.commandRef,
      row.legacy_transport_agent_id,
      row.legacyTransportAgentId,
    ]
      .map((value) => normalizeAgentId(value))
      .filter(Boolean);
    for (const id of ids) {
      if (!index.has(id)) index.set(id, row);
    }
  }
}

function actionRuntimeRows(actions = []) {
  const rows = [];
  for (const actionRaw of asArray(actions)) {
    const action = asObject(actionRaw);
    const inputs = asObject(action.inputs);
    const roleId = normalizeAgentId(
      inputs.role_id
      || inputs.roleId
      || action.role_id
      || action.roleId
      || action.role_label
      || action.roleLabel
    );
    const displayLabel = firstNonEmpty(
      inputs.display_label,
      inputs.displayLabel,
      inputs.slot_label,
      inputs.slotLabel,
      action.display_label,
      action.displayLabel,
      action.label,
      action.name,
      canonicalRoleDisplayName(roleId),
    );
    if (displayLabel || inputs.runtime_instance_id || inputs.slot_id || roleId) {
      rows.push({
        id: action.agent_id || action.agentId || action.agent,
        agent_id: action.agent_id || action.agentId || action.agent,
        runtime_instance_id: inputs.runtime_instance_id || inputs.runtimeInstanceId,
        instance_id: inputs.runtime_instance_id || inputs.runtimeInstanceId || action.agent_id || action.agentId || action.agent,
        slot_id: inputs.slot_id || inputs.slotId,
        preset_id: inputs.preset_id || inputs.presetId,
        role_id: roleId || undefined,
        role_label: canonicalRoleDisplayName(roleId) || undefined,
        display_label: displayLabel || undefined,
        purpose: firstNonEmpty(inputs.slot_purpose, inputs.slotPurpose),
      });
    }
    if (normalizeAgentId(action.type) === 'spawn_parallel' || normalizeAgentId(action.type) === 'spawn_agents') {
      rows.push(...actionRuntimeRows(action.agents));
    }
  }
  return rows;
}

export function buildAgentDisplayIndex(...sources) {
  const index = new Map();
  for (const sourceRaw of sources) {
    if (!sourceRaw) continue;
    if (Array.isArray(sourceRaw)) {
      pushAgentRows(index, sourceRaw);
      continue;
    }
    const source = asObject(sourceRaw);
    pushAgentRows(index, source.agents);
    pushAgentRows(index, source.agentsCatalog);
    pushAgentRows(index, source.runtime_agents);
    pushAgentRows(index, source.runtimeAgents);
    pushAgentRows(index, source.items);
    pushAgentRows(index, source.team_view?.items);
    pushAgentRows(index, source.runtime_team_snapshot?.runtime_agents);
    pushAgentRows(index, source.team_plan?.runtime_agents);
    pushAgentRows(index, source.routePlan?.runtime_agents);
    pushAgentRows(index, source.routePlan?.team_plan?.runtime_agents);
    pushAgentRows(index, source.route_plan?.runtime_agents);
    pushAgentRows(index, source.route_plan?.team_plan?.runtime_agents);
    pushAgentRows(index, actionRuntimeRows(source.actions));
  }
  return index;
}

export function buildPreviewAgentDisplayIndex({
  agentRegistry = null,
  runtime = null,
  routePlan = null,
  runtimeSnapshot = null,
  actions = [],
} = {}) {
  return buildAgentDisplayIndex(
    agentRegistry,
    runtime,
    runtimeSnapshot,
    routePlan,
    routePlan?.team_plan,
    runtime?.runtime_team_snapshot,
    { actions },
  );
}

function inferAgentName(row = {}, fallbackId = '') {
  const entry = asObject(row);
  const preferred = [
    entry.display_label,
    entry.displayLabel,
    entry.logical_label,
    entry.logicalLabel,
    entry.name,
    entry.title,
    entry.slot_label,
    entry.slotLabel,
    entry.purpose,
    entry.role_label,
    entry.roleLabel,
    canonicalRoleDisplayName(entry.role_id || entry.roleId),
    entry.preset_id,
    entry.presetId,
    entry.system_key,
    entry.systemKey,
    looksOpaqueInternalId(fallbackId) ? '' : canonicalRoleDisplayName(fallbackId),
    looksOpaqueInternalId(fallbackId) ? '' : fallbackId,
  ];
  for (const candidate of preferred) {
    const clean = normalizeAgentName(candidate);
    if (!clean) continue;
    if (looksOpaqueInternalId(clean)) continue;
    return clean;
  }
  return '';
}

function inferAgentMeta(row = {}) {
  const entry = asObject(row);
  const parts = [];
  const slotId = normalizeAgentId(entry.slot_id || entry.slotId);
  const roleId = normalizeAgentId(entry.role_id || entry.roleId || entry.role_label || entry.roleLabel);
  const presetId = normalizeAgentId(entry.preset_id || entry.presetId || entry.template_id || entry.templateId);
  if (slotId) parts.push(`slot:${slotId}`);
  if (roleId) parts.push(`role:${roleId}`);
  if (presetId) parts.push(entry.synthesized === true ? 'synthesized' : `preset:${presetId}`);
  return parts.join(', ');
}

function isGenericLabel(label = '', id = '') {
  const cleanLabel = normalizeAgentName(label).toLowerCase();
  const cleanId = normalizeAgentId(id);
  if (!cleanLabel) return true;
  if (cleanLabel === cleanId) return true;
  return cleanLabel === canonicalRoleDisplayName(cleanId).toLowerCase();
}

function pickDisplayName({ rowName = '', hintName = '', fallbackId = '' } = {}) {
  if (hintName && (!rowName || isGenericLabel(rowName, fallbackId))) return hintName;
  if (rowName) return rowName;
  if (hintName) return hintName;
  if (!looksOpaqueInternalId(fallbackId)) return canonicalRoleDisplayName(fallbackId) || '';
  return '';
}

export function formatAgentDisplayName(agentId = '', agentIndex = new Map(), {
  nameHint = '',
  includeShortId = true,
  fallbackLabel = 'Agent',
} = {}) {
  const id = normalizeAgentId(agentId);
  const hintName = normalizeAgentName(nameHint);
  if (!id && !hintName) return fallbackLabel;
  const shortId = (id || normalizeAgentId(hintName)).slice(0, 8) || 'unknown';
  const row = agentIndex instanceof Map ? agentIndex.get(id) : null;
  const rowName = inferAgentName(row, id || hintName);
  const rowMeta = inferAgentMeta(row);
  const displayName = pickDisplayName({ rowName, hintName, fallbackId: id || hintName }) || fallbackLabel;
  if (!includeShortId) return displayName;
  if (!id || !isGenericLabel(displayName, id) || looksOpaqueInternalId(id)) {
    return rowMeta ? `${displayName} (${rowMeta})` : displayName;
  }
  return rowMeta ? `${displayName} (${rowMeta}) [${shortId}]` : `${displayName} [${shortId}]`;
}

export function formatChatAgentDisplayName(agentId = '', agentIndex = new Map(), {
  nameHint = '',
  fallbackLabel = 'Agent',
} = {}) {
  return formatAgentDisplayName(agentId, agentIndex, {
    nameHint,
    includeShortId: false,
    fallbackLabel,
  });
}

function actionInputs(action = {}) {
  return asObject(action.inputs);
}

export function resolveActionAgentId(action = {}) {
  const row = asObject(action);
  const inputs = actionInputs(action);
  const type = normalizeAgentId(row.type);
  if (!type) {
    return normalizeAgentId(
      inputs.runtime_instance_id
      || inputs.runtimeInstanceId
      || row.agent_id
      || row.agentId
      || row.agent
      || row.id
      || ''
    );
  }
  if (type === 'run_agent' || type === 'agent_run' || type === 'propose_agent') {
    return normalizeAgentId(
      inputs.runtime_instance_id
      || inputs.runtimeInstanceId
      || row.runtime_instance_id
      || row.runtimeInstanceId
      || row.agent_id
      || row.agent
      || row.id
    );
  }
  if ([
    'add_agent_to_conversation',
    'remove_agent_from_conversation',
    'enable_agent',
    'disable_agent',
    'fork_agent',
    'publish_agent',
  ].includes(type)) {
    return normalizeAgentId(row.agent_id || row.agent || row.id || row.agentId);
  }
  if (type === 'create_agent' || type === 'update_agent') {
    return normalizeAgentId(
      row.agent_id
      || row.agentId
      || row.agent?.id
      || row.agent?.agent_id
      || row.id
    );
  }
  if (type === 'create_agent_definition') {
    return normalizeAgentId(
      row.agent_id
      || row.agentId
      || row.agent_spec?.id
      || row.agentSpec?.id
      || row.agent?.id
      || row.id
    );
  }
  return '';
}

export function resolveActionAgentNameHint(action = {}) {
  const row = asObject(action);
  const inputs = actionInputs(action);
  const type = normalizeAgentId(row.type);
  const roleHintId = inputs.role_id || inputs.roleId || row.role_id || row.roleId || row.role_label || row.roleLabel;
  const slotHint = firstNonEmpty(inputs.slot_label, inputs.slotLabel);
  const explicitHint = firstNonEmpty(
    inputs.display_label,
    inputs.displayLabel,
    row.display_label,
    row.displayLabel,
    row.label,
    row.name,
  );
  if (explicitHint) {
    if (slotHint && isGenericLabel(explicitHint, roleHintId)) return slotHint;
    return explicitHint;
  }
  if (slotHint) return slotHint;
  if (type === 'propose_agent') {
    return firstNonEmpty(row.name, row.agent?.name, row.profile?.name);
  }
  if (type === 'create_agent_definition') {
    return firstNonEmpty(
      row.agent_spec?.name,
      row.agentSpec?.name,
      row.agent?.name,
      row.name,
    );
  }
  if (type === 'create_agent' || type === 'update_agent') {
    return firstNonEmpty(row.agent?.name, row.name);
  }
  const presetHint = firstNonEmpty(inputs.preset_display_name, inputs.presetDisplayName, inputs.preset_id, inputs.presetId);
  if (presetHint) return humanizeIdentifier(presetHint);
  const roleHint = canonicalRoleDisplayName(roleHintId);
  if (roleHint) return roleHint;
  return '';
}
