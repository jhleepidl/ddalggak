import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendProposalToLog, appendProposalsToLog, readProposalLog, updateProposalStatus } from '../src/application/proposal_log.js';
import { evaluateMemoryCommitPolicy } from '../src/application/memory_commit_policy.js';
import { buildCommitManagerSnapshot, commitProposal, processProposalCommits, recordRetractionProposal } from '../src/application/commit_manager.js';

function tmpJob() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-proposals-'));
  fs.mkdirSync(path.join(dir, 'local_memory'), { recursive: true });
  return dir;
}

test('proposal log stores normalized proposals idempotently and supports status updates', () => {
  const jobDir = tmpJob();
  const first = appendProposalToLog({ jobDir, proposal: { kind: 'learned_rule_candidate', summary: '앞으로 파일을 만들지 말 것', risk: 'medium' } });
  const second = appendProposalToLog({ jobDir, proposal: { kind: 'learned_rule_candidate', summary: '앞으로 파일을 만들지 말 것', risk: 'medium' } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  updateProposalStatus({ jobDir, proposalId: first.proposal.proposal_id, status: 'rejected', actor: 'test', reason: 'duplicate preference' });
  const open = readProposalLog({ jobDir });
  assert.equal(open.proposals.length, 0);
  const all = readProposalLog({ jobDir, includeCommitted: true });
  assert.equal(all.proposals.length, 1);
  assert.equal(all.proposals[0].status, 'rejected');
  assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'proposal_actions.jsonl')));
});

test('commit policy auto-commits only explicit low-risk rules and supported facts', () => {
  assert.equal(evaluateMemoryCommitPolicy({ kind: 'explicit_user_rule', source: '/rule', risk: 'low', summary: 'artifact는 요청할 때만 만든다' }).decision, 'auto_commit');
  assert.equal(evaluateMemoryCommitPolicy({ kind: 'learned_rule_candidate', source: 'turn', risk: 'low', summary: '사용자가 선호하는 듯함' }).decision, 'review_required');
  assert.equal(evaluateMemoryCommitPolicy({ kind: 'claim_verification', risk: 'high', evidence_status: 'unsupported_or_weak', summary: '행사 장소는 A역 근처' }).next_status, 'needs_evidence');
});

test('commit manager writes commits and keeps risky proposals in review', () => {
  const jobDir = tmpJob();
  const result = processProposalCommits({ jobDir, actor: 'test', proposals: [
    { kind: 'explicit_user_rule', source: '/rule', risk: 'low', summary: '항상 한국어로 답하기' },
    { kind: 'materialization_candidate', risk: 'medium', summary: 'record collection shadow table' },
    { kind: 'claim_verification', risk: 'high', evidence_status: 'unsupported_or_weak', summary: '가격은 10달러입니다.' },
  ] });
  assert.equal(result.processed, 3);
  assert.equal(result.committed, 1);
  assert.equal(result.review_required, 2);
  const snapshot = buildCommitManagerSnapshot({ jobDir });
  assert.equal(snapshot.summary.commit_count, 1);
  assert.ok(snapshot.proposals.some((p) => p.proposal_kind === 'claim_verification' && p.status === 'needs_evidence'));
});

test('retractions are proposals, not destructive commits', () => {
  const jobDir = tmpJob();
  const r = recordRetractionProposal({ jobDir, target: { id: 'old_fact', summary: 'old location fact' }, reason: 'user corrected location' });
  assert.equal(r.proposal.proposal_kind, 'memory_retraction');
  assert.equal(commitProposal({ jobDir, proposal: r.proposal }).committed, false);
  const snapshot = buildCommitManagerSnapshot({ jobDir });
  assert.equal(snapshot.summary.retraction_count, 1);
  assert.ok(snapshot.proposals.some((p) => p.proposal_kind === 'memory_retraction'));
});

test('appendProposalsToLog can seed review queue proposals in batch', () => {
  const jobDir = tmpJob();
  const res = appendProposalsToLog({ jobDir, proposals: [
    { proposal_id: 'p1', kind: 'skill_candidate', summary: 'enable read function' },
    { proposal_id: 'p2', kind: 'materialization_candidate', summary: 'shadow module' },
  ] });
  assert.equal(res.created, 2);
  const log = readProposalLog({ jobDir, kinds: ['skill_candidate'] });
  assert.equal(log.proposals.length, 1);
});
