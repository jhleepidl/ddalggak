import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compactTaskText } from '../src/application/telegram_chat_execution.js';
import { Jobs } from '../src/jobs.js';
import { LocalContextEngine } from '../src/runtime_capabilities/context_engines/local_engine.js';

test('compactTaskText preserves critical directives when truncating', () => {
  const huge = [
    '[ROLE]\nBuilder role context',
    'A'.repeat(2600),
    '[CONTEXT]\n[CURRENT TASK PACKET]\n- Baseline objective: "롤 칼바람 아수라장 companion app"\n- Latest user request: "아레나 모드가 아니라 ARAM Mayhem으로 구현해"\n- Active user quotes to honor verbatim:\n1. "아레나 모드가 아니라 ARAM Mayhem이라고."\n2. "절대로 아레나 모드로 구현하지마."\n\n[ACTIVE DIRECTIVES]\n1. 아레나 모드가 아니라 ARAM Mayhem 칼바람 아수라장 모드다.\n2. 절대로 아레나 모드로 구현하지마.\n\n[RECENT TURNS]\n- user: 아레나 모드가 아니라 ARAM Mayhem이라고.\n- user: 절대로 아레나 모드로 구현하지마.\n- system: 이 제약을 다음 agent에 반영하라.',
    'Z'.repeat(1200),
  ].join('\n\n');

  const compacted = compactTaskText(huge, { maxChars: 1600 });
  assert.ok(compacted.length <= 1600);
  assert.match(compacted, /PRESERVED CRITICAL CONTEXT/);
  assert.match(compacted, /CURRENT TASK PACKET/);
  assert.match(compacted, /ARAM Mayhem/);
  assert.match(compacted, /절대로 아레나 모드로 구현하지마/);
});

test('LocalContextEngine surfaces explicit sticky directives in pinned facts for the next agent', async () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-local-directives-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'explicit directives' });
    const engine = new LocalContextEngine({ jobs });

    await engine.recordMeta({
      jobId: job.jobId,
      stepKind: 'router',
      userMessageText: '칼바람 아수라장 관련 구현을 계속 진행해.',
      stickyDirectives: [
        { text: '게임 모드는 Arena가 아니라 ARAM Mayhem이다.', pinned: true, source: 'user_pin' },
        { text: '최종 산출물에는 .exe 설치 파일이 포함되어야 한다.', pinned: true, source: 'user_pin' },
      ],
      meta: {},
      runMeta: {},
    });

    const directivesPath = path.join(job.dir, 'local_memory', 'directives.json');
    const directives = JSON.parse(fs.readFileSync(directivesPath, 'utf8'));
    assert.ok(Array.isArray(directives.items));
    assert.ok(directives.items.some((item) => /ARAM Mayhem/.test(item.text)));
    assert.ok(directives.items.some((item) => /\.exe/.test(item.text)));

    const prepared = await engine.prepareStepContext({
      jobId: job.jobId,
      stepKind: 'agent',
      roleId: 'builder',
      agentId: 'builder',
      goal: '구현과 패키징 진행',
    });

    const context = String(prepared.contextText || '');
    assert.match(context, /PINNED FACTS/);
    assert.match(context, /ARAM Mayhem/);
    assert.match(context, /\.exe 설치 파일/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('LocalContextEngine still lifts recent correction-style turns into active directives without auto-pinning them', async () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-local-corrections-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'correction directives' });
    const engine = new LocalContextEngine({ jobs });

    await engine.recordMeta({
      jobId: job.jobId,
      stepKind: 'router',
      userMessageText: '칼바람 아수라장 모드는 아레나 모드와 다른 모드야. ARAM Mayhem이라고. 혼동하지 않도록 주의해.',
      meta: {},
      runMeta: {},
    });

    const directivesPath = path.join(job.dir, 'local_memory', 'directives.json');
    const directives = JSON.parse(fs.readFileSync(directivesPath, 'utf8'));
    assert.deepEqual(directives.items, []);

    const prepared = await engine.prepareStepContext({
      jobId: job.jobId,
      stepKind: 'agent',
      roleId: 'builder',
      agentId: 'builder',
      goal: '구현 진행',
    });

    const context = String(prepared.contextText || '');
    assert.match(context, /ACTIVE DIRECTIVES/);
    assert.match(context, /ARAM Mayhem/);
    assert.doesNotMatch(context, /items: \[\]/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
