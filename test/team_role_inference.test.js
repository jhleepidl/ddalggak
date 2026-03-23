import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTeamStructureV2, deriveTeamConfigFromStructureV2 } from '../src/shared/team_structure_v2.js';

test('normalizeTeamStructureV2 infers executable roles from participant labels when planner emits generic specialist roles', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'inference_demo' },
    participants: [
      { participant_id: 'repo_scout', name: 'Repo Scout', role: 'specialist', model: 'gemini-2.5-pro' },
      { participant_id: 'client_companion_builder', name: 'Client Companion Builder', role: 'specialist', model: 'gpt-5-codex' },
      { participant_id: 'safety_and_quality_reviewer', name: 'Safety and Quality Reviewer', role: 'specialist', model: 'gpt-5.4' },
      { participant_id: 'delivery_synthesizer', name: 'Delivery Synthesizer', role: 'specialist', model: 'gemini-3-flash-preview' },
    ],
    topology: {
      pattern: 'workflow',
      execution_pattern: 'builder_reviewer_loop',
      edges: [
        { from: 'repo_scout', to: 'client_companion_builder', kind: 'handoff', payload: 'summary_plus_key_evidence' },
        { from: 'client_companion_builder', to: 'safety_and_quality_reviewer', kind: 'handoff', payload: 'draft_plus_change_summary' },
        { from: 'safety_and_quality_reviewer', to: 'delivery_synthesizer', kind: 'handoff', payload: 'approved_summary_only' },
      ],
      final_participant_id: 'delivery_synthesizer',
    },
    control_policy: { final_answer_owner_participant_id: 'delivery_synthesizer' },
  });

  assert.deepEqual(
    structure.participants.map((row) => ({ id: row.participant_id, role: row.role })),
    [
      { id: 'repo_scout', role: 'researcher' },
      { id: 'client_companion_builder', role: 'builder' },
      { id: 'safety_and_quality_reviewer', role: 'reviewer' },
      { id: 'delivery_synthesizer', role: 'synthesizer' },
    ],
  );

  const derived = deriveTeamConfigFromStructureV2(structure);
  assert.deepEqual(
    derived.agents.map((row) => ({ id: row.agent_id, role: row.role })),
    [
      { id: 'repo_scout', role: 'researcher' },
      { id: 'client_companion_builder', role: 'builder' },
      { id: 'safety_and_quality_reviewer', role: 'reviewer' },
      { id: 'delivery_synthesizer', role: 'synthesizer' },
    ],
  );
});
