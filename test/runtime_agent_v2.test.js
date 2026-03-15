import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRuntimeAgentInstance } from "../src/domain/runtime_agent.js";
import { buildRuntimeRolePayload } from "../src/application/runtime_metadata.js";

test("runtime agent v2 normalizes legacy runtime worker fields into canonical shape", () => {
  const agent = normalizeRuntimeAgentInstance({
    runtimeInstanceId: "inst_legacy_coder_1",
    templateId: "Coder",
    roleLabel: "Coder",
    attachedSkills: [{
      skillId: "SKILL.RUN_TRACE_DEBUGGING.V1",
      selectedBy: "manual",
      loadLevel: "instructions",
      status: "selected",
    }],
    contextPackId: "ctxp_1",
    selectionReason: "legacy coder",
  });

  assert.equal(agent.instance_id, "inst_legacy_coder_1");
  assert.equal(agent.role_id, "builder");
  assert.equal(agent.role_label, "coder");
  assert.equal(agent.template_id, "coder");
  assert.equal(agent.attached_skill_ids[0], "skill.run_trace_debugging.v1");
  assert.equal(agent.context_pack_id, "ctxp_1");
});

test("runtime role payload exposes v2 runtime-agent fields additively", () => {
  const payload = buildRuntimeRolePayload({
    runtimeInstanceId: "inst_legacy_coder_1",
    templateId: "Coder",
    roleLabel: "Coder",
    attachedSkills: [{
      skillId: "SKILL.RUN_TRACE_DEBUGGING.V1",
      selectedBy: "manual",
      loadLevel: "instructions",
      status: "selected",
    }],
    selectionReason: "legacy coder",
  });

  assert.equal(payload.role_id, "builder");
  assert.equal(payload.role_label, "coder");
  assert.ok(payload.attached_skill_ids.includes("skill.run_trace_debugging.v1"));
  assert.equal(payload.selection_reason, "legacy coder");
});
