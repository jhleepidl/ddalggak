import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextEnvelope } from '../src/runtime_capabilities/context_envelope.js';

test('buildContextEnvelope keeps current task packet ahead of lower-priority context blocks and removes duplicates', () => {
  const envelope = buildContextEnvelope([
    { key: 'raw', raw: '[LEGACY]\nold summary' },
    { key: 'current_task_packet', raw: '[CURRENT TASK PACKET]\n- Goal: ship exe' },
    { key: 'role_summary', body: 'builder should implement overlay' },
    { key: 'raw', raw: '[LEGACY]\nold summary' },
    { key: 'active_directives', body: '1. Arena 전제로 구현하지 말 것.' },
  ]);

  assert.match(envelope.text, /CURRENT TASK PACKET/);
  assert.ok(envelope.text.indexOf('[CURRENT TASK PACKET]') < envelope.text.indexOf('[ROLE SUMMARY]'));
  assert.equal((envelope.text.match(/\[LEGACY\]/g) || []).length, 1);
  assert.deepEqual(envelope.section_keys.slice(0, 3), ['current_task_packet', 'active_directives', 'role_summary']);
});
