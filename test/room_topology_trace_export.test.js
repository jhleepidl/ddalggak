import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRoomTopologyTrainingDataset, exportRoomTopologyTrainingDataset } from '../src/application/room_topology_trace_export.js';

test('topology training dataset includes special-token input and guarded labels', () => {
  const events = [
    { ts: '2026-07-05T01:00:00.000Z', chat_id: 'c', event_type: 'work_depth_used', command: '/loop', goal: '논문 실험 코드를 구현하고 검증해줘', room: { domain_label: 'research_paper_factory', memory_object_types: ['advisor_feedback'] }, extra: { depth: 'loop' } },
    { ts: '2026-07-05T01:10:00.000Z', chat_id: 'c', event_type: 'room_document_moc_synced', command: '/room docs sync', goal: 'sync docs' },
  ];
  const dataset = buildRoomTopologyTrainingDataset({ events, roomPackage: { package_id: 'research_paper_factory', default_depth: 'loop', domain_label: 'research_paper', agents: ['research_scout', 'novelty_critic'], skills: ['literature_scan', 'experiment_scaffold'] }, limit: 10 });
  assert.equal(dataset.row_count, 2);
  assert.ok(dataset.rows[0].input.special_tokens.ROOM_INTENT.includes('논문'));
  assert.ok(dataset.rows[0].input.special_tokens.WITNESS.includes('projection_trace'));
  assert.ok(dataset.rows[0].input.special_tokens.MODEL_POLICY.includes('concierge_router'));
  assert.ok(dataset.rows[0].input.special_tokens.AGENT_ACTIVATION_POLICY.includes(':'));
  assert.ok(dataset.rows[0].labels.model_role_assignment.includes('concierge_router'));
  assert.ok(dataset.rows[0].labels.agent_activation_policy.includes(':'));
  assert.equal(dataset.rows[0].guardrail.router_may_mutate_room_state, false);
});

test('topology dataset export writes json and jsonl', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-topology-ds-'));
  const result = exportRoomTopologyTrainingDataset({ chatId: 'chat-export', rootDir, events: [{ event_type: 'room_topology_learning_view', command: '/room topology', goal: 'agent topology' }] });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.files.json));
  assert.ok(fs.existsSync(result.files.jsonl));
});
