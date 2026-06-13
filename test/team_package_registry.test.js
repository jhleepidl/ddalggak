import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSharedTeamPackageFromManifest,
  saveSharedTeamPackageToRegistry,
  readSharedTeamPackageRegistry,
  findSharedTeamPackage,
  forkSharedTeamPackage,
  buildInstallManifestFromSharedTeamPackage,
  formatSharedTeamPackage,
  formatSharedTeamPackageRegistry,
} from '../src/application/team_package_registry.js';

const manifest = {
  blueprint: {
    title: 'Paper Research Campaign Team',
    description: 'A staged team for literature review and paper drafting.',
    topology: { pattern: 'staged_research_team', execution_pattern: 'stage_gate', final_participant_id: 'writer' },
    memory_plan: {
      surfaces: [
        { surface_id: 'public_sources', title: 'Public sources', visibility: 'public', semantic_slots: ['source', 'evidence'] },
        { surface_id: 'user_private_notes', title: 'User private notes', semantic_slots: ['user', 'private'], content: 'personal token secret' },
        { surface_id: 'draft_schema', title: 'Draft schema', semantic_slots: ['outline', 'claims'] },
      ],
    },
  },
  team: {
    team_name: 'Paper Research Campaign Team',
    task_brief: 'Write a survey paper with evidence checkpoints.',
    credentials: { OPENAI_API_KEY: 'should-not-copy' },
    provider_state: { session: 'should-not-copy' },
    agents: [
      { agent_id: 'researcher', name: 'Researcher', role: 'researcher', purpose: 'Collect sources.' },
      { agent_id: 'writer', name: 'Writer', role: 'synthesizer', purpose: 'Draft sections.' },
      { agent_id: 'verifier', name: 'Verifier', role: 'reviewer', purpose: 'Check citations.' },
    ],
    memory_plan: {
      surfaces: [
        { surface_id: 'public_sources', title: 'Public sources', visibility: 'public', semantic_slots: ['source', 'evidence'] },
        { surface_id: 'user_private_notes', title: 'User private notes', semantic_slots: ['user', 'private'], content: 'personal token secret' },
        { surface_id: 'draft_schema', title: 'Draft schema', semantic_slots: ['outline', 'claims'] },
      ],
    },
  },
};

test('shared team package keeps reusable contract but excludes private memory and credentials', () => {
  const pkg = buildSharedTeamPackageFromManifest(manifest, { packageId: 'paper_team', visibility: 'public', status: 'published' });
  assert.equal(pkg.kind, 'shared_team_package_v1');
  assert.equal(pkg.package_id, 'paper_team');
  assert.equal(pkg.visibility, 'public');
  assert.equal(pkg.status, 'published');
  assert.equal(pkg.clone_policy.private_memory, 'fresh_on_clone');
  assert.equal(pkg.clone_policy.credential_binding, 'never_copy');
  assert.equal(pkg.memory_contract.copies_private_memory, false);
  assert.ok(pkg.memory_contract.optional_knowledge_packs.some((row) => row.surface_id === 'public_sources'));
  assert.ok(pkg.memory_contract.private_exclusions.some((row) => row.surface_id === 'user_private_notes'));
  assert.ok(!JSON.stringify(pkg).includes('should-not-copy'));
  assert.ok(!JSON.stringify(pkg.team_seed).includes('personal token secret'));
});

test('shared team package registry can save, read, find, and fork packages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-package-registry-'));
  const registryPath = path.join(dir, 'registry.json');
  const pkg = buildSharedTeamPackageFromManifest(manifest, { packageId: 'paper_team', visibility: 'public', status: 'published' });
  const saved = saveSharedTeamPackageToRegistry(pkg, { registryPath });
  assert.equal(saved.package.package_id, 'paper_team');
  const registry = readSharedTeamPackageRegistry({ registryPath });
  assert.equal(registry.packages.length, 1);
  assert.equal(findSharedTeamPackage('paper_team', { registryPath }).title, 'Paper Research Campaign Team');
  const forked = forkSharedTeamPackage('paper_team', { registryPath, packageId: 'paper_team_fork' });
  assert.equal(forked.lineage.parent_package_id, 'paper_team');
  saveSharedTeamPackageToRegistry(forked, { registryPath });
  const text = formatSharedTeamPackageRegistry(readSharedTeamPackageRegistry({ registryPath }));
  assert.match(text, /paper_team_fork/);
});

test('shared team package install manifest starts with fresh private memory policy', () => {
  const pkg = buildSharedTeamPackageFromManifest(manifest, { packageId: 'paper_team' });
  const installManifest = buildInstallManifestFromSharedTeamPackage(pkg);
  assert.equal(installManifest.source, 'shared_team_package');
  assert.equal(installManifest.team.package_id, 'paper_team');
  assert.equal(installManifest.team.clone_policy.private_memory, 'fresh_on_clone');
  assert.equal(installManifest.blueprint.clone_policy.credential_binding, 'never_copy');
  const formatted = formatSharedTeamPackage(pkg, { detail: true });
  assert.match(formatted, /fresh_private_on_clone/);
  assert.match(formatted, /Private exclusions:/);
});
