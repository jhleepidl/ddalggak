import test from "node:test";
import assert from "node:assert/strict";
import { composeRuntimeCapabilities } from "../src/runtime_capabilities/index.js";
import { cloneRuntimeAuthorityFixture } from "../test_fixtures/runtime_authority_contract.js";

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
  assert.deepEqual(composed.authority, cloneRuntimeAuthorityFixture("standalone"));
});

test("goc capability composition uses goc authorities with local/mixed planner+skills", () => {
  const composed = composeRuntimeCapabilities({
    requestedMode: "goc",
    gocClient: {},
    gocReady: true,
    jobs: createFakeJobs(),
  });

  assert.equal(composed.effective_mode, "goc");
  assert.deepEqual(composed.authority, cloneRuntimeAuthorityFixture("goc"));
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
  assert.deepEqual(composed.authority, {
    ...cloneRuntimeAuthorityFixture("local_fallback"),
    fallback_reason: "network unreachable",
  });
});
