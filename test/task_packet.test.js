import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateCurrentTaskPacket, loadCurrentTaskPacket, renderTaskPacket } from '../src/application/task_packet.js';

function makeJobDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-task-packet-'));
  const jobDir = path.join(root, 'job-1');
  fs.mkdirSync(path.join(jobDir, 'local_memory'), { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'shared'), { recursive: true });
  return { root, jobDir };
}

function appendTurn(jobDir, row) {
  fs.appendFileSync(path.join(jobDir, 'local_memory', 'turns.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

test('task packet keeps baseline goal while surfacing the latest user request and carry-forward quotes', () => {
  const { root, jobDir } = makeJobDir();
  try {
    appendTurn(jobDir, { role: 'user', text: '/chat 롤 칼바람 아수라장 모드 전용 companion app을 만들어줘.', ts: '2026-03-24T00:00:00.000Z' });
    appendTurn(jobDir, { role: 'assistant', text: '초기 구현 요약', ts: '2026-03-24T00:05:00.000Z' });

    const packet = updateCurrentTaskPacket({
      jobDir,
      currentUserText: '.exe 파일로 작동하고 롤 클라이언트에서 정보를 받아와 오버레이로 띄워줘.',
      persist: true,
    });

    assert.match(packet.objective_quote, /companion app/);
    assert.match(packet.latest_user_quote, /\.exe 파일/);
    assert.ok(Array.isArray(packet.phase_user_quotes));
    assert.ok(packet.phase_user_quotes.some((row) => /\.exe 파일/.test(row)));
    assert.ok(packet.carry_forward_quotes.some((row) => /companion app/.test(row)));

    const rendered = renderTaskPacket(packet, { roleId: 'builder' });
    assert.match(rendered, /CURRENT TASK PACKET/);
    assert.match(rendered, /Latest user request/);
    assert.match(rendered, /Carry-forward task context/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task packet loads GoC/operator override file and exposes it in rendered context', () => {
  const { root, jobDir } = makeJobDir();
  try {
    appendTurn(jobDir, { role: 'user', text: '/chat companion app 만들어줘', ts: '2026-03-24T00:00:00.000Z' });
    fs.mkdirSync(path.join(jobDir, 'workspace', '.orchestrator'), { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, 'workspace', '.orchestrator', 'current_task_packet.override.json'),
      JSON.stringify({ explicit_notes: ['GoC pin: overlay는 게임 창 위에 떠야 한다.'] }, null, 2),
      'utf8',
    );

    const packet = loadCurrentTaskPacket({ jobDir, refresh: true });
    const rendered = renderTaskPacket(packet, { roleId: 'builder' });

    assert.ok(Array.isArray(packet.explicit_notes));
    assert.ok(packet.explicit_notes.some((row) => /GoC pin/.test(row)));
    assert.match(rendered, /Operator \/ GoC overrides/);
    assert.match(rendered, /overlay는 게임 창 위에 떠야 한다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
