import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamSelectionPortfolio, selectPendingTeamCandidate, getSessionTeamState, storePendingTeam, formatTeamCandidatePortfolioMessage } from '../src/application/team_configuration.js';

function runtimeWith(caps = []) {
  const obj = {};
  for (const cap of caps) obj[cap] = true;
  return { capabilities: obj, availableToolIds: caps, agents: [], enabledAgentIds: [] };
}

function makeSessionStore() {
  const map = new Map();
  return {
    get: (id) => map.get(id) || {},
    upsert: (id, fn) => map.set(id, fn(map.get(id) || {})),
  };
}

test('portfolio generation covers non-greedy build/review motifs for artifact requests', () => {
  const portfolio = buildTeamSelectionPortfolio({
    taskText: '주식 관련 정보를 모아서 보여주는 웹사이트를 구현해줘.',
    runtime: runtimeWith(['workspace_read', 'workspace_write']),
    maxCandidates: 8,
  });
  assert.ok(portfolio.candidates.length >= 3);
  assert.ok(portfolio.candidates.some((c) => c.motif_id === 'motif_builder_reviewer_synthesizer'));
  assert.ok(portfolio.candidates.some((c) => c.roles.includes('builder') && c.roles.includes('reviewer')));
  const selected = portfolio.candidates.find((c) => c.selected);
  assert.ok(selected);
  assert.equal(selected.gate.executable, true);
  assert.ok(selected.roles.includes('builder'));
});

test('portfolio state supports selecting a non-default candidate by number', () => {
  const store = makeSessionStore();
  const portfolio = buildTeamSelectionPortfolio({
    taskText: '웹사이트 구현 결과를 검토하고 전달하는 팀을 구성해줘.',
    runtime: runtimeWith(['workspace_read', 'workspace_write']),
    maxCandidates: 6,
  });
  storePendingTeam(store, 'chat1', portfolio.selected_team, { portfolio });
  const state = getSessionTeamState(store, 'chat1');
  assert.ok(state.pending_team_portfolio);
  const picked = selectPendingTeamCandidate(store, 'chat1', '2', { runtime: runtimeWith(['workspace_read', 'workspace_write']) });
  assert.ok(picked.team);
  const nextState = getSessionTeamState(store, 'chat1');
  assert.equal(nextState.pending_team_portfolio.selected_candidate_id, picked.candidate.candidate_id);
});

test('portfolio formatter exposes candidate gate and apply instruction', () => {
  const portfolio = buildTeamSelectionPortfolio({ taskText: '간단한 보고서를 작성해줘.', runtime: runtimeWith([]), maxCandidates: 4 });
  const text = formatTeamCandidatePortfolioMessage(portfolio);
  assert.match(text, /Team candidate portfolio/);
  assert.match(text, /\/team apply <번호>/);
});
