import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compactTaskText } from '../src/application/telegram_chat_execution.js';
import { Jobs } from '../src/jobs.js';
import { LocalContextEngine } from '../src/runtime_capabilities/context_engines/local_engine.js';

test('compactTaskText preserves pinned facts and latest user directives when truncating', () => {
  const huge = [
    '[ROLE]\nBuilder role context',
    'A'.repeat(2600),
    '[CONTEXT]\n[PINNED FACTS]\n1. 아레나 모드가 아니라 ARAM Mayhem 칼바람 아수라장 모드다.\n2. 절대로 아레나 모드로 구현하지마.\n\n[RECENT TURNS]\n- user: 아레나 모드가 아니라 ARAM Mayhem이라고.\n- user: 절대로 아레나 모드로 구현하지마.\n- system: 이 제약을 다음 agent에 반영하라.',
    'Z'.repeat(1200),
  ].join('\n\n');

  const compacted = compactTaskText(huge, { maxChars: 1600 });
  assert.ok(compacted.length <= 1600);
  assert.match(compacted, /PRESERVED CRITICAL CONTEXT/);
  assert.match(compacted, /PINNED FACTS/);
  assert.match(compacted, /ARAM Mayhem/);
  assert.match(compacted, /절대로 아레나 모드로 구현하지마/);
});

test('LocalContextEngine pins directive-like router messages and surfaces them in agent context', async () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-local-pins-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'pin directives' });
    const engine = new LocalContextEngine({ jobs });

    await engine.recordMeta({
      jobId: job.jobId,
      stepKind: 'router',
      userMessageText: '아레나 모드가 아니라 ARAM Mayhem이라고. 절대로 아레나 모드로 구현하지마.',
      meta: {},
      runMeta: {},
    });

    const pinsPath = path.join(job.dir, 'local_memory', 'pins.json');
    const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
    assert.ok(Array.isArray(pins.items));
    assert.ok(pins.items.some((item) => /ARAM Mayhem/.test(item)));

    const prepared = await engine.prepareStepContext({
      jobId: job.jobId,
      stepKind: 'agent',
      roleId: 'builder',
      agentId: 'builder',
      goal: '구현 진행',
    });

    assert.match(String(prepared.contextText || ''), /PINNED FACTS/);
    assert.match(String(prepared.contextText || ''), /ARAM Mayhem/);
    assert.match(String(prepared.contextText || ''), /절대로 아레나 모드로 구현하지마/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
