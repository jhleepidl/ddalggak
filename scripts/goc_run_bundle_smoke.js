#!/usr/bin/env node
import { GocClient } from '../src/goc_client.js';
import { runGocRunBundleSmoke } from '../src/application/goc_run_bundle_smoke.js';

function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || '').trim();
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = String(args.apiBase || process.env.GOC_API_BASE || '').trim();
  const serviceKey = String(args.serviceKey || process.env.GOC_SERVICE_KEY || '').trim();
  const threadId = String(args.threadId || '').trim();
  const contextSetId = String(args.contextSetId || '').trim();
  const runId = String(args.runId || '').trim();
  if (!apiBase || !serviceKey || !threadId) {
    console.error(JSON.stringify({
      ok: false,
      error: 'usage: node scripts/goc_run_bundle_smoke.js --threadId <id> [--runId <id>] [--contextSetId <id>] with GOC_API_BASE and GOC_SERVICE_KEY set',
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const client = new GocClient({ apiBase, serviceKey });
  const report = await runGocRunBundleSmoke({ client, threadId, contextSetId, runId });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
