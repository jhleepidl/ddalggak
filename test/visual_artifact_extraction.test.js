import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runBoundedVisualArtifactExtraction, summarizeVisualArtifactExtractionState } from '../src/application/visual_artifact_extraction.js';

function makeJobDir() {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-visual-extract-'));
  fs.mkdirSync(path.join(jobDir, 'workspace', 'uploads'), { recursive: true });
  return jobDir;
}

test('bounded visual extraction records extractor output into generic visual context state', async () => {
  const jobDir = makeJobDir();
  try {
    const upload = { upload_kind: 'photo', filename: 'menu.jpg', workspace_path: 'uploads/menu.jpg', upload_note: '미에뜨 메뉴 1' };
    fs.writeFileSync(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'), `${JSON.stringify(upload)}\n`, 'utf8');
    const result = await runBoundedVisualArtifactExtraction({
      jobDir,
      uploadRecord: upload,
      extractor: async () => ({ schema_hint: 'menu', observations: [{ label: '부라타 샐러드', object_type: 'food_item', attributes: { price: '21.3' } }, { label: 'Anna Spinato Pinot Grigio', object_type: 'drink_item', attributes: { price: '55.0' } }] }),
    });
    assert.equal(result.status, 'extracted');
    const state = summarizeVisualArtifactExtractionState(jobDir);
    assert.equal(state.extracted_count, 1);
    assert.ok(state.latest_visual_contexts[0].observations.some((item) => /부라타/.test(item.label)));
    assert.ok(state.latest_visual_contexts[0].observations.some((item) => /Pinot Grigio/.test(item.label)));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
