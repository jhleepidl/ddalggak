import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { updateCurrentTaskPacket, renderTaskPacket } from '../src/application/task_packet.js';

function tmpJobDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-task-packet-'));
}

test('current task packet uses latest user request as active goal', () => {
  const jobDir = tmpJobDir();
  fs.mkdirSync(path.join(jobDir, 'local_memory'), { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'local_memory', 'turns.jsonl'), [
    JSON.stringify({ role: 'user', text: '내일 점심은 뭘 먹는게 좋을까?' }),
    JSON.stringify({ role: 'assistant', text: '순두부찌개 추천.' }),
  ].join('\n') + '\n');
  const packet = updateCurrentTaskPacket({
    jobDir,
    currentUserText: '혹시 저녁 메뉴에 어울리는 주류 메뉴도 메뉴 이미지 확인해서 추천해줄수있어?',
  });
  assert.match(packet.goal, /주류 메뉴/);
  assert.match(packet.latest_user_quote, /주류 메뉴/);
  assert.doesNotMatch(packet.goal, /내일 점심/);
  const rendered = renderTaskPacket(packet);
  assert.match(rendered, /Latest user request/);
  assert.match(rendered, /주류 메뉴/);
});
