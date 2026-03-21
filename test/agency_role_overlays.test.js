import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgencyRoleOverlay, buildAgencyRoleOverlayPromptBlock } from '../src/domain/agency_role_overlays.js';
import { normalizeTeamStructureV2, buildRuntimeExecutionProfileFromStructureV2 } from '../src/shared/team_structure_v2.js';

test('normalizeAgencyRoleOverlay keeps core overlay fields', () => {
  const overlay = normalizeAgencyRoleOverlay({
    overlay_id: 'agency:engineering/frontend-developer',
    display: { title: 'Frontend Developer', summary: 'UI builder' },
    classification: { canonical_role_id: 'builder', preferred_archetypes: ['implementation'], tags: ['frontend'] },
    overlay: {
      identity_line: 'Build accessible UI.',
      mission_points: ['Implement responsive views'],
      critical_rules: ['Preserve accessibility'],
      workflow_steps: ['Inspect current UI'],
      deliverable_checks: ['Files changed are explicit'],
    },
  });
  assert.equal(overlay?.classification.canonical_role_id, 'builder');
  assert.match(buildAgencyRoleOverlayPromptBlock(overlay), /Frontend Developer/);
  assert.match(buildAgencyRoleOverlayPromptBlock(overlay), /critical_rule: Preserve accessibility/);
});

test('team structure runtime snapshot preserves agency overlay metadata', () => {
  const structure = normalizeTeamStructureV2({
    participants: [
      {
        participant_id: 'builder',
        role: 'builder',
        name: 'Builder',
        metadata: {
          agency_overlay_id: 'agency:engineering/frontend-developer',
          agency_overlay: {
            overlay_id: 'agency:engineering/frontend-developer',
            display: { title: 'Frontend Developer' },
            classification: { canonical_role_id: 'builder' },
            overlay: { identity_line: 'Build accessible UI.' },
          },
        },
      },
    ],
  });
  const runtime = buildRuntimeExecutionProfileFromStructureV2(structure);
  assert.equal(runtime.runtime_participants?.[0]?.agency_overlay_id, 'agency:engineering/frontend-developer');
  assert.equal(runtime.configured_agents?.[0]?.agency_overlay?.display?.title, 'Frontend Developer');
});
