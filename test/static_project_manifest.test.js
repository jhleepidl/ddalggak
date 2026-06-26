import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProjectManifestImportBundle,
  buildRoomPackageFromProjectManifest,
  buildStaticManifestContextBlock,
  parseProjectManifest,
} from '../src/application/static_project_manifest.js';

const SAMPLE = `# Strategy Project Guide

## Overview
- This project tracks enterprise competitors and customer needs.

## Architecture
- Keep strategy notes separate from private customer records.

## Commands
- npm test
- npm run build

## Review Checklist
- Verify claims before promoting them to long-term memory.

## Do Not
- Do not copy credentials or private customer records.
`;

test('parseProjectManifest extracts reusable static guidance categories', () => {
  const manifest = parseProjectManifest({ filename: 'CLAUDE.md', content: SAMPLE });
  assert.equal(manifest.kind, 'static_project_manifest_v1');
  assert.equal(manifest.manifest_type, 'claude_md');
  assert.ok(manifest.sections.some((section) => section.category === 'commands'));
  assert.ok(manifest.policies.review_checklist.length >= 1);
  assert.equal(manifest.import_boundary.copies_private_memory, false);
});

test('static manifest can become a room package candidate without private memory', () => {
  const manifest = parseProjectManifest({ filename: 'CLAUDE.md', content: SAMPLE });
  const pkg = buildRoomPackageFromProjectManifest(manifest, { roomId: 'strategy' });
  assert.equal(pkg.kind, 'shared_room_package_v1');
  assert.equal(pkg.safety_report.copies_private_memory, false);
  assert.ok(pkg.memory_schema.object_types.includes('commands'));
  assert.ok(pkg.tags.includes('static_manifest'));
});

test('manifest import bundle discovers CLAUDE.md from a project directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-import-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), SAMPLE, 'utf8');
  const bundle = buildProjectManifestImportBundle({ rootDir: dir, roomId: 'r1' });
  assert.deepEqual(bundle.discovered_files, ['CLAUDE.md']);
  assert.equal(bundle.room_package_candidates.length, 1);
  assert.equal(bundle.room_memory_static_manifest_treatment[0].treatment_id, 'B1_static_project_manifest');
  const block = buildStaticManifestContextBlock(bundle.manifests[0]);
  assert.match(block, /static_project_manifest/);
});
