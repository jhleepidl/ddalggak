import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Jobs } from '../src/jobs.js';

function homeTempDir(prefix) {
  const root = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

test('Jobs resolves RUNS_DIR lazily when environment is configured after construction', () => {
  const root = homeTempDir('jobs-lazy-runs-dir-');
  const prior = process.env.RUNS_DIR;
  try {
    delete process.env.RUNS_DIR;
    const jobs = new Jobs();
    process.env.RUNS_DIR = root;
    const job = jobs.createJob({ title: 'lazy runs dir test' });
    assert.equal(path.dirname(job.dir), path.resolve(root));
    assert.ok(fs.existsSync(path.join(job.dir, 'meta.json')));
  } finally {
    if (prior === undefined) delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
