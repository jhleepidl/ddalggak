import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupervisorActionSchemaLines,
  buildSupervisorRuleLines,
} from '../src/chat/supervisor_prompt_fragments.js';

test('locked supervisor prompt only lists executable locked-team actions', () => {
  const lines = buildSupervisorActionSchemaLines({ teamLocked: true, parallelSpawnAllowed: false });
  const text = lines.join('\n');
  assert.match(text, /run_agent/);
  assert.match(text, /summarize/);
  assert.doesNotMatch(text, /propose_agent/);
  assert.doesNotMatch(text, /create_agent_definition/);
  assert.doesNotMatch(text, /install_agent_blueprint/);
});

test('locked supervisor rules stay compact and preserve latest user request priority', () => {
  const lines = buildSupervisorRuleLines({ teamLocked: true, parallelSpawnAllowed: false });
  assert.ok(lines.length <= 10);
  assert.ok(lines.some((line) => line.includes('최신 user_message')));
  assert.ok(lines.every((line) => !line.includes('create_agent_definition')));
});
