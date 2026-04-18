import path from "node:path";
import { createContextStore } from "./context_store.js";
import { LocalAgentCatalog, GocAgentCatalog } from "./agent_catalog.js";
import { LocalConversationTeamStore, GocConversationTeamStore } from "./conversation_team_store.js";
import { createSkillCatalog } from "./skill_catalog.js";
import { LocalPlanner, RemotePlanner } from "./planner.js";
import { LocalRunEventSink, GocRunEventSink } from "./run_event_sink.js";
import { normalizeRunAuthority } from "../application/run_authority.js";

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

export function normalizeRequestedMode(raw = "") {
  return String(raw || "").trim().toLowerCase() === "goc" ? "goc" : "local";
}

export function normalizePlanSource(raw = "", { fallback = "local" } = {}) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "local" || key === "goc" || key === "local_fallback") return key;
  return fallback;
}

export function composeRuntimeCapabilities({
  requestedMode = "local",
  gocClient = null,
  gocReady = false,
  gocInitError = "",
  jobs = null,
  baseDir = "",
  runtime = null,
  logger = null,
  skillsDir = path.resolve(process.cwd(), "skills"),
  resolveMembershipTarget = null,
  resolveAgentId = null,
  remotePlannerRun = null,
} = {}) {
  const cleanRequestedMode = normalizeRequestedMode(requestedMode);
  const hasGoc = cleanRequestedMode === "goc" && !!gocClient && gocReady !== false;
  const effectiveMode = hasGoc ? "goc" : "standalone";
  const degradedMode = cleanRequestedMode === "goc" && !hasGoc;
  const fallbackReason = degradedMode
    ? (String(gocInitError || "").trim() || "goc_unavailable")
    : null;
  const runtimeLogger = normalizeLogger(logger);

  const localAgentCatalog = new LocalAgentCatalog({
    logger: runtimeLogger,
  });
  const agentCatalog = hasGoc
    ? new GocAgentCatalog({
      client: gocClient,
      baseDir: String(baseDir || "").trim(),
      fallbackCatalog: localAgentCatalog,
      logger: runtimeLogger,
    })
    : localAgentCatalog;

  const conversationTeamStore = hasGoc
    ? new GocConversationTeamStore({
      client: gocClient,
      resolveMembershipTarget,
      baseDir: String(baseDir || "").trim(),
      logger: runtimeLogger,
    })
    : new LocalConversationTeamStore({
      jobs,
      baseDir: String(baseDir || "").trim(),
      logger: runtimeLogger,
    });

  const contextStore = createContextStore({
    source: hasGoc ? "goc" : "local",
    client: hasGoc ? gocClient : null,
    runtime,
    jobs,
    logger: runtimeLogger,
  });

  const skillCatalog = createSkillCatalog({
    source: "local",
    skillsDir,
    logger: runtimeLogger,
  });

  const planner = typeof remotePlannerRun === "function"
    ? new RemotePlanner({
      run: remotePlannerRun,
      source: "goc",
    })
    : new LocalPlanner({
      resolveAgentId,
      source: degradedMode ? "local_fallback" : "local",
    });

  const authority = normalizeRunAuthority({
    mode: effectiveMode,
    plan_source: typeof remotePlannerRun === "function"
      ? "goc"
      : (degradedMode ? "local_fallback" : "local"),
    context_source: hasGoc ? "goc" : "local",
    agent_catalog_source: hasGoc ? "goc" : "local",
    conversation_team_source: hasGoc ? "goc" : "local",
    skill_catalog_source: hasGoc ? "mixed" : "local",
    degraded_mode: degradedMode,
    fallback_reason: fallbackReason,
  });

  return {
    requested_mode: cleanRequestedMode,
    effective_mode: effectiveMode,
    degraded_mode: degradedMode,
    fallback_reason: fallbackReason,
    authority,
    capabilities: {
      contextStore,
      agentCatalog,
      conversationTeamStore,
      skillCatalog,
      planner,
      createRunEventSink: ({ executionGraph = null, runtimePolicy = null } = {}) => {
        const localSink = new LocalRunEventSink({
          jobs,
          logger: runtimeLogger,
          runtimePolicy,
        });
        if (hasGoc) {
          return new GocRunEventSink({
            executionGraph,
            fallbackSink: localSink,
            runtimePolicy,
          });
        }
        return localSink;
      },
    },
  };
}

export {
  LocalContextStore,
  GocContextStore,
} from "./context_store.js";

export {
  LocalAgentCatalog,
  GocAgentCatalog,
} from "./agent_catalog.js";

export {
  LocalConversationTeamStore,
  GocConversationTeamStore,
} from "./conversation_team_store.js";

export {
  LocalSkillCatalog,
} from "./skill_catalog.js";

export {
  LocalPlanner,
  RemotePlanner,
} from "./planner.js";

export {
  LocalRunEventSink,
  GocRunEventSink,
} from "./run_event_sink.js";
