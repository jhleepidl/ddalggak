import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitContextWriteIntent, readContextSubstrate, listContextOperations } from '../src/application/context_substrate_store.js';
import { compileAgentContextProjection } from '../src/application/context_projection_compiler.js';
import { extractContextWriteIntentsFromAgentResult } from '../src/application/context_write_intent_extractor.js';
import { commitContextWriteIntentsBatch } from '../src/application/context_write_batcher.js';
import { buildHandoffDeltaFromAgentResult, appendHandoffDelta } from '../src/application/handoff_delta_store.js';
import { loadRunContext } from '../src/application/run_context_cache.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'context-runtime-test-')); }

test('context projection compiler builds cached role/task projection with fallback context', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_a';
  commitContextWriteIntent({
    intent_type: 'assert_atom',
    payload: {
      id: 'skill.karpathy',
      atom_type: 'skill',
      title: 'Karpathy Guidelines',
      canonical_text_en: 'Think first, keep changes surgical, verify before claiming success.',
      tags: ['builder', 'code_change'],
      scope: { roles: ['builder'], task_types: ['code_change'] },
      confidence: 0.9,
    },
  }, { rootDir, jobId });

  const compiled1 = compileAgentContextProjection({
    rootDir,
    jobId,
    agentId: 'builder',
    roleId: 'builder',
    goal: 'Patch the webapp and run tests',
    baseContextText: 'Legacy context block',
    modelNode: 'codex:gpt-5.5',
  });
  assert.equal(compiled1.ok, true);
  assert.equal(compiled1.role, 'builder');
  assert.match(compiled1.prompt_block, /Karpathy Guidelines/);
  assert.match(compiled1.prompt_block, /Legacy context block/);
  assert.equal(compiled1.metrics.cache_hit, false);

  const compiled2 = compileAgentContextProjection({
    rootDir,
    jobId,
    agentId: 'builder',
    roleId: 'builder',
    goal: 'Patch the webapp and run tests',
    baseContextText: 'Legacy context block',
    modelNode: 'codex:gpt-5.5',
  });
  assert.equal(compiled2.metrics.cache_hit, true);
});

test('batched context write intents share a base snapshot without intra-batch conflicts', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_b';
  commitContextWriteIntent({ intent_type: 'assert_atom', payload: { id: 'atom.seed', atom_type: 'memory', canonical_text_en: 'Seed memory' } }, { rootDir, jobId });
  const base = readContextSubstrate({ rootDir, jobId }).snapshot_id;
  const result = commitContextWriteIntentsBatch([
    { actor: 'agent:builder', intent_type: 'append_event', payload: { atom_type: 'event', title: 'Builder done' }, preconditions: { base_snapshot_id: base } },
    { actor: 'agent:builder', intent_type: 'record_usage', payload: { atom_type: 'usage_event', provider: 'codex' }, preconditions: { base_snapshot_id: base } },
    { actor: 'agent:builder', intent_type: 'assert_atom', payload: { id: 'atom.review', atom_type: 'review_finding', canonical_text_en: 'Needs review.' }, preconditions: { base_snapshot_id: base } },
  ], { rootDir, jobId });
  assert.equal(result.committed, 3);
  assert.equal(result.conflicts, 0);
  assert.equal(readContextSubstrate({ rootDir, jobId }).atoms.some((atom) => atom.id === 'atom.review'), true);
  assert.equal(listContextOperations({ rootDir, jobId }, { limit: 10 }).length, 4);
});

test('agent output extraction and handoff delta are lightweight runtime side effects', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_c';
  const preparedContext = { context_info: { projection_id: 'proj_1', snapshot_id: 'ctx_000000' } };
  const result = {
    provider: 'codex',
    model: 'gpt-5.5',
    output: 'Changed files: src/App.tsx\nTest result: npm test passed\nRisk: financial wording needs review',
  };
  const intents = extractContextWriteIntentsFromAgentResult({ agentId: 'builder', roleId: 'builder', goal: 'Implement risk UI', result, preparedContext });
  assert.ok(intents.length >= 3);
  const batch = commitContextWriteIntentsBatch(intents, { rootDir, jobId });
  assert.ok(batch.committed >= 2);

  const handoff = buildHandoffDeltaFromAgentResult({ agentId: 'builder', roleId: 'builder', goal: 'Implement risk UI', result, preparedContext });
  assert.equal(handoff.handoff_type, 'review_request');
  appendHandoffDelta(handoff, { rootDir, jobId });
  const state = loadRunContext({ rootDir, jobId });
  assert.equal(state.handoffs.length, 1);
  assert.match(JSON.stringify(state.handoffs[0].delta), /financial wording/);
});

