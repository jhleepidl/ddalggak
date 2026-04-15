import test from "node:test";
import assert from "node:assert/strict";

import { resolveRoleScopedReadAccess } from "../src/application/telegram_runtime_io.js";

test("orchestrator projection access maps planner/system roles onto operator-scoped reads", () => {
  const profile = {
    profile_id: 'general_execution',
    display_name: 'General Execution',
    docs: [
      { doc_id: 'plan', surface_id: 'plan', file_name: 'implementation_blueprint.md', title: 'Implementation Blueprint', purpose: 'plan', target_roles: ['builder', 'operator'] },
      { doc_id: 'research', surface_id: 'research', file_name: 'codebase_findings.md', title: 'Codebase Findings', purpose: 'research', target_roles: ['researcher', 'builder', 'reviewer'] },
      { doc_id: 'decisions', surface_id: 'decisions', file_name: 'design_decisions.md', title: 'Design Decisions', purpose: 'decisions', target_roles: ['reviewer', 'synthesizer', 'operator'] },
    ],
  };

  const access = resolveRoleScopedReadAccess({
    profile,
    provider: 'system',
    roleId: 'planner',
    fallbackDocIds: ['research', 'plan', 'decisions'],
  });

  assert.equal(access.requestedRoleId, 'planner');
  assert.equal(access.effectiveRoleId, 'operator');
  assert.ok(access.enforcement.read_surface_ids.includes('plan'));
  assert.ok(access.enforcement.read_surface_ids.includes('decisions'));
  assert.ok(access.docNames.some((entry) => /implementation_blueprint|plan/i.test(entry)));
});
