import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeIdleCompactionCandidate } from '../src/application/idle_compaction.js';

test('idle compaction writes a non-destructive candidate summary with artifact pins', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-idle-compaction-'));
  try {
    fs.mkdirSync(path.join(jobDir, 'workspace', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'conversation.jsonl'), [
      { ts: '2026-04-26T07:04:05Z', role: 'user', text: '방금 첨부한 이미지 확인해봐.' },
      { ts: '2026-04-26T07:08:36Z', role: 'gemini', text: '아니요, 된장찌개가 아니라 햄버거와 땅콩 사진입니다.' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'), `${JSON.stringify({ upload_kind: 'photo', filename: 'photo.jpg', workspace_path: 'uploads/photo.jpg', sha256: 'abc', upload_note: '음식사진' })}\n`, 'utf8');
    fs.writeFileSync(path.join(jobDir, 'artifact_observations.jsonl'), `${JSON.stringify({ event: 'artifact_observation', workspace_path: 'uploads/photo.jpg', observed_labels: ['햄버거', '땅콩'], rejected_labels: ['된장찌개'], status: 'verified_after_user_challenge' })}\n`, 'utf8');

    const candidate = writeIdleCompactionCandidate({ jobDir, maxChars: 4000 });
    assert.equal(candidate.destructive_changes, false);
    assert.match(candidate.summary_markdown, /ACTIVE ARTIFACT CONTEXT/);
    assert.match(candidate.summary_markdown, /햄버거/);
    assert.match(candidate.summary_markdown, /된장찌개/);
    assert.ok(fs.existsSync(path.join(jobDir, 'idle_compaction_candidates.jsonl')));
    assert.ok(fs.existsSync(path.join(jobDir, 'shared', 'idle_compaction_summary.md')));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
