import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deriveKnowledgeBaseProfile } from '../src/knowledge_base/profile.js';
import { buildAgentKnowledgeBaseGuidance } from '../src/knowledge_base/runtime.js';
import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';
import { buildTeamListMessage, formatTeamProposalMessage } from '../src/application/team_configuration.js';


test('general profile uses compact working-memory layout', () => {
  const profile = deriveKnowledgeBaseProfile({ goal: '수업용 과제와 프로젝트 초안을 만들고 정리해줘' });
  assert.equal(profile.profile_id, 'general_execution');
  assert.equal(profile.docs.find((doc) => doc.doc_id === 'plan')?.file_name, 'mission_brief.md');
  assert.equal(profile.docs.find((doc) => doc.doc_id === 'research')?.file_name, 'working_memory.md');
  assert.equal(profile.docs.find((doc) => doc.doc_id === 'progress')?.file_name, 'working_memory.md');
  assert.equal(profile.docs.find((doc) => doc.doc_id === 'decisions')?.file_name, 'final_answer.md');
});


test('tracking init lazily creates only stable files and primary plan doc for compact profile', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-kb-compact-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'compact kb lazy init' });
    const profile = deriveKnowledgeBaseProfile({ goal: '강의 과제와 실습 자료를 정리해줘' });
    tracking.init(job.jobId, profile);

    const sharedDir = path.join(job.dir, 'shared');
    const filesAfterInit = fs.readdirSync(sharedDir).sort();
    assert.deepEqual(filesAfterInit, [
      'knowledge_base_contract.md',
      'knowledge_base_profile.json',
      'mission_brief.md',
    ]);

    tracking.append(job.jobId, 'research.md', '조사 내용');
    tracking.append(job.jobId, 'progress.md', '중간 진행 상황');
    tracking.append(job.jobId, 'decisions.md', '최종 결론');

    const filesAfterWrites = fs.readdirSync(sharedDir).sort();
    assert.deepEqual(filesAfterWrites, [
      'final_answer.md',
      'knowledge_base_contract.md',
      'knowledge_base_profile.json',
      'mission_brief.md',
      'working_memory.md',
    ]);
    const workingMemory = fs.readFileSync(path.join(sharedDir, 'working_memory.md'), 'utf8');
    assert.match(workingMemory, /조사 내용/);
    assert.match(workingMemory, /중간 진행 상황/);
    assert.match(fs.readFileSync(path.join(sharedDir, 'final_answer.md'), 'utf8'), /최종 결론/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});


test('non-codex providers are told to avoid direct KB file writes', () => {
  const profile = deriveKnowledgeBaseProfile({ goal: '강의 자료 설계와 과제 초안 작성' });
  const guidance = buildAgentKnowledgeBaseGuidance({
    profile,
    sharedDir: '/tmp/run/shared',
    provider: 'gemini',
    roleId: 'researcher',
    agentId: 'researcher',
  });
  assert.match(guidance, /write_file\/create_file\/save_file 같은 도구를 호출하지 말고/);
  assert.match(guidance, /working_memory\.md/);
  assert.match(guidance, /final_answer\.md/);
});


test('team messages expose memory layout to the user', () => {
  const profile = deriveKnowledgeBaseProfile({ goal: '수업용 실습 노트북과 과제를 설계해줘' });
  const team = {
    team_name: 'Notebook Course Team',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    task_brief: '수업용 실습 노트북과 과제를 설계해줘',
    knowledge_base_profile: profile,
    structure_v2: { topology: { pattern: 'sequential' } },
    agents: [
      { name: 'Researcher', role: 'researcher', purpose: '조사', provider: 'gemini', model: 'gemini-2.5-pro' },
      { name: 'Synthesizer', role: 'synthesizer', purpose: '정리', provider: 'openai', model: 'gpt-5.4' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Synthesizer', handoffs: [] },
    shortcut_policy: { enabled: true, max_turn_window: 6 },
  };
  const proposalMsg = formatTeamProposalMessage(team);
  const activeMsg = buildTeamListMessage({ active_team: team });
  assert.match(proposalMsg, /Memory layout/);
  assert.match(proposalMsg, new RegExp(profile.docs[0].file_name.replace('.', '\\.')));
  assert.match(activeMsg, /Memory layout/);
  assert.match(activeMsg, /Memory layout ·/);
});


test('team messages show base role and overlay profile together', () => {
  const team = {
    team_name: 'UI Improvement Team',
    composition_mode: 'structured',
    proposal_mode: 'suggest',
    task_brief: '프론트엔드 화면을 개선해줘',
    agents: [
      {
        name: 'Builder',
        role: 'builder',
        purpose: 'UI 구현 초안을 만든다',
        provider: 'codex',
        model: 'gpt-5-codex',
        agency_overlay_id: 'agency:engineering/frontend-developer',
        agency_overlay: { display: { title: 'Frontend Developer' } },
      },
      {
        name: 'Critic',
        role: 'reviewer',
        purpose: 'UI 품질을 검토한다',
        provider: 'chatgpt',
        model: 'gpt-5.4',
        agency_overlay_id: 'agency:engineering/code-reviewer',
        agency_overlay: { display: { title: 'Code Reviewer' } },
      },
    ],
    interaction_spec: { execution_pattern: 'builder_reviewer_loop', final_answer_owner: 'Critic', handoffs: [] },
    shortcut_policy: { enabled: true, max_turn_window: 6 },
  };
  const proposalMsg = formatTeamProposalMessage(team);
  const activeMsg = buildTeamListMessage({ active_team: team });
  if (!/역할 프로필: base=구현 · overlay=Frontend Developer/.test(proposalMsg)) throw new Error('proposal overlay profile missing');
  if (!/역할 프로필: base=검토 · overlay=Code Reviewer/.test(activeMsg)) throw new Error('active overlay profile missing');
});
