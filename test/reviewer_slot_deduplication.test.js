import test from "node:test";
import assert from "node:assert/strict";

import { buildTeamFromTemplates } from "../src/control_plane/team_builder.js";

const templates = [
  { id: "researcher", role_type: "researcher", provider: "gemini", model: "gemini", prompt: "research" },
  { id: "coder", role_type: "coder", provider: "codex", model: "codex", prompt: "code" },
  { id: "reviewer", role_type: "reviewer", provider: "gemini", model: "gemini", prompt: "review" },
];

test("ordinary code tasks emit a single generic reviewer slot", () => {
  const built = buildTeamFromTemplates({
    goal: "코드 수정 후 리뷰와 테스트 점검까지 진행해줘",
    templates,
  });

  const reviewerSlots = built.team_plan.slots.filter((slot) => slot.role_id === "reviewer");
  assert.equal(reviewerSlots.length, 1);
});

test("specialized reviewer requests can still coexist when clearly distinct", () => {
  const built = buildTeamFromTemplates({
    goal: "코드 수정 후 security review와 compliance policy review를 모두 진행해줘",
    templates,
    taskInterpretation: {
      task_type: "code_change",
      task_summary: "코드 수정 후 security review와 compliance policy review를 모두 진행해줘",
      candidate_capability_slots: [
        { role_id: "builder", purpose: "Implement the change", selection_reason: "builder" },
        { role_id: "reviewer", purpose: "Security review", preferred_skill_ids: ["security.audit"], selection_reason: "security review" },
        { role_id: "reviewer", purpose: "Compliance policy review", preferred_skill_ids: ["policy.audit"], selection_reason: "policy review" },
      ],
    },
  });

  const reviewerSlots = built.team_plan.slots.filter((slot) => slot.role_id === "reviewer");
  assert.equal(reviewerSlots.length, 2);
});
