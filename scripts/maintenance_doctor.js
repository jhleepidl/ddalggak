#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function clean(value = '') { return String(value ?? '').trim(); }
function exists(filePath = '') { try { return Boolean(filePath) && fs.existsSync(filePath); } catch { return false; } }
function readText(filePath = '') { try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; } }

function checkPattern({ root, file, pattern, message, level = 'warning' }) {
  const filePath = path.join(root, file);
  const text = readText(filePath);
  const matched = pattern.test(text);
  return { name: file, ok: !matched, level, message, matched };
}

function checkExists({ root, file, message, level = 'required' }) {
  return { name: file, ok: exists(path.join(root, file)), level, message, matched: false };
}

function checkExistsAny({ root, files = [], name, message, level = 'required' }) {
  const ok = files.some((file) => exists(path.join(root, file)));
  return { name: name || files[0] || 'file', ok, level, message, matched: false };
}

function readPackageScripts(root) {
  try {
    const parsed = JSON.parse(readText(path.join(root, 'package.json')) || '{}');
    return parsed && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function checkScript({ root, script, message, level = 'recommended' }) {
  const scripts = readPackageScripts(root);
  return { name: `npm:${script}`, ok: Boolean(scripts[script]), level, message, matched: !scripts[script] };
}

export function runMaintenanceDoctor({ cwd = process.cwd() } = {}) {
  const root = path.resolve(clean(cwd) || process.cwd());
  const checks = [
    checkExistsAny({
      root,
      name: 'docs/guides/AGENCY_FIRST_GUIDE.md',
      files: ['docs/guides/AGENCY_FIRST_GUIDE.md', 'AGENCY_FIRST_GUIDE.md'],
      message: 'Agency-first 운영 초점 문서가 docs/guides 아래에 있어야 합니다.',
    }),
    checkExistsAny({
      root,
      name: 'docs/guides/TRACE_HANDOFF_GUIDE.md',
      files: ['docs/guides/TRACE_HANDOFF_GUIDE.md', 'TRACE_HANDOFF_GUIDE.md'],
      message: 'trace handoff 문서가 docs/guides 아래에 있어야 수동 디버깅 루프가 안정적입니다.',
    }),
    checkScript({ root, script: 'trace:doctor', message: 'trace 설정 점검 스크립트가 package.json에 연결되어야 합니다.' }),
    checkScript({ root, script: 'trace:bundle', message: 'trace handoff bundle 생성 스크립트가 package.json에 연결되어야 합니다.' }),
    checkScript({ root, script: 'agency:doctor', message: 'agency-first 설정 점검 스크립트가 package.json에 연결되어야 합니다.' }),
    checkPattern({
      root,
      file: 'src/adapters/telegram/commands.js',
      pattern: /legacyMode\s*=\s*false|cmd\s*===\s*['"]\/sendfile['"]\s*\?/,
      message: '제거된 Telegram legacy artifact path가 main command handler에 남아 있습니다.',
    }),
    checkPattern({
      root,
      file: 'README.md',
      pattern: /\/outputs \[limit\].*legacy alias|\/sendfile <relative_path>.*legacy alias/i,
      message: 'README가 제거된 /outputs 또는 /sendfile alias를 활성 alias처럼 설명합니다.',
    }),
  ];
  const failedRequired = checks.filter((row) => row.level === 'required' && !row.ok).length;
  const warnings = checks.filter((row) => row.level !== 'required' && !row.ok).length;
  const lines = [
    `Maintenance doctor: ${failedRequired === 0 ? 'ok' : 'needs attention'}`,
    `required_failed=${failedRequired} warnings=${warnings}`,
    '',
  ];
  for (const row of checks) {
    const mark = row.ok ? '✅' : (row.level === 'required' ? '❌' : '⚠️');
    lines.push(`${mark} ${row.name} [${row.level}]`);
    lines.push(`   ${row.message}`);
  }
  return { ok: failedRequired === 0, failed_required: failedRequired, warnings, checks, output: `${lines.join('\n')}\n` };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = runMaintenanceDoctor();
  process.stdout.write(result.output);
  process.exit(result.ok ? 0 : 1);
}
