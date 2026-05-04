import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMemoryDemandContext, inferMemoryDemand } from '../src/application/memory_demand_context.js';

function tmpJobDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-memory-demand-'));
  fs.mkdirSync(path.join(dir, 'local_memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace', 'uploads'), { recursive: true });
  return dir;
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

test('infers continuity and task-state demand from a follow-up question', () => {
  const demand = inferMemoryDemand('아까 하던 메모리 topology 패치 이어서 진행해줘', { roleId: 'builder' });
  assert.equal(demand.needsContinuity, true);
  assert.equal(demand.needsTaskState, true);
  assert.equal(demand.needsTurns, true);
  assert.ok(demand.reasons.includes('continuity_reference'));
});

test('retrieves same-chat turns and shared work before agent execution', () => {
  const jobDir = tmpJobDir();
  appendJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), {
    role: 'user',
    text: '메모리는 처음에는 flat하게 시작하고 압력이 커질 때만 topology를 분해하길 원해.',
  });
  appendJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), {
    role: 'assistant',
    text: 'memory_topology.js를 추가하고 compact_single에서 team_scoped로 진화하도록 구현했습니다.',
  });
  fs.writeFileSync(path.join(jobDir, 'shared', 'progress.md'), '# progress\n- memory topology preflight 설계 필요\n', 'utf8');

  const result = buildMemoryDemandContext({
    jobDir,
    userText: '아까 memory topology preflight 얘기 이어서 구현해줘',
    roleId: 'builder',
    persist: true,
  });

  assert.match(result.text, /\[MEMORY DEMAND CONTEXT\]/);
  assert.match(result.text, /flat하게 시작/);
  assert.match(result.text, /progress\.md|memory topology preflight/);
  assert.ok(result.sources.includes('local_memory/turns.jsonl'));
  assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl')));
});

test('retrieves user facts and artifact context when the query asks for them', () => {
  const jobDir = tmpJobDir();
  appendJsonl(path.join(jobDir, 'user_facts.jsonl'), {
    type: 'profile',
    field: 'weight_kg',
    value: 73,
    status: 'active',
    key: 'profile:weight_kg',
    created_at: '2026-05-03T00:00:00.000Z',
  });
  appendJsonl(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'), {
    workspace_path: 'uploads/lunch.jpg',
    filename: 'lunch.jpg',
    upload_kind: 'image',
  });
  appendJsonl(path.join(jobDir, 'artifact_observations.jsonl'), {
    event: 'artifact_observation',
    workspace_path: 'uploads/lunch.jpg',
    observed_labels: ['비빔밥'],
    status: 'verified',
    confidence: 0.9,
  });

  const result = buildMemoryDemandContext({
    jobDir,
    userText: '내 몸무게랑 아까 올린 점심 사진 기준으로 영양 조언해줘',
    roleId: 'researcher',
  });

  assert.match(result.text, /ACTIVE USER FACT CONTEXT/);
  assert.match(result.text, /weight=73kg/);
  assert.match(result.text, /ACTIVE ARTIFACT CONTEXT/);
  assert.match(result.text, /비빔밥/);
});

test('router memory classifier can force semantic memory sources without exact trigger words', () => {
  const demand = inferMemoryDemand('그 설계 흐름대로 다음 구현으로 넘어가자', {
    roleId: 'builder',
    routerMemoryPlan: {
      mode: 'query',
      query: 'adaptive memory topology design and latest implementation state',
      source_types: ['turns', 'task_state', 'shared_work', 'decisions'],
      reasons: ['llm_semantic_continuity'],
      classifier: 'supervisor_router_llm',
      confidence: 0.83,
    },
  });
  assert.equal(demand.needsContinuity, true);
  assert.equal(demand.needsTaskState, true);
  assert.equal(demand.needsSharedWork, true);
  assert.equal(demand.needsDecisions, true);
  assert.ok(demand.reasons.includes('router_memory_classifier'));
  assert.equal(demand.routerMemoryPlan.classifier, 'supervisor_router_llm');
});

test('scope memory_demand from router is preserved and used by preflight retrieval', () => {
  const jobDir = tmpJobDir();
  fs.writeFileSync(path.join(jobDir, 'shared', 'decisions.md'), '# decisions\n- Keep memory routing separate from fixed agent ownership.\n', 'utf8');
  appendJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), {
    role: 'user',
    text: 'agent 선택만으로 memory 선택을 대체하지 말고 router가 둘 다 판단해야 한다.',
  });

  const result = buildMemoryDemandContext({
    jobDir,
    userText: '그 방향으로 이어서 구현하자',
    roleId: 'builder',
    scopeHint: {
      mode: 'unfold_query',
      query: 'router chooses agent and memory demand together',
      memory_demand: {
        mode: 'query',
        source_types: ['turns', 'shared_work', 'decisions'],
        reasons: ['router_selected_memory'],
        classifier: 'supervisor_router_llm',
        confidence: 0.77,
      },
    },
    persist: true,
  });

  assert.match(result.text, /MEMORY DEMAND CONTEXT/);
  assert.match(result.text, /router가 둘 다 판단/);
  assert.match(result.text, /decisions\.md|memory routing separate/);
  assert.equal(result.demand.routerMemoryPlan.classifier, 'supervisor_router_llm');
  const events = fs.readFileSync(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl'), 'utf8');
  assert.match(events, /router_llm_preflight|supervisor_router_llm/);
});
