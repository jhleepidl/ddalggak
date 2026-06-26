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


test('task interpreter does not pin KR filing preset for generic non-Korean filings tasks', () => {
  const interpreted = interpretTask({
    goal: 'Compare the latest SEC filing with market news headlines and summarize the risks',
    seedInstruction: 'focus on 10-K and earnings call materials',
  });

  assert.equal(interpreted.pinned_preset_ids.includes('dart_financial_researcher'), false);
  assert.equal(
    interpreted.candidate_capability_slots.some((slot) => (slot.preferred_skill_ids || []).includes('skill.kr_equity_analysis.v1')),
    false,
  );
});


test('task interpreter keeps delivery owner coverage for web-service software-delivery tasks', () => {
  const interpreted = interpretTask({
    goal: '웹 서비스 개발을 하고 싶어. 프론트엔드와 백엔드 API 구현 결과를 최종 전달용으로 정리해줘',
    seedInstruction: 'builder, reviewer, final handoff가 필요하다',
  });

  assert.equal(interpreted.task_type, 'code_change');
  assert.equal(interpreted.deliverable_type, 'software_delivery');
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === 'builder'));
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === 'reviewer'));
  assert.ok(interpreted.candidate_capability_slots.some((slot) => slot.role_id === 'synthesizer'));
  assert.equal(interpreted.suppressed_role_ids.includes('synthesizer'), false);
});

test('task interpreter keeps restaurant menu recommendation/search out of code_change', () => {
  const interpreted = interpretTask({
    goal: '실제로 해당 식당에서 파는 메뉴들을 검색해보고 그걸 바탕으로 대답해줘.',
    seedInstruction: 'quick ask answer, informational only',
  });
  assert.notEqual(interpreted.task_type, 'code_change');
  assert.equal(interpreted.task_type, 'report');
  assert.equal(interpreted.deliverable_type, 'report');
});
