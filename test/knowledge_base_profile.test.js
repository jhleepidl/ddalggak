import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deriveKnowledgeBaseProfile, resolveKnowledgeDocName } from '../src/knowledge_base/profile.js';
import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';

test('deriveKnowledgeBaseProfile adapts filenames to implementation and deliberation goals', () => {
  const implementation = deriveKnowledgeBaseProfile({ goal: 'Implement the requested code changes in the repo' });
  assert.equal(implementation.profile_id, 'implementation_workbench');
  assert.equal(resolveKnowledgeDocName(implementation, 'plan.md'), 'implementation_blueprint.md');
  assert.equal(resolveKnowledgeDocName(implementation, 'research.md'), 'codebase_findings.md');

  const deliberation = deriveKnowledgeBaseProfile({
    goal: 'Compare options and reach committee consensus',
    teamConfig: { structure_v2: { topology: { pattern: 'committee' } } },
  });
  assert.equal(deliberation.profile_id, 'deliberation_room');
  assert.equal(resolveKnowledgeDocName(deliberation, 'decisions.md'), 'verdict_and_rationale.md');
});

test('Tracking resolves legacy doc aliases into dynamic knowledge base files', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-kb-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'kb profile test' });
    const profile = deriveKnowledgeBaseProfile({ goal: 'Implement and patch the repository code' });
    tracking.init(job.jobId, profile);

    tracking.append(job.jobId, 'plan.md', 'legacy alias write');
    tracking.append(job.jobId, 'artifacts.md', 'artifact entry');

    const planPath = path.join(job.dir, 'shared', 'implementation_blueprint.md');
    const artifactPath = path.join(job.dir, 'shared', 'artifact_manifest.md');
    assert.equal(fs.existsSync(planPath), true);
    assert.equal(fs.existsSync(artifactPath), true);
    assert.match(fs.readFileSync(planPath, 'utf8'), /legacy alias write/);
    assert.match(fs.readFileSync(artifactPath, 'utf8'), /artifact entry/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('deriveKnowledgeBaseDesign honors explicit structure knowledge surface and memory policy', async () => {
  const { deriveKnowledgeBaseDesign } = await import('../src/knowledge_base/profile.js');
  const design = deriveKnowledgeBaseDesign({
    goal: 'committee review',
    teamConfig: {
      structure_v2: {
        metadata: { team_name: 'KB Team' },
        intent: { task_brief: 'committee review' },
        topology: { pattern: 'committee' },
        knowledge_surface: {
          profile_id: 'custom_committee_kb',
          display_name: 'Custom Committee KB',
          docs: [
            { doc_id: 'plan', file_name: 'agenda.md', title: 'Agenda' },
            { doc_id: 'research', file_name: 'briefs.md', title: 'Briefs' },
            { doc_id: 'progress', file_name: 'rounds.md', title: 'Rounds' },
            { doc_id: 'decisions', file_name: 'vote_record.md', title: 'Vote Record' },
            { doc_id: 'artifacts', file_name: 'packet.md', title: 'Packet' },
          ],
        },
        memory_policy: {
          stable_semantic_slots: ['decisions', 'artifacts'],
          migration_strategy: 'semantic_slot_preserving',
        },
      },
    },
  });

  assert.equal(design.profile.profile_id, 'custom_committee_kb');
  assert.equal(design.profile.docs.find((doc) => doc.doc_id === 'decisions')?.file_name, 'vote_record.md');
  assert.deepEqual(design.memory_policy.stable_semantic_slots, ['decisions', 'artifacts']);
});

test('Tracking.reconcileProfile migrates semantic slot content to renamed KB files', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-kb-migrate-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'kb migrate test' });
    const initial = deriveKnowledgeBaseProfile({ goal: 'Implement code changes and patch the repository' });
    tracking.init(job.jobId, initial);
    tracking.append(job.jobId, 'decisions.md', 'initial decision trail');
    tracking.append(job.jobId, 'artifacts.md', 'artifact trail');

    const nextProfile = {
      profile_id: 'custom_impl',
      display_name: 'Custom Impl KB',
      docs: [
        { doc_id: 'plan', file_name: 'agenda.md', title: 'Agenda' },
        { doc_id: 'research', file_name: 'findings.md', title: 'Findings' },
        { doc_id: 'progress', file_name: 'journal.md', title: 'Journal' },
        { doc_id: 'decisions', file_name: 'final_decisions.md', title: 'Final Decisions' },
        { doc_id: 'artifacts', file_name: 'delivery_index.md', title: 'Delivery Index' },
      ],
      memory_policy: { stable_semantic_slots: ['decisions', 'artifacts'] },
    };
    const result = tracking.reconcileProfile(job.jobId, nextProfile, { migrate: true });

    assert.equal(result.migration.changed, true);
    assert.match(fs.readFileSync(path.join(job.dir, 'shared', 'final_decisions.md'), 'utf8'), /initial decision trail/);
    assert.match(fs.readFileSync(path.join(job.dir, 'shared', 'delivery_index.md'), 'utf8'), /artifact trail/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});


test('deriveKnowledgeBaseDesign collapses repeated memory plan display-name suffixes', async () => {
  const { deriveKnowledgeBaseDesign } = await import('../src/knowledge_base/profile.js');
  const design = deriveKnowledgeBaseDesign({
    goal: '내일 아침 메뉴 추천해줘.',
    teamConfig: {
      memory_plan: {
        plan_id: 'general_execution',
        display_name: 'Compact execution KB memory plan memory plan memory plan',
        strategy: 'goal_adaptive',
        surfaces: [
          { surface_id: 'plan', file_name: 'mission_brief.md', semantic_slots: ['plan'], load_policy: 'always' },
          { surface_id: 'research', file_name: 'working_memory.md', semantic_slots: ['research', 'progress'], load_policy: 'always' },
          { surface_id: 'decisions', file_name: 'final_answer.md', semantic_slots: ['decisions', 'final_answer'], write_policy: 'final' },
          { surface_id: 'artifacts', file_name: 'artifact_index.md', semantic_slots: ['artifacts', 'artifact_index'], write_policy: 'index' },
        ],
      },
    },
  });

  assert.equal(design.profile.display_name, 'Compact execution KB');
  assert.equal(design.memory_plan.display_name, 'Compact execution KB memory plan');
});
