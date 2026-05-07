import fs from 'node:fs';
import path from 'node:path';
import { appendProposalToLog, readProposalLog, updateProposalStatus } from './proposal_log.js';
import { evaluateMemoryCommitPolicy } from './memory_commit_policy.js';

export const COMMITS_FILE = 'commits.jsonl';
export const RETRACTIONS_FILE = 'retractions.jsonl';
export const EVIDENCE_EVENTS_FILE = 'evidence_events.jsonl';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function localMemoryDir(jobDir = '') { return path.join(String(jobDir || ''), 'local_memory'); }
function appendJsonl(file = '', value = {}) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function filePath(jobDir = '', name = '') { return path.join(localMemoryDir(jobDir), name); }
function readJsonl(file = '') {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}
export function commitProposal({ jobDir = '', proposal = {}, actor = 'runtime', policyOptions = {} } = {}) {
  const d = clean(jobDir);
  if (!d) throw new Error('jobDir is required');
  const logged = appendProposalToLog({ jobDir: d, proposal, defaults: { actor }, dedupe: true }).proposal;
  const decision = evaluateMemoryCommitPolicy(logged, policyOptions);
  if (decision.decision === 'ignore') return { ok: true, decision, proposal: logged, committed: false };
  if (decision.decision !== 'auto_commit') {
    updateProposalStatus({ jobDir: d, proposalId: logged.proposal_id, status: decision.next_status || 'pending_review', actor, action: decision.decision, reason: decision.reasons.join('; ') });
    if (decision.next_status === 'needs_evidence') {
      appendJsonl(filePath(d, EVIDENCE_EVENTS_FILE), {
        ts: nowIso(), kind: 'proposal_needs_evidence', proposal_id: logged.proposal_id,
        proposal_kind: logged.proposal_kind, reasons: decision.reasons, actor: clean(actor || 'runtime'),
      });
    }
    return { ok: true, decision, proposal: { ...logged, status: decision.next_status || logged.status }, committed: false };
  }
  const event = {
    ts: nowIso(),
    kind: 'runtime_commit',
    proposal_id: logged.proposal_id,
    proposal_kind: logged.proposal_kind,
    commit_kind: decision.commit_kind,
    title: logged.title,
    summary: logged.summary,
    actor: clean(actor || 'runtime'),
    reasons: decision.reasons,
    source: logged.source,
    source_id: logged.source_id,
    payload: asObject(logged.payload),
  };
  appendJsonl(filePath(d, COMMITS_FILE), event);
  updateProposalStatus({ jobDir: d, proposalId: logged.proposal_id, status: decision.next_status || 'auto_committed', actor, action: 'auto_commit', reason: decision.reasons.join('; ') });
  return { ok: true, decision, proposal: { ...logged, status: decision.next_status || 'auto_committed' }, committed: true, event };
}
export function processProposalCommits({ jobDir = '', proposals = [], actor = 'runtime', policyOptions = {} } = {}) {
  const rows = asArray(proposals);
  const results = rows.map((proposal) => commitProposal({ jobDir, proposal, actor, policyOptions }));
  return {
    ok: true,
    processed: results.length,
    committed: results.filter((r) => r.committed).length,
    review_required: results.filter((r) => !r.committed && r.decision?.decision === 'review_required').length,
    ignored: results.filter((r) => r.decision?.decision === 'ignore').length,
    results,
  };
}
export function recordRetractionProposal({ jobDir = '', target = {}, reason = '', actor = 'runtime' } = {}) {
  const proposal = {
    proposal_kind: 'memory_retraction',
    kind: 'memory_retraction',
    title: 'Memory retraction candidate',
    summary: clean(reason || target.summary || target.claim || 'Possible correction or stale memory'),
    risk: 'high',
    status: 'pending_review',
    recommended_action: 'review_before_retraction',
    source: clean(target.source || 'runtime'),
    source_id: clean(target.source_id || target.id || ''),
    payload: { target: asObject(target), reason: clean(reason) },
  };
  const result = appendProposalToLog({ jobDir, proposal, defaults: { actor } });
  appendJsonl(filePath(jobDir, RETRACTIONS_FILE), {
    ts: nowIso(), kind: 'retraction_proposed', proposal_id: result.proposal.proposal_id,
    actor: clean(actor || 'runtime'), reason: clean(reason), target: asObject(target),
  });
  return result;
}
export function buildCommitManagerSnapshot({ jobDir = '', includeClosed = true, limit = 200 } = {}) {
  const proposals = readProposalLog({ jobDir, includeCommitted: includeClosed, limit });
  const commits = readJsonl(filePath(jobDir, COMMITS_FILE));
  const retractions = readJsonl(filePath(jobDir, RETRACTIONS_FILE));
  const evidenceEvents = readJsonl(filePath(jobDir, EVIDENCE_EVENTS_FILE));
  return {
    kind: 'ddalggak_commit_manager_snapshot',
    generated_at: nowIso(),
    proposals: proposals.proposals,
    proposal_summary: proposals.summary,
    commits: commits.slice(-limit),
    retractions: retractions.slice(-limit),
    evidence_events: evidenceEvents.slice(-limit),
    summary: {
      proposal_count: proposals.summary?.proposal_count || 0,
      commit_count: commits.length,
      retraction_count: retractions.length,
      evidence_event_count: evidenceEvents.length,
    },
    policy: {
      principle: 'Agent proposes. Runtime commits. GoC reviews.',
      auto_commit_scope: ['explicit_user_rule', 'low_risk_supported_user_fact'],
      review_required_scope: ['learned_rule_candidate', 'materialization_candidate', 'skill_candidate', 'unsupported_claim', 'retraction_candidate'],
    },
  };
}
