#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function clean(value = '') {
  return String(value || '').trim();
}

function truthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function exists(filePath = '') {
  try { return !!filePath && fs.existsSync(filePath); } catch { return false; }
}

function existsAny(paths = []) {
  return paths.some((filePath) => exists(filePath));
}

function checkEnv({ env = process.env, cwd = process.cwd() } = {}) {
  const checks = [];
  const add = (name, ok, message, level = 'info') => checks.push({ name, ok: Boolean(ok), level, message });

  add('GoC connection', clean(env.GOC_API_BASE) && clean(env.GOC_SERVICE_KEY), 'GoC API와 service key가 있어야 agent 의사소통을 Run Studio에 투영할 수 있습니다.', 'required');
  add('LLM trace', truthy(env.LLM_TRACE_ENABLED), 'LLM_TRACE_ENABLED=true이면 문제가 생겼을 때 agent별 prompt/output을 handoff할 수 있습니다.', 'recommended');
  add('raw trace local-only', !truthy(env.LLM_TRACE_UNSCOPED), 'LLM_TRACE_UNSCOPED=false 권장: job 없는 호출까지 무제한 저장하지 않습니다.', 'recommended');
  add('auto promote off', !truthy(env.SELF_IMPROVE_DDALGGAK_AUTO_PROMOTE) && !truthy(env.SELF_IMPROVE_GOC_AUTO_PROMOTE), '현재 제품 초점은 자율 agent 관찰입니다. auto-promote는 안정화 전까지 꺼두세요.', 'required');
  add('self-improve patch optional', !clean(env.SELF_IMPROVE_DDALGGAK_PATCH_CMD) && !clean(env.SELF_IMPROVE_GOC_PATCH_CMD), 'trace-first 운영이면 PATCH_CMD는 비워두는 편이 안전합니다. 실험 때만 켜세요.', 'recommended');
  add('telegram bot', clean(env.TELEGRAM_BOT_TOKEN) && clean(env.TELEGRAM_ALLOWED_USER_IDS), 'Telegram bot token과 allowed user가 있어야 runtime을 사용자 제어 plane으로 쓸 수 있습니다.', 'required');

  const guidePaths = [
    path.resolve(cwd, '../docs/components/ddalggak/guides/AGENCY_FIRST_GUIDE.md'),
    path.join(cwd, 'docs/guides/AGENCY_FIRST_GUIDE.md'),
    path.join(cwd, 'AGENCY_FIRST_GUIDE.md'),
  ];
  add('agency guide', existsAny(guidePaths), 'docs/components/ddalggak/guides/AGENCY_FIRST_GUIDE.md가 있으면 운영자가 제품 초점을 확인할 수 있습니다.', 'info');

  const failedRequired = checks.filter((row) => row.level === 'required' && !row.ok).length;
  const failedRecommended = checks.filter((row) => row.level === 'recommended' && !row.ok).length;
  const ok = failedRequired === 0;
  return { ok, failed_required: failedRequired, failed_recommended: failedRecommended, checks };
}

export function runAgencyFocusDoctor({ env = process.env, cwd = process.cwd() } = {}) {
  const result = checkEnv({ env, cwd });
  const lines = [
    `Agency focus doctor: ${result.ok ? 'ok' : 'needs attention'}`,
    `required_failed=${result.failed_required} recommended_failed=${result.failed_recommended}`,
    '',
  ];
  for (const row of result.checks) {
    const mark = row.ok ? '✅' : (row.level === 'required' ? '❌' : '⚠️');
    lines.push(`${mark} ${row.name} [${row.level}]`);
    lines.push(`   ${row.message}`);
  }
  const output = lines.join('\n');
  return { ...result, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runAgencyFocusDoctor();
  console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}
