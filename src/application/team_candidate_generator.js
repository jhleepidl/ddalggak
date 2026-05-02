import { buildTeamMotifRegistry } from './team_motif_registry.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }

function uniq(values = [], max = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function inferRequiresFromMotif(motif = {}, stress = {}) {
  const roles = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
  const tags = uniq([...(motif.coverage_tags || []), ...(motif.task_types || [])], 16);
  const requires = {};
  if (roles.includes('builder') || Number(stress.workspace_mutation || 0) >= 0.6) requires.workspace_write = true;
  if (roles.includes('reviewer') || Number(stress.verification_need || 0) >= 0.65) requires.verifier = true;
  if (Number(stress.current_info_need || 0) >= 0.7 || tags.includes('evidence')) requires.web_browse = false;
  if (Number(stress.artifact_pressure || 0) >= 0.55 || tags.includes('implementation')) requires.artifact_delivery = true;
  return requires;
}

function motifMatchesStress(motif = {}, stress = {}, request = '') {
  const roles = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
  const tags = uniq([...(motif.coverage_tags || []), ...(motif.task_types || [])], 16);
  const text = clean(request).toLowerCase();
  let score = Number(motif.default_weight || 1);
  if (roles.includes('builder') && (Number(stress.artifact_pressure || 0) >= 0.35 || Number(stress.workspace_mutation || 0) >= 0.35)) score += 0.6;
  if (roles.includes('reviewer') && Number(stress.verification_need || 0) >= 0.4) score += 0.35;
  if (roles.includes('researcher') && Number(stress.current_info_need || 0) >= 0.35) score += 0.3;
  if (roles.length === 1 && Number(stress.overall || 0) < 0.35) score += 0.45;
  if (roles.length >= 4 && Number(stress.overall || 0) < 0.35) score -= 0.45;
  for (const tag of tags) {
    if (tag && text.includes(tag.replace(/_/g, ' '))) score += 0.08;
  }
  return score;
}

export function generateTeamCandidateBlueprints({ request = '', runtime = null, stress = {}, activeTeam = null, runtimeTeamSnapshot = null, motifFeedbackSummary = null, promotionSummary = null, limit = 8 } = {}) {
  const motifs = buildTeamMotifRegistry({ runtimeTeamSnapshot, activeTeam, motifFeedbackSummary, promotionSummary, channel: 'stable' });
  const rows = motifs.map((motif) => {
    const roleIds = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
    const prior = motifMatchesStress(motif, stress, request);
    return {
      candidate_id: cleanId(`motif:${motif.motif_id}`),
      source: motif.source || 'motif_registry',
      motif_id: motif.motif_id,
      label: motif.label,
      pattern: motif.pattern || 'sequential',
      role_slots: motif.role_slots,
      roles: roleIds,
      tags: uniq(motif.coverage_tags || [], 12),
      task_types: uniq(motif.task_types || [], 8),
      coordination_cost: Number(motif.coordination_cost || Math.max(0, roleIds.length - 1)),
      prior_weight: Number(prior.toFixed(3)),
      default_weight: Number(motif.default_weight || 1),
      requires: inferRequiresFromMotif(motif, stress),
    };
  });
  const sorted = rows.sort((a, b) => Number(b.prior_weight || 0) - Number(a.prior_weight || 0));
  return sorted.slice(0, Math.max(1, limit));
}

export function buildTeamCandidateSummary(candidate = {}) {
  const row = asObject(candidate);
  return {
    candidate_id: row.candidate_id,
    motif_id: row.motif_id,
    label: row.label,
    source: row.source,
    pattern: row.pattern,
    roles: row.roles,
    agent_count: Number(row.agent_count || row.team?.agents?.length || asArray(row.roles).length || 0),
    selected: row.selected === true,
    gate: row.gate,
    score: row.score,
    rationale: row.rationale || [],
  };
}
