import path from "node:path";

import { buildRuntimeOrchestration } from "./orchestrator.js";
import { normalizeRunAuthority } from "./run_authority.js";
import { composeRuntimeCapabilities } from "../runtime_capabilities/index.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

function callOrValue(value, ...args) {
  return typeof value === "function" ? value(...args) : value;
}

export function createRuntimeComposer({
  requestedMode = "local",
  getGocState = null,
  jobs = null,
  baseDir = "",
  skillsDir = path.resolve(process.cwd(), "skills"),
  loggerFactory = null,
  resolveMembershipTarget = null,
  resolveAgentId = null,
  remotePlannerRun = null,
} = {}) {
  const resolvedBaseDir = String(baseDir || jobs?.baseDir || "").trim();
  return function composeForRun({
    jobId = "",
    runtime = null,
    remotePlanner = undefined,
  } = {}) {
    const cleanJobId = String(jobId || "").trim();
    const gocState = asObject(callOrValue(getGocState, {
      jobId: cleanJobId,
      runtime,
    }));
    const pack = composeRuntimeCapabilities({
      requestedMode: callOrValue(requestedMode, {
        jobId: cleanJobId,
        runtime,
      }),
      gocClient: gocState.gocClient ?? gocState.client ?? null,
      gocReady: gocState.gocReady ?? gocState.ready ?? false,
      gocInitError: String(gocState.gocInitError ?? gocState.initError ?? "").trim(),
      jobs,
      baseDir: resolvedBaseDir,
      runtime,
      logger: normalizeLogger(callOrValue(loggerFactory, cleanJobId, {
        runtime,
      })),
      skillsDir,
      resolveMembershipTarget,
      resolveAgentId,
      remotePlannerRun: remotePlanner === undefined ? remotePlannerRun : remotePlanner,
    });
    return {
      ...pack,
      authority: normalizeRunAuthority(pack?.authority || null),
    };
  };
}

export async function invokeRuntimePlanner({
  composeForRun = null,
  jobId = "",
  runtime = null,
  mode = "run",
  goal = "",
  seedInstruction = "",
  routePlan = null,
  registry = null,
  preferredRoles = [],
  maxAgents = 6,
  resolveAgentId = null,
  runsDir = "",
  persistSkillEvents = false,
  orchestrationBuilder = buildRuntimeOrchestration,
} = {}) {
  const compose = typeof composeForRun === "function" ? composeForRun : null;
  const capabilitiesPack = compose ? compose({ jobId, runtime }) : null;
  const runtimeAuthority = normalizeRunAuthority(capabilitiesPack?.authority || null);
  const planner = capabilitiesPack?.capabilities?.planner;
  const planningInput = {
    mode,
    goal,
    seedInstruction,
    routePlan,
    registry,
    preferredRoles,
    maxAgents,
    runId: `route_${String(jobId || "").trim()}_${Date.now().toString(36)}`,
    jobId: String(jobId || "").trim(),
    runsDir: String(runsDir || "").trim(),
    persistSkillEvents: persistSkillEvents === true,
  };

  if (planner && typeof planner.plan === "function") {
    return await planner.plan(planningInput);
  }

  const orchestration = typeof orchestrationBuilder === "function"
    ? orchestrationBuilder({
      ...planningInput,
      resolveAgentId,
    })
    : null;
  return {
    plan_source: runtimeAuthority?.plan_source || "local",
    route_plan: orchestration?.route_plan || null,
    team_plan: orchestration?.team_plan || null,
    runtime_agents: Array.isArray(orchestration?.runtime_agents) ? orchestration.runtime_agents : [],
    runtime_team_snapshot: orchestration?.runtime_team_snapshot || null,
  };
}
