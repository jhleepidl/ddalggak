import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRunAuthority,
  buildRunAuthorityEnvelope,
  buildRunAuthority,
  buildRunAuthorityPatch,
  createRunAuthorityContract,
  mergeRunAuthority,
  normalizeRunAuthority,
  RUN_AUTHORITY_CONTRACT_FIELDS,
} from "../src/application/run_authority.js";
import {
  buildRuntimeAuthorityMetadataFixture,
  cloneRuntimeAuthorityFixture,
} from "../test_fixtures/runtime_authority_contract.js";

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

test("createRunAuthorityContract applies canonical defaults for partial standalone metadata", () => {
  const authority = createRunAuthorityContract({
    planSource: "local",
  });

  assert.deepEqual(
    authority,
    cloneRuntimeAuthorityFixture("standalone")
  );
  assert.deepEqual(
    Object.keys(authority).sort(),
    [...RUN_AUTHORITY_CONTRACT_FIELDS].sort()
  );
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

test("mergeRunAuthority keeps goc capability sources while marking planner fallback explicitly", () => {
  const authority = mergeRunAuthority(
    cloneRuntimeAuthorityFixture("goc"),
    {
      plan_source: "local_fallback",
      degraded_mode: true,
      fallback_reason: "remote planner timeout",
    }
  );

  assert.deepEqual(
    authority,
    cloneRuntimeAuthorityFixture("goc_planner_fallback")
  );
});

test("buildRunAuthority ignores non-authority route mode fields while merging planner metadata", () => {
  const authority = buildRunAuthority(
    buildRuntimeAuthorityMetadataFixture("goc"),
    {
      mode: "run",
      plan_source: "local_fallback",
      degraded_mode: true,
      fallback_reason: "remote planner timeout",
    }
  );

  assert.equal(authority.mode, "goc");
  assert.equal(authority.plan_source, "local_fallback");
  assert.equal(authority.degraded_mode, true);
  assert.equal(authority.fallback_reason, "remote planner timeout");
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

test("buildRunAuthorityEnvelope keeps canonical flattened fields and legacy runtimeAuthority alias for runtime objects", () => {
  const envelope = buildRunAuthorityEnvelope(
    buildRuntimeAuthorityMetadataFixture("local_fallback"),
    {},
    { includeRuntimeMode: true }
  );

  assert.deepEqual(
    envelope.runtime_authority,
    cloneRuntimeAuthorityFixture("local_fallback")
  );
  assert.deepEqual(
    envelope.runtimeAuthority,
    cloneRuntimeAuthorityFixture("local_fallback")
  );
  assert.equal(envelope.runtime_mode, "standalone");
  assert.equal(envelope.plan_source, "local_fallback");
  assert.equal(envelope.fallback_reason, "goc unavailable");
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
