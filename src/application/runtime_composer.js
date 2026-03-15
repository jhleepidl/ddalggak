import path from "node:path";

import { LocalPlanner } from "./local_planner.js";
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
  conversationPreferences = null,
  maxAgents = 6,
  resolveAgentId = null,
  runsDir = "",
  persistSkillEvents = false,
} = {}) {
  const compose = typeof composeForRun === "function" ? composeForRun : null;
  const capabilitiesPack = compose ? compose({ jobId, runtime }) : null;
  const runtimeAuthority = normalizeRunAuthority(capabilitiesPack?.authority || null);
  const conversationTeamStore = capabilitiesPack?.capabilities?.conversationTeamStore;
  const persistedConversationPreferences = conversationPreferences && typeof conversationPreferences === "object"
    ? conversationPreferences
    : (conversationTeamStore && typeof conversationTeamStore.getPreferences === "function"
      ? await conversationTeamStore.getPreferences({
        jobId: String(jobId || "").trim(),
        threadId: String(runtime?.map?.threadId || "").trim(),
        conversationId: String(runtime?.conversation?.id || "").trim(),
        membershipTarget: runtime?.conversationMembershipTarget || null,
      }).catch(() => null)
      : null);
  const planner = capabilitiesPack?.capabilities?.planner
    || new LocalPlanner({
      resolveAgentId,
      source: runtimeAuthority?.plan_source || "local",
    });
  const planningInput = {
    mode,
    goal,
    seedInstruction,
    routePlan,
    registry,
    preferredRoles,
    conversationPreferences: persistedConversationPreferences,
    maxAgents,
    runId: `route_${String(jobId || "").trim()}_${Date.now().toString(36)}`,
    jobId: String(jobId || "").trim(),
    runsDir: String(runsDir || "").trim(),
    persistSkillEvents: persistSkillEvents === true,
  };
  if (!planner || typeof planner.plan !== "function") {
    throw new Error("planner.plan is unavailable");
  }
  return await planner.plan(planningInput);
}
