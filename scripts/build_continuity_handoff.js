#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { buildContinuityHandoff } from '../src/evaluation/continuity_handoff_builder.js';

function parseArgs(argv = []) {
  const out = { runs: [], sourceZips: [], evaluations: [], matrices: [], logs: [], repositories: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]; if (!token.startsWith('--')) continue;
    const key = token.slice(2); const next = argv[i + 1]; const value = !next || next.startsWith('--') ? true : (i += 1, next);
    if (key === 'run') out.runs.push(value);
    else if (key === 'source-zip') out.sourceZips.push(value);
    else if (key === 'evaluation') out.evaluations.push(value);
    else if (key === 'matrix') out.matrices.push(value);
    else if (key === 'log') out.logs.push(value);
    else if (key.startsWith('repo-')) out.repositories[key.slice(5)] = value;
    else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}
function usage() { console.log(`Usage:
  npm run continuity:handoff -- \\
    --run runs/continuity/<run-a> \\
    --run runs/continuity/<run-b> \\
    --repo-ddalggak . \\
    --repo-goc ../goc \\
    --source-zip /path/to/ddalggak-latest.zip

Optional: --evaluation <dir> --matrix <models:bench-all dir> --log <file> --out <dir> --archive <zip>`); }
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.runs.length && !args.matrices.length && !args.evaluations.length)) return usage();
  const result = await buildContinuityHandoff({
    runDirs: args.runs, outDir: args.out || '', archivePath: args.archive || '', repositories: args.repositories,
    sourceZips: args.sourceZips, evaluationDirs: args.evaluations, matrixDirs: args.matrices, logFiles: args.logs,
    probe: args.noProbe !== true, createArchive: args.noArchive !== true,
  });
  console.log(`handoff_dir=${result.output_dir}`);
  if (result.archive_path) console.log(`handoff_zip=${result.archive_path}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
