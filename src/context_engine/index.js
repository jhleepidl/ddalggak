import { LocalContextEngine } from "./local_engine.js";
import { GocContextEngine } from "./goc_engine.js";

export function makeContextEngine({
  memoryMode = "local",
  jobs = null,
  gocClient = null,
  runtime = null,
  logger = null,
} = {}) {
  const mode = String(memoryMode || "").trim().toLowerCase() === "goc" && gocClient
    ? "goc"
    : "local";
  if (mode === "goc") {
    return new GocContextEngine({
      client: gocClient,
      runtime,
      jobs,
      logger,
    });
  }
  return new LocalContextEngine({
    jobs,
    logger,
  });
}

