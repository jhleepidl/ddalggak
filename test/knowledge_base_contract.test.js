import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildChatGPTNextStepPrompt } from '../src/prompts.js';
import { deriveKnowledgeBaseProfile } from '../src/knowledge_base/profile.js';
import {
  buildAgentKnowledgeBaseGuidance,
  KNOWLEDGE_BASE_CONTRACT_FILE,
} from '../src/knowledge_base/runtime.js';
import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';

test('tracking init writes stable KB contract files alongside dynamic docs', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-kb-contract-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'kb contract test' });
    const profile = deriveKnowledgeBaseProfile({ goal: 'Implement code changes and patch the repository' });
    tracking.init(job.jobId, profile);

    const sharedDir = path.join(job.dir, 'shared');
    const contractPath = path.join(sharedDir, KNOWLEDGE_BASE_CONTRACT_FILE);
    assert.equal(fs.existsSync(contractPath), true);
    assert.match(fs.readFileSync(contractPath, 'utf8'), /implementation_blueprint\.md/);
    assert.match(fs.readFileSync(contractPath, 'utf8'), /knowledge_base_profile\.json/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('agent KB guidance prefers concrete dynamic filenames and stable memory files', () => {
  const profile = deriveKnowledgeBaseProfile({ goal: 'Implement code changes and patch the repository' });
  const guidance = buildAgentKnowledgeBaseGuidance({
    profile,
    sharedDir: '/tmp/run/shared',
    provider: 'codex',
    roleId: 'builder',
    agentId: 'coder',
  });

  assert.match(guidance, /implementation_blueprint\.md/);
  assert.match(guidance, /change_log\.md/);
  assert.match(guidance, /artifact_manifest\.md/);
  assert.match(guidance, /knowledge_base_contract\.md/);
  assert.match(guidance, /목록에 없는 tracking 파일명을 추측하거나 invent 하지 마라/);
});

test('ChatGPT next-step prompt uses concrete KB filenames for track_append examples', () => {
  const profile = deriveKnowledgeBaseProfile({ goal: 'Implement code changes and patch the repository' });
  const prompt = buildChatGPTNextStepPrompt({
    jobId: 'job_123',
    goal: 'Patch the repo',
    question: '다음 단계 계획을 정리해줘',
    contextDocsText: 'ctx',
    convoText: 'convo',
    knowledgeBaseProfile: profile,
  });

  assert.match(prompt, /"doc":"implementation_blueprint\.md"/);
  assert.match(prompt, /plan -> implementation_blueprint\.md/);
  assert.match(prompt, /research -> codebase_findings\.md/);
});
