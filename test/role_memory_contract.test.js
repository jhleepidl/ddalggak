import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeKnowledgeBaseProfile } from '../src/knowledge_base/profile.js';
import { buildRoleMemoryContract, pickRoleWriteTarget, buildAgentKnowledgeBaseGuidance } from '../src/knowledge_base/runtime.js';

const profile = normalizeKnowledgeBaseProfile({
  profile_id: 'implementation_memory_plan',
  display_name: 'Implementation KB',
  docs: [
    { doc_id: 'plan', surface_id: 'mission_brief', file_name: 'mission_brief.md', load_policy: 'always', write_policy: 'shared', target_roles: ['builder', 'reviewer'] },
    { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
    { doc_id: 'research', surface_id: 'defect_log', file_name: 'defect_log.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['reviewer'] },
    { doc_id: 'decisions', surface_id: 'final_answer', file_name: 'final_answer.md', load_policy: 'always', write_policy: 'final', target_roles: ['synthesizer'] },
    { doc_id: 'artifacts', surface_id: 'artifact_index', file_name: 'artifact_index.md', load_policy: 'on_demand', write_policy: 'index', target_roles: ['builder', 'synthesizer'] },
  ],
});

test('normalizeKnowledgeBaseProfile resolves surface_id aliases', () => {
  assert.equal(profile.legacy_map.implementation_notes, 'implementation_notes.md');
  assert.equal(profile.legacy_map.artifact_index, 'artifact_index.md');
});

test('buildRoleMemoryContract limits writes by target_roles and write_policy', () => {
  const builder = buildRoleMemoryContract({ profile, provider: 'codex', roleId: 'builder' });
  assert.deepEqual(builder.write_docs.map((doc) => doc.surface_id), ['implementation_notes', 'artifact_index', 'mission_brief']);
  assert.equal(builder.publish_docs.map((doc) => doc.surface_id).join(','), 'artifact_index');

  const reviewer = buildRoleMemoryContract({ profile, provider: 'gemini', roleId: 'reviewer' });
  assert.ok(reviewer.read_docs.some((doc) => doc.surface_id === 'defect_log'));
  assert.ok(reviewer.write_docs.some((doc) => doc.surface_id === 'defect_log'));
  assert.ok(!reviewer.write_docs.some((doc) => doc.surface_id === 'implementation_notes'));
});

test('pickRoleWriteTarget chooses role-aware surface', () => {
  const impl = pickRoleWriteTarget({ profile, provider: 'codex', roleId: 'builder', purpose: 'implementation' });
  assert.equal(impl.target_doc?.surface_id, 'implementation_notes');

  const review = pickRoleWriteTarget({ profile, provider: 'gemini', roleId: 'reviewer', purpose: 'review' });
  assert.equal(review.target_doc?.surface_id, 'defect_log');

  const final = pickRoleWriteTarget({ profile, provider: 'codex', roleId: 'synthesizer', purpose: 'final' });
  assert.equal(final.target_doc?.surface_id, 'final_answer');
});

test('buildAgentKnowledgeBaseGuidance exposes direct write surfaces only for the role', () => {
  const guidance = buildAgentKnowledgeBaseGuidance({ profile, provider: 'codex', roleId: 'builder', agentId: 'builder_1', sharedDir: '/tmp/run/shared' });
  assert.match(guidance, /implementation_notes\.md/);
  assert.doesNotMatch(guidance, /defect_log\.md \(slot=research\):/);
  assert.match(guidance, /승격\/발행 대상:/);
});
