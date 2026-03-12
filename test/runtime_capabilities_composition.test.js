import test from "node:test";
import assert from "node:assert/strict";
import { composeRuntimeCapabilities } from "../src/runtime_capabilities/index.js";

function createFakeJobs() {
  return {
    baseDir: "/tmp/ddalggak-test-runs",
    jobDir(jobId = "") {
      return `/tmp/ddalggak-test-runs/${String(jobId || "").trim()}`;
    },
  };
}

test("standalone capability composition uses local authorities", () => {
  const composed = composeRuntimeCapabilities({
    requestedMode: "local",
    jobs: createFakeJobs(),
  });

  assert.equal(composed.effective_mode, "standalone");
  assert.equal(composed.authority.mode, "standalone");
  assert.equal(composed.authority.plan_source, "local");
  assert.equal(composed.authority.context_source, "local");
  assert.equal(composed.authority.agent_catalog_source, "local");
  assert.equal(composed.authority.conversation_team_source, "local");
  assert.equal(composed.authority.skill_catalog_source, "local");
  assert.equal(composed.authority.degraded_mode, false);
});

test("goc capability composition uses goc authorities with local/mixed planner+skills", () => {
  const composed = composeRuntimeCapabilities({
    requestedMode: "goc",
    gocClient: {},
    gocReady: true,
    jobs: createFakeJobs(),
  });

  assert.equal(composed.effective_mode, "goc");
  assert.equal(composed.authority.mode, "goc");
  assert.equal(composed.authority.plan_source, "local");
  assert.equal(composed.authority.context_source, "goc");
  assert.equal(composed.authority.agent_catalog_source, "goc");
  assert.equal(composed.authority.conversation_team_source, "goc");
  assert.equal(composed.authority.skill_catalog_source, "mixed");
  assert.equal(composed.authority.degraded_mode, false);
});

test("goc requested but unavailable degrades to standalone with explicit fallback metadata", () => {
  const composed = composeRuntimeCapabilities({
    requestedMode: "goc",
    gocClient: null,
    gocReady: false,
    gocInitError: "network unreachable",
    jobs: createFakeJobs(),
  });

  assert.equal(composed.effective_mode, "standalone");
  assert.equal(composed.authority.mode, "standalone");
  assert.equal(composed.authority.plan_source, "local_fallback");
  assert.equal(composed.authority.context_source, "local");
  assert.equal(composed.authority.degraded_mode, true);
  assert.equal(composed.authority.fallback_reason, "network unreachable");
});

