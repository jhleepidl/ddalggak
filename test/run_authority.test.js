import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRunAuthority,
  buildRunAuthority,
  buildRunAuthorityPatch,
  normalizeRunAuthority,
} from "../src/application/run_authority.js";

test("normalizeRunAuthority delegates to canonical runtime authority normalization", () => {
  const authority = normalizeRunAuthority({
    mode: "LOCAL",
    planSource: "local_fallback",
    contextSource: "goc",
    conversationTeamSource: "local",
    skillCatalogSource: "mixed",
    degradedMode: true,
    fallbackReason: "goc unavailable",
  });

  assert.equal(authority.mode, "standalone");
  assert.equal(authority.plan_source, "local_fallback");
  assert.equal(authority.context_source, "goc");
  assert.equal(authority.conversation_team_source, "local");
  assert.equal(authority.skill_catalog_source, "mixed");
  assert.equal(authority.degraded_mode, true);
  assert.equal(authority.fallback_reason, "goc unavailable");
});

test("buildRunAuthority merges runtime authority with overrides", () => {
  const authority = buildRunAuthority({
    runtimeAuthority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
      degraded_mode: false,
      fallback_reason: null,
    },
  }, {
    plan_source: "local_fallback",
    degraded_mode: true,
    fallback_reason: "planner timeout",
  });

  assert.equal(authority.mode, "goc");
  assert.equal(authority.plan_source, "local_fallback");
  assert.equal(authority.degraded_mode, true);
  assert.equal(authority.fallback_reason, "planner timeout");
});

test("buildRunAuthorityPatch emits runtime_authority and flattened authority fields", () => {
  const patch = buildRunAuthorityPatch({
    runtime_authority: {
      mode: "goc",
      plan_source: "local",
      context_source: "goc",
      agent_catalog_source: "goc",
      conversation_team_source: "goc",
      skill_catalog_source: "mixed",
    },
  }, {
    plan_source: "local_fallback",
  });

  assert.ok(patch.runtime_authority);
  assert.equal(patch.mode, "goc");
  assert.equal(patch.plan_source, "local_fallback");
  assert.equal(patch.context_source, "goc");
  assert.equal(patch.skill_catalog_source, "mixed");
});

test("applyRunAuthority mutates runtime with canonical authority patch", () => {
  const runtime = {
    runtimeAuthority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
    },
  };

  const authority = applyRunAuthority(runtime, {
    plan_source: "local_fallback",
    degraded_mode: true,
    fallback_reason: "network unreachable",
  });

  assert.equal(authority.plan_source, "local_fallback");
  assert.equal(runtime.runtimeAuthority.plan_source, "local_fallback");
  assert.equal(runtime.runtime_authority.plan_source, "local_fallback");
  assert.equal(runtime.plan_source, "local_fallback");
  assert.equal(runtime.degraded_mode, true);
  assert.equal(runtime.fallback_reason, "network unreachable");
});
