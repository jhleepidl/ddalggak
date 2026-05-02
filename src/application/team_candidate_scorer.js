function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function clamp(value, min = 0, max = 1) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }

function roles(candidate = {}) {
  return asArray(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((a) => a.role)).map(cleanId).filter(Boolean);
}

function hasRole(candidate, role) {
  return roles(candidate).includes(cleanId(role));
}

export function scoreTeamCandidate(candidate = {}, { stress = {}, gate = null } = {}) {
  const s = asObject(stress);
  const g = asObject(gate || candidate.gate);
  const r = roles(candidate);
  const agentCount = Number(candidate.agent_count || candidate.team?.agents?.length || r.length || 1);
  const coordinationCost = Number(candidate.coordination_cost ?? Math.max(0, agentCount - 1));
  let expectedSuccess = 0.45;
  if (hasRole(candidate, 'builder') && (Number(s.artifact_pressure || 0) >= 0.45 || Number(s.workspace_mutation || 0) >= 0.45)) expectedSuccess += 0.18;
  if (hasRole(candidate, 'reviewer') && Number(s.verification_need || 0) >= 0.45) expectedSuccess += 0.14;
  if (hasRole(candidate, 'researcher') && Number(s.current_info_need || 0) >= 0.45) expectedSuccess += 0.1;
  if (hasRole(candidate, 'synthesizer') && agentCount >= 2) expectedSuccess += 0.08;
  if (agentCount === 1 && Number(s.overall || 0) < 0.35) expectedSuccess += 0.12;
  if (agentCount === 1 && Number(s.overall || 0) >= 0.65) expectedSuccess -= 0.18;
  expectedSuccess += Number(candidate.prior_weight || candidate.default_weight || 1) * 0.04;
  expectedSuccess = clamp(expectedSuccess, 0, 1);

  const costPenalty = clamp((agentCount - 1) * 0.055 + coordinationCost * 0.025, 0, 0.45);
  const latencyPenalty = clamp((agentCount - 1) * 0.045 + (candidate.pattern === 'parallel' ? 0.02 : 0.04), 0, 0.35);
  const riskPenalty = clamp((asArray(g.violations || g.blocking_reason_codes).length * 0.25) + (asArray(g.warnings || g.degrade_reason_codes).length * 0.04), 0, 0.9);
  const verificationBonus = hasRole(candidate, 'reviewer') && Number(s.verification_need || 0) >= 0.45 ? 0.08 : 0;
  const privacyBonus = asArray(candidate.tags || candidate.coverage_tags).some((tag) => /local|private|privacy/.test(cleanId(tag))) ? 0.04 : 0;
  const artifactBonus = hasRole(candidate, 'builder') && Number(s.artifact_pressure || 0) >= 0.6 ? 0.08 : 0;
  const utility = clamp(expectedSuccess - costPenalty - latencyPenalty - riskPenalty + verificationBonus + privacyBonus + artifactBonus, -1, 1);
  const sufficient = g.executable === true && utility >= 0.42 && expectedSuccess >= 0.52;
  return {
    expected_success: Number(expectedSuccess.toFixed(3)),
    estimated_cost: Number((agentCount + coordinationCost * 0.35).toFixed(3)),
    estimated_latency: Number((1 + (candidate.pattern === 'parallel' ? 0.55 : 0.85) * Math.max(0, agentCount - 1)).toFixed(3)),
    coordination_cost: coordinationCost,
    cost_penalty: Number(costPenalty.toFixed(3)),
    latency_penalty: Number(latencyPenalty.toFixed(3)),
    risk_penalty: Number(riskPenalty.toFixed(3)),
    utility: Number(utility.toFixed(3)),
    sufficient,
  };
}

export function selectTeamCandidate(candidates = [], { policy = 'cheapest_sufficient' } = {}) {
  const rows = asArray(candidates).filter(Boolean);
  if (rows.length === 0) return null;
  const executable = rows.filter((c) => c.gate?.executable === true);
  const pool = executable.length > 0 ? executable : rows;
  if (policy === 'max_utility') {
    return [...pool].sort((a, b) => Number(b.score?.utility || b.utility || 0) - Number(a.score?.utility || a.utility || 0))[0] || null;
  }
  const sufficient = pool.filter((c) => c.score?.sufficient === true);
  if (sufficient.length > 0) {
    return [...sufficient].sort((a, b) => {
      const costDelta = Number(a.score?.estimated_cost || 0) - Number(b.score?.estimated_cost || 0);
      if (Math.abs(costDelta) > 0.001) return costDelta;
      return Number(b.score?.utility || 0) - Number(a.score?.utility || 0);
    })[0] || null;
  }
  return [...pool].sort((a, b) => Number(b.score?.utility || 0) - Number(a.score?.utility || 0))[0] || null;
}
