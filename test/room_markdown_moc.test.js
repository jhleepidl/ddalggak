import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomDocumentMocPack, formatRoomDocumentMocPackForTelegram, renderRoomDocumentMocPack } from '../src/application/room_markdown_moc.js';

test('room document MOC separates action records from living docs and renders indexes', () => {
  const pack = buildRoomDocumentMocPack({
    profile: {
      name: 'Research Paper Room',
      package_id: 'research_paper_factory',
      current_goal: '논문 구현과 교수님 미팅 준비',
      default_agents: ['research_scout', 'novelty_critic'],
      installed_skills: ['related_work_mapping', 'latex_outline_drafting'],
      memory_schema: { object_types: ['advisor_feedback', 'paper_outline'] },
      memory_hierarchy: ['room_profile', 'claim_ledger'],
    },
    events: [
      { ts: '2026-07-05T10:00:00Z', event_type: 'room_applied', command: '/room apply', goal: '논문 구현 방' },
      { ts: '2026-07-05T10:05:00Z', event_type: 'team_loop_task_started', command: '/loop', goal: '실험 코드 구현' },
    ],
  });
  assert.equal(pack.policy.action_dir.includes('execution'), true);
  assert.equal(pack.policy.docs_dir.includes('living'), true);
  assert.equal(pack.actions.length, 2);
  assert.ok(pack.docs.find((doc) => doc.path === 'docs/memory-hierarchy.md'));
  const md = renderRoomDocumentMocPack(pack);
  assert.match(md, /--- AGENTS\.md ---/);
  assert.match(md, /--- moc-by-date\.md ---/);
  assert.match(md, /action\//);
  assert.match(md, /docs\/room-setting\.md/);
  const text = formatRoomDocumentMocPackForTelegram(pack);
  assert.match(text, /Room Markdown MOC/);
  assert.match(text, /action\//);
  assert.match(text, /docs\//);
});
