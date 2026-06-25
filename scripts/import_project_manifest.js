#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildProjectManifestImportBundle } from '../src/application/static_project_manifest.js';

function parseArgs(argv) {
  const out = { root: process.cwd(), out: '', roomId: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) out.root = argv[++i];
    else if (arg === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (arg === '--room-id' && argv[i + 1]) out.roomId = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('Usage: node scripts/import_project_manifest.js --root <project_dir> [--out bundle.json] [--room-id room]');
  process.exit(0);
}
const bundle = buildProjectManifestImportBundle({ rootDir: path.resolve(args.root), roomId: args.roomId });
const json = JSON.stringify(bundle, null, 2);
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${json}\n`, 'utf8');
} else {
  console.log(json);
}
