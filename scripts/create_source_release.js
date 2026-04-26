#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const outDir = path.resolve(process.argv[2] || '/tmp/ddalggak_release');
const version = process.argv[3] || new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const excludes = ['.git/', 'node_modules/', 'runs/', '.self_improve/', 'coverage/', '*.zip', '*.tar.gz', '*.tgz', '*.log', '.env', '.env.*'];
const liteExcludes = [...excludes, 'test_fixtures/', 'package-lock.json'];
fs.mkdirSync(outDir, { recursive: true });
function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function zip(name, extraExcludes = []) {
  const target = path.join(outDir, name);
  try { fs.unlinkSync(target); } catch {}
  run('zip', ['-qr', target, '.', ...extraExcludes.flatMap((item) => ['-x', item])]);
  return target;
}
const full = zip(`ddalggak_${version}_full_source.zip`, excludes);
const lite = zip(`ddalggak_${version}_runtime_lite.zip`, liteExcludes);
const manifest = { created_at: new Date().toISOString(), root, outputs: { full, lite }, note: 'runtime_lite excludes test_fixtures and package-lock to reduce download size.' };
fs.writeFileSync(path.join(outDir, `ddalggak_${version}_release_manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(manifest, null, 2));
