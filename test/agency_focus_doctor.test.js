import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgencyFocusDoctor } from '../scripts/agency_focus_doctor.js';

test('agency doctor treats trace-first stable operation as healthy', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-doctor-'));
  const cwd = path.join(projectRoot, 'ddalggak');
  const guidePath = path.join(projectRoot, 'docs/components/ddalggak/guides/AGENCY_FIRST_GUIDE.md');
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(guidePath, 'guide', 'utf8');
  const result = runAgencyFocusDoctor({
    cwd,
    env: {
      GOC_API_BASE: 'http://127.0.0.1:8000',
      GOC_SERVICE_KEY: 'service_test',
      TELEGRAM_BOT_TOKEN: 'bot_test',
      TELEGRAM_ALLOWED_USER_IDS: '123',
      LLM_TRACE_ENABLED: 'true',
      LLM_TRACE_UNSCOPED: 'false',
      SELF_IMPROVE_DDALGGAK_AUTO_PROMOTE: 'false',
      SELF_IMPROVE_GOC_AUTO_PROMOTE: 'false',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.failed_required, 0);
  assert.match(result.output, /Agency focus doctor: ok/);
});

test('agency doctor warns when self-improve patch command is left on during trace-first mode', () => {
  const result = runAgencyFocusDoctor({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'agency-doctor-')),
    env: {
      GOC_API_BASE: 'http://127.0.0.1:8000',
      GOC_SERVICE_KEY: 'service_test',
      TELEGRAM_BOT_TOKEN: 'bot_test',
      TELEGRAM_ALLOWED_USER_IDS: '123',
      SELF_IMPROVE_DDALGGAK_PATCH_CMD: '/srv/self-improve/bin/patch-with-codex.sh ddalggak',
      SELF_IMPROVE_DDALGGAK_AUTO_PROMOTE: 'false',
      SELF_IMPROVE_GOC_AUTO_PROMOTE: 'false',
    },
  });
  assert.equal(result.ok, true);
  assert.ok(result.failed_recommended >= 1);
  assert.match(result.output, /PATCH_CMD/);
});
