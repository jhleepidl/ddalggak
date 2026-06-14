import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runIdleStewardMaintenance } from '../src/application/idle_steward.js';

test('idle steward writes proposal-only report for memory, skills, and agent/team hygiene', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-idle-steward-root-'));
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-idle-steward-job-'));
  const oldAgentPath = process.env.AGENT_PACKAGE_REGISTRY_PATH;
  const oldTeamPath = process.env.TEAM_PACKAGE_REGISTRY_PATH;
  const oldEnabled = process.env.IDLE_STEWARD_ENABLED;
  try {
    process.env.IDLE_STEWARD_ENABLED = '1';
    const skillDir = path.join(rootDir, 'skills', 'needs-description');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({ id: 'skill.needs_description.local', name: 'Needs Description' }, null, 2));
    const configDir = path.join(rootDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const agentRegistry = path.join(configDir, 'agent_packages.json');
    const teamRegistry = path.join(configDir, 'shared_team_packages.json');
    fs.writeFileSync(agentRegistry, JSON.stringify({ kind: 'agent_package_registry_v1', packages: [{ package_id: 'empty_agent_pkg', title: 'Empty agent package', agents: [] }] }, null, 2));
    fs.writeFileSync(teamRegistry, JSON.stringify({ kind: 'shared_team_package_registry_v1', packages: [{ package_id: 'team_pkg', title: 'Team package', visibility: 'public' }] }, null, 2));
    process.env.AGENT_PACKAGE_REGISTRY_PATH = agentRegistry;
    process.env.TEAM_PACKAGE_REGISTRY_PATH = teamRegistry;

    const result = runIdleStewardMaintenance({
      jobDir,
      rootDir,
      jobId: 'job-1',
      runId: 'run-1',
      force: true,
      memoryMaintenance: {
        ok: true,
        topology: { mode: 'team_scoped', stress: { score: 3.1 } },
        candidate: { summary_path: path.join(jobDir, 'shared', 'idle_compaction_summary.md') },
      },
      minIntervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.report.destructive_changes, false);
    assert.ok(result.report.proposal_count >= 2);
    assert.ok(fs.existsSync(path.join(jobDir, 'shared', 'idle_steward_report.md')));
    assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'proposals.jsonl')));
    assert.match(fs.readFileSync(path.join(jobDir, 'shared', 'idle_steward_report.md'), 'utf8'), /proposals_only/);
  } finally {
    if (oldAgentPath === undefined) delete process.env.AGENT_PACKAGE_REGISTRY_PATH; else process.env.AGENT_PACKAGE_REGISTRY_PATH = oldAgentPath;
    if (oldTeamPath === undefined) delete process.env.TEAM_PACKAGE_REGISTRY_PATH; else process.env.TEAM_PACKAGE_REGISTRY_PATH = oldTeamPath;
    if (oldEnabled === undefined) delete process.env.IDLE_STEWARD_ENABLED; else process.env.IDLE_STEWARD_ENABLED = oldEnabled;
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
