import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recordUploadedArtifactContext,
  recordArtifactObservationFromAgentOutput,
  loadArtifactObservations,
  formatActiveArtifactContext,
} from '../src/application/artifact_context.js';

test('artifact context records upload and promotes corrected visual observations', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-artifact-context-'));
  try {
    const uploadsDir = path.join(jobDir, 'workspace', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = {
      ts: '2026-04-26T07:03:41.000Z',
      upload_kind: 'photo',
      filename: 'photo_moff9e3l_2691.jpg',
      workspace_path: 'uploads/moff9gea_2691_photo_moff9e3l_2691.jpg',
      sha256: 'abc123',
      upload_note: '음식사진 인식 테스트용 이미지',
    };
    fs.writeFileSync(path.join(uploadsDir, 'manifest.jsonl'), `${JSON.stringify(upload)}\n`, 'utf8');
    recordUploadedArtifactContext(jobDir, upload);

    const observation = recordArtifactObservationFromAgentOutput(
      jobDir,
      '아니요, 된장찌개가 아니라 햄버거와 땅콩 사진으로 보입니다. 제가 분석한 파일은 `uploads/moff9gea_2691_photo_moff9e3l_2691.jpg` 입니다.',
      { source: 'test' }
    );

    assert.ok(observation);
    assert.ok(observation.observed_labels.some((label) => /햄버거/.test(label)));
    assert.ok(observation.observed_labels.some((label) => /땅콩/.test(label)));
    assert.ok(observation.rejected_labels.some((label) => /된장찌개/.test(label)));

    const observations = loadArtifactObservations(jobDir);
    assert.ok(observations.some((row) => row.event === 'artifact_uploaded'));
    assert.ok(observations.some((row) => row.event === 'artifact_observation'));

    const context = formatActiveArtifactContext(jobDir);
    assert.match(context, /ACTIVE ARTIFACT CONTEXT/);
    assert.match(context, /햄버거/);
    assert.match(context, /땅콩/);
    assert.match(context, /rejected_previous_labels/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
