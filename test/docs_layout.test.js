import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const ddalggakRoot = path.resolve(testDir, '..');
const projectRoot = path.resolve(ddalggakRoot, '..');

const allowedTopLevelMarkdown = new Set(['AGENTS.md', 'README.md']);
const canonicalGuides = [
  'AGENCY_FIRST_GUIDE.md',
  'CODEX_MODEL_POLICY.md',
  'SELF_IMPROVEMENT_RUNTIME_GUIDE.md',
  'SKILL_AUTHORING_GUIDE.md',
  'TRACE_HANDOFF_GUIDE.md',
  'UI_USAGE_GUIDE.md',
];

test('ddalggak root does not accumulate general-purpose markdown documentation', () => {
  const markdown = fs.readdirSync(ddalggakRoot)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const unexpected = markdown.filter((name) => !allowedTopLevelMarkdown.has(name));
  assert.deepEqual(unexpected, []);
});

test('canonical ddalggak guides live under the repository docs tree', () => {
  const guideRoot = path.join(projectRoot, 'docs', 'components', 'ddalggak', 'guides');
  for (const name of canonicalGuides) {
    assert.equal(fs.existsSync(path.join(guideRoot, name)), true, `missing canonical guide: ${name}`);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'components', 'ddalggak', 'README.md')), true);
});
