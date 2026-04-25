import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runMaintenanceDoctor } from '../scripts/maintenance_doctor.js';

function write(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('maintenance doctor catches stale Telegram artifact legacy branches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-doctor-'));
  write(path.join(root, 'AGENCY_FIRST_GUIDE.md'), 'guide');
  write(path.join(root, 'TRACE_HANDOFF_GUIDE.md'), 'guide');
  write(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'trace:doctor': 'x', 'trace:bundle': 'x', 'agency:doctor': 'x' } }));
  write(path.join(root, 'src/adapters/telegram/commands.js'), "const legacyMode = false; if (cmd === '/sendfile') {}\n");
  write(path.join(root, 'README.md'), '- `/outputs [limit]`, `/sendfile <relative_path>` : legacy alias\n');
  const result = runMaintenanceDoctor({ cwd: root });
  assert.equal(result.ok, true);
  assert.ok(result.warnings >= 2);
  assert.match(result.output, /legacy artifact path/);
});
