function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function safeKind(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '') || 'memory_candidate'; }
function bool(value) { return value === true || ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase()); }
function evidenceStatus(proposal = {}) { return clean(proposal.evidence_status || proposal.evidenceStatus || asObject(proposal.payload).evidence_status).toLowerCase(); }
function isExplicitUserInput(proposal = {}) {
  const p = asObject(proposal);
  const payload = asObject(p.payload);
  return bool(p.explicit_user_input)
    || bool(payload.explicit_user_input)
    || clean(p.source).toLowerCase() === 'user'
    || clean(payload.source).toLowerCase() === 'user'
    || clean(p.source).startsWith('/rule')
    || clean(payload.command).startsWith('/rule');
}
function hasTrustedEvidence(proposal = {}) {
  const status = evidenceStatus(proposal);
  if (['supported', 'has_source_signal', 'explicit_user_fact'].includes(status)) return true;
  return asArray(proposal.evidence).some((row) => {
    const e = asObject(row);
    const st = clean(e.status || e.evidence_status).toLowerCase();
    return ['supported', 'source_verified', 'explicit_user_fact'].includes(st);
  });
}
export function evaluateMemoryCommitPolicy(proposal = {}, options = {}) {
  const p = asObject(proposal);
  const kind = safeKind(p.proposal_kind || p.kind_label || p.kind);
  const risk = clean(p.risk || 'medium').toLowerCase();
  const status = clean(p.status || 'pending_review').toLowerCase();
  const reasons = [];
  if (['committed', 'auto_committed', 'approved', 'rejected', 'stale', 'superseded'].includes(status)) {
    return { decision: 'ignore', commit_kind: '', reasons: [`proposal already ${status}`], next_status: status };
  }
  if (['claim_verification', 'external_fact', 'numeric_claim', 'temporal_claim', 'location_claim', 'source_claim'].includes(kind)) {
    if (!hasTrustedEvidence(p)) return { decision: 'review_required', commit_kind: '', reasons: ['external or high-risk claim needs evidence'], next_status: 'needs_evidence' };
  }
  if (['materialization_candidate', 'skill_candidate', 'write_skill_candidate', 'memory_module_candidate'].includes(kind)) {
    return { decision: 'review_required', commit_kind: '', reasons: ['materialization and skills require GoC review'], next_status: 'pending_review' };
  }
  if (['learned_rule_candidate', 'rule_candidate'].includes(kind)) {
    return { decision: 'review_required', commit_kind: '', reasons: ['learned rules stay candidates until reviewed'], next_status: 'pending_review' };
  }
  if (['memory_retraction', 'retraction_candidate'].includes(kind)) {
    return { decision: 'review_required', commit_kind: '', reasons: ['retractions require review to avoid deleting valid memory'], next_status: 'pending_review' };
  }
  if (kind === 'explicit_user_rule') {
    if (isExplicitUserInput(p) && risk !== 'high' && risk !== 'critical') {
      return { decision: 'auto_commit', commit_kind: 'active_rule', reasons: ['explicit /rule style user instruction'], next_status: 'auto_committed' };
    }
    return { decision: 'review_required', commit_kind: '', reasons: ['rule is not clearly explicit user input'], next_status: 'pending_review' };
  }
  if (['user_fact', 'memory_fact', 'artifact_observation'].includes(kind)) {
    if ((isExplicitUserInput(p) || hasTrustedEvidence(p)) && risk === 'low') {
      return { decision: 'auto_commit', commit_kind: kind === 'artifact_observation' ? 'artifact_observation' : 'memory_fact', reasons: ['low-risk supported user-provided fact'], next_status: 'auto_committed' };
    }
    reasons.push('fact or artifact observation requires review unless low-risk and supported');
    return { decision: 'review_required', commit_kind: '', reasons, next_status: hasTrustedEvidence(p) ? 'pending_review' : 'needs_evidence' };
  }
  if (options.allowLowRiskAutoCommit === true && risk === 'low' && hasTrustedEvidence(p)) {
    return { decision: 'auto_commit', commit_kind: 'memory_fact', reasons: ['policy allowed low-risk supported auto-commit'], next_status: 'auto_committed' };
  }
  return { decision: 'review_required', commit_kind: '', reasons: ['default safe policy: agent proposes, runtime/GoC reviews'], next_status: 'pending_review' };
}
export function explainMemoryCommitPolicy(proposal = {}, options = {}) {
  const decision = evaluateMemoryCommitPolicy(proposal, options);
  return `${decision.decision}: ${decision.reasons.join('; ')}`;
}
