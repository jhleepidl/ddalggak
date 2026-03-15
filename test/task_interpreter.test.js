import test from "node:test";
import assert from "node:assert/strict";
import { interpretTask } from "../src/control_plane/task_interpreter.js";

test("task interpreter builds builder and reviewer slots for code-change tasks without emitting planner", () => {
  const interpreted = interpretTask({
    goal: "Fix the failing tests, patch the implementation, and review for regressions",
    seedInstruction: "apply a patch and verify it",
    preferredRoles: ["planner", "coder"],
  });

  assert.equal(interpreted.task_type, "code_change");
  assert.equal(interpreted.deliverable_type, "code_patch");
  assert.equal(interpreted.review_policy, "code_default");
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === "builder"));
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === "reviewer"));
  assert.equal(interpreted.candidate_capability_slots.some((slot) => slot.role_id === "deprecated_control_plane_only"), false);
  assert.equal(interpreted.suppressed_role_ids.includes("operator"), true);
});

test("task interpreter splits multi-source analysis into multiple researcher slots and synthesis", () => {
  const interpreted = interpretTask({
    goal: "Compare the latest DART filing with market news headlines and summarize them into a concise report",
    seedInstruction: "focus on filing and news sources",
  });

  const researcherSlots = interpreted.candidate_capability_slots.filter((slot) => slot.role_id === "researcher");
  assert.equal(interpreted.parallelism_preference, "parallel");
  assert.ok(researcherSlots.length >= 2);
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === "synthesizer"));
  assert.ok(interpreted.pinned_preset_ids.includes("dart_financial_researcher"));
  assert.ok(interpreted.pinned_preset_ids.includes("market_news_researcher"));
});
