import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaudeCompatibleRoomEvent,
  buildClaudeCompatibleImportPreview,
  claudeEventToRoomUsageEvent,
  validateClaudeCompatibleRoomEvent,
} from '../src/application/claude_compatible_event_adapter.js';

test('buildClaudeCompatibleRoomEvent stores sanitized usage signal without raw content', () => {
  const event = buildClaudeCompatibleRoomEvent({
    source: 'claude_code',
    projectRoot: '/private/project',
    eventType: 'subagent used',
    action: 'Compare competitors and product gaps',
    subagentName: 'market_analyst',
    metadata: { prompt: 'SECRET RAW PROMPT', safe_note: 'ranked candidate' },
    outcome: { signal: 'accepted', response: 'RAW RESPONSE' },
  });
  assert.equal(event.kind, 'claude_compatible_room_event_v1');
  assert.equal(event.event_type, 'subagent_used');
  assert.equal(event.outcome.accepted, true);
  assert.equal(event.metadata.safe_note, 'ranked candidate');
  assert.equal(event.metadata.prompt, undefined);
  assert.equal(JSON.stringify(event).includes('SECRET RAW PROMPT'), false);
  assert.deepEqual(validateClaudeCompatibleRoomEvent(event), { ok: true });
});

test('claude event converts to room_usage_event_v1 for GoC/ddalggak collection', () => {
  const event = buildClaudeCompatibleRoomEvent({ action: 'run tests and review code', subagentName: 'verifier', outcome: { signal: 'retry' } });
  const usage = claudeEventToRoomUsageEvent(event);
  assert.equal(usage.kind, 'room_usage_event_v1');
  assert.equal(usage.goal, '');
  assert.equal(usage.extra.claude_compatible_event.kind, 'claude_compatible_room_event_v1');
  assert.equal(usage.recommendation.action, 'review_component_or_schema');
});

test('import preview discovers CLAUDE.md and subagent markdown as candidates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-'));
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Strategy Project\n\n## Workflow\n- Compare competitors\n- Update roadmap\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'analyst.md'), '# Market Analyst\n\n## Tool Policy\n- Use web research after approval\n', 'utf8');
  const preview = buildClaudeCompatibleImportPreview({ projectRoot: dir });
  assert.equal(preview.kind, 'claude_compatible_import_preview_v1');
  assert.ok(preview.artifact_count >= 2);
  assert.ok(preview.room_package_candidates.length >= 2);
  assert.equal(preview.collection_policy.stores_raw_files_by_default, false);
});
