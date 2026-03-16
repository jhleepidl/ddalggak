import { clip } from '../../textutil.js';
import { canonicalRoleDisplayName, resolveActionAgentNameHint } from '../../shared/agent_labels.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = '', { lower = false } = {}) {
  const text = String(value || '').trim();
  return lower ? text.toLowerCase() : text;
}

function summarizeChildLabel(child = {}) {
  const hint = resolveActionAgentNameHint(child);
  if (hint) return hint;
  const roleId = normalizeText(child?.inputs?.role_id || child?.inputs?.roleId || child?.agent || child?.agent_id, { lower: true });
  return canonicalRoleDisplayName(roleId) || null;
}

export function toolInputPreviewFromAction(action, detailContext = '') {
  const type = normalizeText(action?.type, { lower: true });
  const lines = [`type=${type || 'unknown'}`];
  const displayHint = resolveActionAgentNameHint(action);
  const runtimeInstanceId = normalizeText(action?.inputs?.runtime_instance_id || action?.inputs?.runtimeInstanceId, { lower: true });
  const roleId = normalizeText(action?.inputs?.role_id || action?.inputs?.roleId || action?.agent || action?.agent_id, { lower: true });
  if (displayHint) {
    lines.push(`agent=${displayHint}`);
  } else if (runtimeInstanceId) {
    lines.push(`runtime_instance_id=${runtimeInstanceId}`);
  } else if (roleId) {
    lines.push(`agent=${canonicalRoleDisplayName(roleId) || roleId}`);
  }
  const goal = String(action?.goal || action?.prompt || action?.task || '').trim();
  if (goal) lines.push(`goal=${clip(goal, 400)}`);
  if (type === 'spawn_agents' || type === 'spawn_parallel') {
    const children = asArray(action?.agents);
    if (children.length > 0) {
      lines.push(`children=${children.map((row) => summarizeChildLabel(row) || 'agent').join(', ')}`);
    }
  }
  if (type === 'need_more_detail') {
    lines.push(`context_set_id=${String(action?.context_set_id || '').trim() || '(shared)'}`);
  }
  const detail = String(detailContext || '').trim();
  if (detail) lines.push(`detail_context=${clip(detail, 220)}`);
  return lines.join('\n');
}

export function outputPreviewFromResult(result) {
  if (typeof result === 'string') return clip(result, 1800);
  if (result == null) return '';
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) return clip(JSON.stringify(result), 1800);
  const row = result && typeof result === 'object' ? result : {};
  const direct = String(
    row.output
    || row.text
    || row.summary
    || row.link
    || row.message
    || ''
  ).trim();
  if (direct) return clip(direct, 1800);
  try {
    return clip(JSON.stringify(row), 1800);
  } catch {
    return clip(String(row), 1800);
  }
}
