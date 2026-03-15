import test from "node:test";
import assert from "node:assert/strict";

import { rerankResolvedTeamComposition } from "../src/control_plane/team_builder.js";

test("team reranker penalizes missing reviewer and rewards reviewer plus synthesizer coverage", () => {
  const withoutReviewer = rerankResolvedTeamComposition({
    teamPlan: {
      slots: [
        { slot_id: "slot_builder_1", role_id: "builder" },
        { slot_id: "slot_synth_1", role_id: "synthesizer" },
      ],
    },
    runtimeAgents: [
      { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", provider: "codex" },
      { instance_id: "inst_synth_1", slot_id: "slot_synth_1", role_id: "synthesizer", provider: "gemini" },
    ],
    taskInterpretation: {
      risk_level: "high",
      review_policy: "required",
    },
  });
  assert.equal(withoutReviewer.selection_explanations.some((row) => row.reason.includes("missing reviewer")), true);

  const withReviewer = rerankResolvedTeamComposition({
    teamPlan: {
      slots: [
        { slot_id: "slot_builder_1", role_id: "builder" },
        { slot_id: "slot_reviewer_1", role_id: "reviewer" },
        { slot_id: "slot_synth_1", role_id: "synthesizer" },
      ],
    },
    runtimeAgents: [
      { instance_id: "inst_builder_1", slot_id: "slot_builder_1", role_id: "builder", provider: "codex" },
      { instance_id: "inst_reviewer_1", slot_id: "slot_reviewer_1", role_id: "reviewer", provider: "gemini" },
      { instance_id: "inst_synth_1", slot_id: "slot_synth_1", role_id: "synthesizer", provider: "gemini" },
    ],
    taskInterpretation: {
      risk_level: "high",
      review_policy: "required",
    },
  });

  assert.equal(withReviewer.selection_explanations.some((row) => row.reason.includes("reviewer and synthesizer coverage")), true);
  assert.equal(withReviewer.score > withoutReviewer.score, true);
});
