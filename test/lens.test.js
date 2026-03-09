import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLensSpec,
  defaultLensSpecForAgent,
  resolveEffectiveLensSpec,
} from "../src/domain/lens.js";

test("normalizeLensSpec infers mode and clamps budget", () => {
  const spec = normalizeLensSpec({
    query: "find context",
    budget_tokens: 50000,
    closure_direction: "FORWARD",
    addNodeIds: ["a", "b", "a"],
  });
  assert.equal(spec.mode, "unfold_query");
  assert.equal(spec.budget_tokens, 12000);
  assert.equal(spec.closure_direction, "forward");
  assert.deepEqual(spec.add_node_ids, ["a", "b"]);
});

test("defaultLensSpecForAgent keeps planner as shared_only", () => {
  const spec = defaultLensSpecForAgent({ agentId: "planner", goal: "ship feature" });
  assert.equal(spec.mode, "shared_only");
  assert.equal(spec.budget_tokens, 900);
});

test("resolveEffectiveLensSpec uses custom lens when provided", () => {
  const spec = resolveEffectiveLensSpec({ mode: "add_nodes", add_node_ids: ["n1"] }, {
    agentId: "coder",
    goal: "update file",
    recentArtifactNodeIds: ["x"],
  });
  assert.equal(spec.mode, "add_nodes");
  assert.deepEqual(spec.add_node_ids, ["n1"]);
});