test('context projection keeps casual recommendation goals out of code_change even when role text is implementation-like', () => {
  const rootDir = tmpRoot();
  const compiled = compileAgentContextProjection({
    rootDir,
    jobId: 'job_menu',
    agentId: 'research_lead',
    roleId: 'Research Lead',
    goal: '오늘 점심에는 오므라이스를 먹었고 저녁에는 식당 회식 메뉴를 추천해줘',
    baseContextText: 'Legacy context block',
    modelNode: 'codex:gpt-5.5',
  });
  assert.equal(compiled.ok, true);
  assert.equal(compiled.task_type, 'general_task');
  assert.doesNotMatch(compiled.prompt_block, /task_type: code_change/);
});

test('compiled projection includes approved Room memories as first-class supplemental atoms', () => {
  const base = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'context-projection-approved-memory-'));
  try {
    const compiled = compileAgentContextProjection({
      jobId: 'job-approved-memory',
      agentId: 'researcher',
      roleId: 'researcher',
      goal: '조용한 장소 추천 기준을 알려줘',
      rootDir: root,
      supplementalAtoms: [{
        id: 'mem_quiet_places',
        atom_type: 'approved_room_memory',
        title: 'user_boundary_or_exclusion',
        text_original: '사용자는 시끄러운 장소를 피하고 이미 방문한 곳을 재추천하지 않기를 원한다.',
      }],
    });
    assert.ok(compiled.projection.atoms.some((atom) => atom.id === 'mem_quiet_places' && atom.atom_type === 'approved_room_memory'));
    assert.match(compiled.prompt_block, /mem_quiet_places/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isolated collaboration lanes exclude context atoms emitted by sibling lanes until review', () => {
  const base = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
  fs.mkdirSync(base, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(base, 'context-projection-lane-isolation-'));
  const jobId = 'job_lane_isolation';
  try {
    for (const [id, laneId, text] of [
      ['atom.shared', '', 'Shared room fact'],
      ['atom.lane1', 'lane_1', 'Lane one private finding'],
      ['atom.lane2', 'lane_2', 'Lane two private finding'],
    ]) {
      commitContextWriteIntent({
        intent_type: 'assert_atom',
        payload: {
          id,
          atom_type: 'review_finding',
          canonical_text_en: text,
          structured: laneId ? { lane_id: laneId, collaboration_lane: { lane_id: laneId, initial_visibility: 'isolated_until_submission' } } : {},
        },
      }, { rootDir, jobId });
    }

    const lane2 = compileAgentContextProjection({
      rootDir,
      jobId,
      agentId: 'researcher_lane_2',
      roleId: 'researcher',
      goal: 'Produce an independent option',
      visibilityContext: { lane_id: 'lane_2', initial_visibility: 'isolated_until_submission' },
    });
    const lane2Ids = lane2.projection.atoms.map((atom) => atom.id);
    assert.ok(lane2Ids.includes('atom.shared'));
    assert.ok(lane2Ids.includes('atom.lane2'));
    assert.equal(lane2Ids.includes('atom.lane1'), false);
    assert.deepEqual(lane2.projection.visibility_excluded_atom_ids, ['atom.lane1']);
    assert.equal(lane2.metrics.visibility_excluded_atom_count, 1);

    const reviewer = compileAgentContextProjection({
      rootDir,
      jobId,
      agentId: 'reviewer',
      roleId: 'reviewer',
      goal: 'Compare all submitted lanes',
    });
    const reviewerIds = reviewer.projection.atoms.map((atom) => atom.id);
    assert.ok(reviewerIds.includes('atom.lane1'));
    assert.ok(reviewerIds.includes('atom.lane2'));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('context write intents preserve collaboration lane provenance for later isolation', () => {
  const intents = extractContextWriteIntentsFromAgentResult({
    agentId: 'researcher_lane_2',
    roleId: 'researcher',
    goal: 'Independent risk analysis',
    collaborationLane: {
      lane_id: 'lane_2',
      initial_visibility: 'isolated_until_submission',
      diversity_dimension: 'risk',
    },
    result: {
      provider: 'claude',
      model: 'claude-test',
      output: 'Risk: vendor lock-in\nVerification: assumptions checked',
    },
  });
  const structured = intents.map((intent) => intent?.payload?.structured).filter(Boolean);
  assert.ok(structured.length >= 2);
  assert.equal(structured.every((row) => row.lane_id === 'lane_2'), true);
  assert.equal(structured.every((row) => row.collaboration_lane?.lane_id === 'lane_2'), true);
});
