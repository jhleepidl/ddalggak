import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectCapabilityGapsFromExecution,
  detectTeamCapabilityGaps,
  formatCapabilityGapLines,
} from '../src/application/capability_gap_detector.js';
import { SkillRegistryV2 as SkillRegistry } from '../src/catalog/skill_registry_v2.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

test('detectCapabilityGapsFromExecution extracts missing tool and credential requirements', () => {
  const gaps = detectCapabilityGapsFromExecution({
    outputs: [
      { agentId: 'Notebook Builder', output: "Tool 'write_file' not found. Please provide OPENAI_API_KEY." },
    ],
  });

  assert.ok(gaps.some((gap) => gap.kind === 'missing_tool' && gap.tool_id === 'write_file'));
  assert.ok(gaps.some((gap) => gap.kind === 'missing_credential' && /OPENAI_API_KEY|API_KEY/.test(gap.credential_key)));

  const lines = formatCapabilityGapLines(gaps, { maxLines: 4 });
  assert.ok(lines.some((line) => /write_file/.test(line)));
  assert.ok(lines.some((line) => /API_KEY/.test(line)));
});

test('detectTeamCapabilityGaps flags notebook builders without workspace_fs', () => {
  const registry = new SkillRegistry({ skillsDir: path.resolve(process.cwd(), 'skills') });
  registry.load({ refresh: true });

  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Notebook Builder',
          role: 'builder',
          purpose: 'Jupyter notebook 실습과 과제를 구현한다',
          recommended_tool_ids: ['workspace_fs'],
        },
      ],
    },
    runtime: { availableToolIds: [] },
    skillRegistry: registry,
  });

  assert.ok(gaps.some((gap) => gap.kind === 'missing_tool' && gap.tool_id === 'workspace_fs'));
});


test('detectCapabilityGapsFromExecution ignores benign API key mentions in notebook guidance', () => {
  const gaps = detectCapabilityGapsFromExecution({
    outputs: [
      { agentId: 'Notebook Builder', output: 'Suggested validation: set OPENAI_API_KEY and re-run the demo notebook if you want to test live responses.' },
    ],
  });

  assert.equal(gaps.some((gap) => gap.kind === 'missing_credential'), false);
});

test('detectTeamCapabilityGaps treats codex workspace-write as provider-backed workspace capability', () => {
  const registry = new SkillRegistry({ skillsDir: path.resolve(process.cwd(), 'skills') });
  registry.load({ refresh: true });

  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Notebook Builder',
          role: 'builder',
          provider: 'codex',
          purpose: 'Jupyter notebook artifacts and code patches',
          recommended_tool_ids: ['workspace_fs'],
        },
      ],
      runtime_execution: {
        providers: {
          codex: {
            sandbox_mode: 'workspace-write',
            approval_policy: 'never',
          },
        },
      },
    },
    runtime: {
      availableToolIds: [],
      activeTeamConfig: {
        agents: [
          {
            name: 'Notebook Builder',
            role: 'builder',
            provider: 'codex',
            recommended_tool_ids: ['workspace_fs'],
          },
        ],
        runtime_execution: {
          providers: {
            codex: {
              sandbox_mode: 'workspace-write',
              approval_policy: 'never',
            },
          },
        },
      },
    },
    skillRegistry: registry,
  });

  assert.equal(gaps.some((gap) => gap.kind === 'missing_tool' && gap.tool_id === 'workspace_fs'), false);
});


test('detectTeamCapabilityGaps distinguishes required and optional tools', () => {
  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Builder',
          role: 'builder',
          purpose: '웹 서비스 구현',
          required_tool_ids: ['workspace_fs'],
          optional_tool_ids: ['shell'],
        },
      ],
    },
    runtime: { availableToolIds: [] },
  });

  assert.ok(gaps.some((gap) => gap.tool_id === 'workspace_fs' && gap.severity === 'blocking'));
  assert.ok(gaps.some((gap) => gap.tool_id === 'shell' && gap.severity === 'advisory'));
});


test('detectTeamCapabilityGaps treats local job-bound runtimes as workspace capable', () => {
  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Builder',
          role: 'builder',
          purpose: '코드와 파일을 수정한다',
          required_tool_ids: ['workspace_fs'],
        },
      ],
    },
    runtime: {
      mode: 'local',
      jobId: 'job-123',
      availableToolIds: [],
      toolsCatalog: [],
    },
  });

  assert.equal(gaps.some((gap) => gap.tool_id === 'workspace_fs' && gap.kind === 'missing_tool'), false);
});

test('detectTeamCapabilityGaps keeps optional file tools advisory for non-build agents', () => {
  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Researcher',
          role: 'researcher',
          purpose: '코드베이스를 읽고 구조를 파악한다',
          optional_tool_ids: ['workspace_fs', 'write_file'],
        },
      ],
    },
    runtime: { availableToolIds: [] },
  });

  assert.equal(gaps.every((gap) => gap.severity === 'advisory'), true);
});


test('detectTeamCapabilityGaps surfaces structured skill package credentials and adapters', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gap-structured-'));
  const skillDir = path.join(tmpRoot, 'srt_booking');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({
    id: 'skill.kskill_srt_booking.v1',
    name: 'k-skill SRT Booking',
    execution_adapter: {
      kind: 'python_cli',
      runtime_capabilities_required: ['shell_exec'],
    },
    credential_requirements: [
      { key: 'KSKILL_SRT_ID', required: true },
      { key: 'KSKILL_SRT_PASSWORD', required: true },
    ],
    side_effect_level: 'transactional',
  }, null, 2));
  const registry = new SkillRegistry({ skillsDir: tmpRoot });
  registry.load({ refresh: true });

  const gaps = detectTeamCapabilityGaps({
    team: {
      agents: [
        {
          name: 'Travel Operator',
          role: 'operator',
          attached_skill_ids: ['skill.kskill_srt_booking.v1'],
        },
      ],
    },
    runtime: { availableToolIds: [] },
    skillRegistry: registry,
  });

  assert.ok(gaps.some((gap) => gap.kind === 'missing_tool' && gap.tool_id === 'shell'));
  assert.ok(gaps.some((gap) => gap.kind === 'missing_credential' && gap.credential_key === 'KSKILL_SRT_ID'));
  assert.ok(gaps.some((gap) => gap.kind === 'missing_credential' && gap.credential_key === 'KSKILL_SRT_PASSWORD'));
});
