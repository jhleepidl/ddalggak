import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createZipBundle, resolvePythonBundleCandidates } from '../src/application/telegram_zip_bundle_io.js';

test('resolvePythonBundleCandidates prefers configured python binary first', () => {
  const prev = process.env.DDALGGAK_PYTHON_BIN;
  process.env.DDALGGAK_PYTHON_BIN = '/custom/python-bin';
  try {
    const candidates = resolvePythonBundleCandidates();
    assert.equal(candidates[0], '/custom/python-bin');
  } finally {
    if (prev === undefined) delete process.env.DDALGGAK_PYTHON_BIN;
    else process.env.DDALGGAK_PYTHON_BIN = prev;
  }
});

test('createZipBundle creates a zip archive for workspace entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-zip-'));
  const srcFile = path.join(dir, 'report.md');
  fs.writeFileSync(srcFile, '# report\n', 'utf8');
  try {
    const bundle = await createZipBundle('job_zip', [{ src: srcFile, arc: 'docs/report.md' }], { bundleDir: dir });
    assert.equal(bundle.entries.length, 1);
    assert.equal(fs.existsSync(bundle.bundlePath), true);
    const zipBytes = fs.readFileSync(bundle.bundlePath);
    assert.equal(zipBytes.slice(0, 2).toString('utf8'), 'PK');
    assert.equal(zipBytes.includes(Buffer.from('docs/report.md')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
