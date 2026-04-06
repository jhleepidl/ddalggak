import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoleSurfaceAclSummary } from '../src/knowledge_base/runtime.js';

const profile = {
  profile_id: 'impl_test',
  display_name: 'Impl Test',
  docs: [
    { doc_id: 'plan', surface_id: 'plan', file_name: 'plan.md', title: 'Plan', purpose: 'Plan', target_roles: ['builder'], load_policy: 'always', write_policy: 'shared' },
    { doc_id: 'research', surface_id: 'research', file_name: 'research.md', title: 'Research', purpose: 'Research', target_roles: ['researcher', 'reviewer'], load_policy: 'on_demand', write_policy: 'append_only' },
    { doc_id: 'final_answer', surface_id: 'final_answer', file_name: 'final_answer.md', title: 'Final', purpose: 'Final', target_roles: ['synthesizer'], load_policy: 'on_demand', write_policy: 'final' },
    { doc_id: 'artifact_index', surface_id: 'artifact_index', file_name: 'artifact_index.md', title: 'Artifacts', purpose: 'Artifacts', target_roles: ['builder'], load_policy: 'on_demand', write_policy: 'index' },
  ],
};

test('role surface acl summary lists reads writes and publish targets per role', () => {
  const summary = buildRoleSurfaceAclSummary({
    profile,
    agents: [
      { role: 'builder', provider: 'codex' },
      { role: 'synthesizer', provider: 'chatgpt' },
    ],
  });
  const builder = summary.find((row) => row.role_id === 'builder');
  const synthesizer = summary.find((row) => row.role_id === 'synthesizer');
  assert.ok(builder);
  assert.ok(builder.read_surface_ids.includes('plan'));
  assert.ok(builder.publish_surface_ids.includes('artifact_index'));
  assert.equal(builder.can_publish_artifact_index, true);
  assert.ok(synthesizer);
  assert.ok(synthesizer.publish_surface_ids.includes('final_answer'));
  assert.equal(synthesizer.can_publish_final_answer, true);
});
