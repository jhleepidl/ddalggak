import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamCapabilityContract, compileTeamAdmissionDecision } from '../src/application/team_capability_contract.js';

test('team admission decision defers when runtime is unbound', () => {
  const contract = buildTeamCapabilityContract({
    team: {
      agents: [{ agent_id: 'researcher', role: 'researcher', purpose: 'Research evidence', runtime_capabilities_optional: ['web_browse'] }],
    },
    runtime: null,
  });
  const decision = compileTeamAdmissionDecision(contract);
  assert.equal(decision.runtime_bound, false);
  assert.equal(decision.status, 'unbound');
  assert.equal(decision.decision, 'defer');
  assert.ok(decision.blocking_reason_codes.includes('runtime_unbound'));
});

test('team admission decision blocks when required tools are missing', () => {
  const contract = buildTeamCapabilityContract({
    team: {
      agents: [{ agent_id: 'builder', role: 'builder', purpose: 'Implement python file patch', runtime_capabilities_required: ['filesystem_write'] }],
    },
    runtime: { availableCapabilityIds: ['filesystem_read'] },
  });
  const decision = compileTeamAdmissionDecision(contract);
  assert.equal(decision.runtime_bound, true);
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.missing_required_tools.includes('workspace_fs'));
});

test('team admission decision allows degraded execution for optional gaps', () => {
  const contract = buildTeamCapabilityContract({
    team: {
      agents: [{ agent_id: 'reviewer', role: 'reviewer', purpose: 'Review evidence', runtime_capabilities_optional: ['web_browse'] }],
    },
    runtime: { availableCapabilityIds: ['filesystem_read'] },
  });
  const decision = compileTeamAdmissionDecision(contract);
  assert.equal(decision.runtime_bound, true);
  assert.equal(decision.status, 'degraded');
  assert.equal(decision.decision, 'allow');
  assert.ok(decision.degrade_reason_codes.includes('missing_optional_tools'));
});
