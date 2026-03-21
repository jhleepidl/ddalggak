function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', maxLen = 500) {
  const text = String(value || '').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function cleanId(value = '', maxLen = 160) {
  return clean(value, maxLen).toLowerCase();
}

function uniqueList(values = [], { max = 12 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = clean(raw, 180);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeAgencyRoleOverlay(raw = {}) {
  const row = asObject(raw);
  const overlayId = cleanId(row.overlay_id || row.overlayId || row.id || row.source_id || '');
  if (!overlayId) return null;
  const display = asObject(row.display);
  const classification = asObject(row.classification);
  const overlay = asObject(row.overlay);
  const source = asObject(row.source);
  return {
    overlay_id: overlayId,
    display: {
      title: clean(display.title || row.title || overlayId, 120) || overlayId,
      summary: clean(display.summary || row.summary || '', 240),
      emoji: clean(display.emoji || '', 8) || undefined,
      color: clean(display.color || '', 32) || undefined,
    },
    classification: {
      category: clean(classification.category || '', 64).toLowerCase() || undefined,
      canonical_role_id: cleanId(classification.canonical_role_id || classification.canonicalRoleId || row.canonical_role_id || 'builder', 64) || 'builder',
      preferred_archetypes: uniqueList(classification.preferred_archetypes || classification.preferredArchetypes || row.preferred_archetypes || [], { max: 8 }),
      tags: uniqueList(classification.tags || row.tags || [], { max: 12 }),
      good_for: uniqueList(classification.good_for || classification.goodFor || row.good_for || [], { max: 8 }),
      bad_for: uniqueList(classification.bad_for || classification.badFor || row.bad_for || [], { max: 8 }),
    },
    overlay: {
      identity_line: clean(overlay.identity_line || overlay.identityLine || '', 220),
      mission_points: uniqueList(overlay.mission_points || overlay.missionPoints || [], { max: 5 }),
      critical_rules: uniqueList(overlay.critical_rules || overlay.criticalRules || [], { max: 6 }),
      workflow_steps: uniqueList(overlay.workflow_steps || overlay.workflowSteps || [], { max: 5 }),
      deliverable_checks: uniqueList(overlay.deliverable_checks || overlay.deliverableChecks || [], { max: 5 }),
      communication_hints: uniqueList(overlay.communication_hints || overlay.communicationHints || [], { max: 3 }),
    },
    source: {
      kind: clean(source.kind || 'agency-agents', 64),
      owner: clean(source.owner || '', 64) || undefined,
      repo: clean(source.repo || '', 120) || undefined,
      ref: clean(source.ref || '', 80) || undefined,
      path: clean(source.path || '', 200) || undefined,
      url: clean(source.url || '', 300) || undefined,
      license: clean(source.license || '', 64) || undefined,
    },
  };
}

export function resolveAgencyRoleOverlay(...values) {
  for (const raw of values) {
    const overlay = normalizeAgencyRoleOverlay(raw);
    if (overlay) return overlay;
  }
  return null;
}

export function buildAgencyRoleOverlayPromptBlock(raw = {}, { maxBullets = 4 } = {}) {
  const overlay = normalizeAgencyRoleOverlay(raw);
  if (!overlay) return '';
  const lines = [];
  lines.push(`[ROLE OVERLAY · ${overlay.display.title}]`);
  if (overlay.overlay.identity_line) lines.push(`- identity: ${overlay.overlay.identity_line}`);
  if (overlay.classification.canonical_role_id) lines.push(`- canonical_role: ${overlay.classification.canonical_role_id}`);
  for (const entry of overlay.overlay.mission_points.slice(0, maxBullets)) lines.push(`- mission: ${entry}`);
  for (const entry of overlay.overlay.critical_rules.slice(0, Math.min(maxBullets, 4))) lines.push(`- critical_rule: ${entry}`);
  for (const entry of overlay.overlay.workflow_steps.slice(0, Math.min(maxBullets, 3))) lines.push(`- workflow: ${entry}`);
  for (const entry of overlay.overlay.deliverable_checks.slice(0, Math.min(maxBullets, 3))) lines.push(`- deliverable_check: ${entry}`);
  return lines.join('\n');
}
