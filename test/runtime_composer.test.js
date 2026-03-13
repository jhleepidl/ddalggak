import test from "node:test";
import assert from "node:assert/strict";

import { loadAgents } from "../src/agents.js";
import {
  createRuntimeComposer,
  invokeRuntimePlanner,
} from "../src/application/runtime_composer.js";

function createFakeJobs() {
  return {
    baseDir: "/tmp/ddalggak-runtime-composer",
    runsDir: "/tmp/ddalggak-runtime-composer/runs",
    jobDir(jobId = "") {
      return `/tmp/ddalggak-runtime-composer/${String(jobId || "").trim()}`;
    },
  };
}

test("createRuntimeComposer composes canonical runtime capabilities for a job context", () => {
  const jobs = createFakeJobs();
  const composeForRun = createRuntimeComposer({
    requestedMode: () => "goc",
    getGocState: () => ({
      gocClient: null,
      gocReady: false,
      gocInitError: "network unreachable",
    }),
    jobs,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    loggerFactory: (jobId) => (line) => `${jobId}:${line}`,
  });

  const pack = composeForRun({ jobId: "job_runtime_1" });

  assert.equal(pack.requested_mode, "goc");
  assert.equal(pack.effective_mode, "standalone");
  assert.equal(pack.authority.mode, "standalone");
  assert.equal(pack.authority.plan_source, "local_fallback");
  assert.equal(pack.authority.degraded_mode, true);
});

test("invokeRuntimePlanner uses the composed planner when available", async () => {
  let received = null;
  const composeForRun = () => ({
    authority: {
      mode: "standalone",
      plan_source: "local",
      context_source: "local",
      agent_catalog_source: "local",
      conversation_team_source: "local",
      skill_catalog_source: "local",
    },
    capabilities: {
      planner: {
        async plan(input) {
          received = input;
          return {
            plan_source: "local",
            route_plan: {
              reason: "planner route",
              actions: [{ type: "agent_run", agent: "coder", prompt: "ship it", inputs: {} }],
            },
            team_plan: { mode: "run" },
            runtime_agents: [{ template_id: "coder", role_label: "coder", instance_id: "inst_coder_1" }],
            runtime_team_snapshot: { source: "team_builder", runtime_agents: [] },
          };
        },
      },
    },
  });

  const result = await invokeRuntimePlanner({
    composeForRun,
    jobId: "job_runtime_2",
    mode: "run",
    goal: "Implement the refactor",
    seedInstruction: "refactor",
    routePlan: { reason: "input plan" },
    registry: loadAgents(),
    maxAgents: 4,
    runsDir: "/tmp/ddalggak-runtime-composer/runs",
  });

  assert.ok(received);
  assert.equal(received.jobId, "job_runtime_2");
  assert.equal(received.mode, "run");
  assert.equal(result.plan_source, "local");
  assert.equal(result.route_plan.reason, "planner route");
});

test("invokeRuntimePlanner falls back to orchestration builder when planner is unavailable", async () => {
  const result = await invokeRuntimePlanner({
    composeForRun: () => ({
      authority: {
        mode: "standalone",
        plan_source: "local_fallback",
        context_source: "local",
        agent_catalog_source: "local",
        conversation_team_source: "local",
        skill_catalog_source: "local",
      },
      capabilities: {},
    }),
    jobId: "job_runtime_3",
    mode: "continue",
    goal: "Continue the work",
    seedInstruction: "continue",
    registry: loadAgents(),
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
    orchestrationBuilder: (input) => ({
      route_plan: {
        reason: `fallback:${input.mode}`,
        actions: [{ type: "git_summary" }],
      },
      team_plan: { mode: input.mode },
      runtime_agents: [{ template_id: "planner", role_label: "planner", instance_id: "inst_planner_1" }],
      runtime_team_snapshot: { source: "team_builder", runtime_agents: [] },
    }),
  });

  assert.equal(result.plan_source, "local_fallback");
  assert.equal(result.route_plan.reason, "fallback:continue");
  assert.equal(result.team_plan.mode, "continue");
});
