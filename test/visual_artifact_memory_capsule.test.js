import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recordVisualArtifactCapsuleUpload,
  recordVisualArtifactCapsuleFromAgentOutput,
  loadVisualArtifactCapsules,
  formatVisualArtifactCapsuleContext,
  recordVisualArtifactExtractionResult,
  parseVisualArtifactItemsFromText,
} from '../src/application/visual_artifact_memory_capsule.js';

function makeJobDir() {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-visual-context-'));
  fs.mkdirSync(path.join(jobDir, 'workspace', 'uploads'), { recursive: true });
  return jobDir;
}

test('visual artifact context records uploads without forcing a menu capsule schema', () => {
  const jobDir = makeJobDir();
  try {
    const upload = {
      upload_kind: 'photo',
      filename: 'photo_menu_1.jpg',
      workspace_path: 'uploads/photo_menu_1.jpg',
      upload_note: '미에뜨 메뉴 1',
      sha256: 'abc',
    };
    const row = recordVisualArtifactCapsuleUpload(jobDir, upload);
    assert.ok(row);
    assert.equal(row.schema_hint, 'possible_menu_or_drink_list');
    assert.equal(row.group_label, '미에뜨 메뉴');
    assert.equal(row.status, 'available_uninterpreted');
    assert.equal(row.menu_items, undefined);

    const context = formatVisualArtifactCapsuleContext(jobDir);
    assert.match(context, /VISUAL ARTIFACT CONTEXT/);
    assert.match(context, /미에뜨 메뉴/);
    assert.match(context, /available_uninterpreted/);
    assert.match(context, /Treat upload metadata as evidence that the image exists/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('agent prose is not mined into visual memory by default', () => {
  const jobDir = makeJobDir();
  try {
    const upload = {
      upload_kind: 'photo',
      filename: 'photo_menu_1.jpg',
      workspace_path: 'uploads/photo_menu_1.jpg',
      upload_note: '미에뜨 메뉴 1',
      sha256: 'abc',
    };
    fs.writeFileSync(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'), `${JSON.stringify(upload)}\n`, 'utf8');
    recordVisualArtifactCapsuleUpload(jobDir, upload);

    const extraction = recordVisualArtifactCapsuleFromAgentOutput(
      jobDir,
      '메뉴판 기준 1픽은 **해산물 토마토 파스타 23.6 + 부라타 샐러드 21.3** 입니다.',
      { source: 'test' }
    );
    assert.equal(extraction, null);
    const capsules = loadVisualArtifactCapsules(jobDir);
    assert.equal(capsules.length, 1);
    assert.equal(capsules[0].observations.length, 0);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('visual extraction result stores contextual observations generically', () => {
  const jobDir = makeJobDir();
  try {
    const upload = {
      upload_kind: 'photo',
      filename: 'photo_menu_1.jpg',
      workspace_path: 'uploads/photo_menu_1.jpg',
      upload_note: '미에뜨 메뉴 1',
      sha256: 'abc',
    };
    fs.writeFileSync(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'), `${JSON.stringify(upload)}\n`, 'utf8');
    recordVisualArtifactCapsuleUpload(jobDir, upload);
    const parsed = parseVisualArtifactItemsFromText('해산물 토마토 파스타 23.6\n스파클링 화이트와인 글라스 9.5');
    assert.ok(parsed.observations.some((item) => /해산물 토마토 파스타/.test(item.label)));
    const row = recordVisualArtifactExtractionResult(jobDir, {
      group_label: '미에뜨 메뉴',
      schema_hint: 'menu',
      observations: [
        { label: '해산물 토마토 파스타', object_type: 'food_item', attributes: { price: '23.6' }, confidence: 0.88 },
        { label: '스파클링 화이트와인 글라스', object_type: 'drink_item', attributes: { price: '9.5' }, confidence: 0.86 },
      ],
      source_image_paths: ['uploads/photo_menu_1.jpg'],
      source: 'test_extractor',
    });
    assert.ok(row);
    const context = formatVisualArtifactCapsuleContext(jobDir);
    assert.match(context, /observations: .*\[food_item\] 해산물 토마토 파스타/);
    assert.match(context, /\[drink_item\] 스파클링 화이트와인 글라스/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
