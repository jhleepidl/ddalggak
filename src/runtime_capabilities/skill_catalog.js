import path from "node:path";
import { SkillRegistry } from "../application/skill_registry.js";

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

export class LocalSkillCatalog {
  constructor({
    skillsDir = path.resolve(process.cwd(), "skills"),
    logger = null,
  } = {}) {
    this.source = "local";
    this.logger = normalizeLogger(logger);
    this.registry = new SkillRegistry({
      skillsDir,
      logger: this.logger,
    });
  }

  load({ refresh = false } = {}) {
    return this.registry.load({ refresh });
  }

  list(input = {}) {
    return this.registry.list(input);
  }

  resolve(skillIdOrSlug = "") {
    return this.registry.resolve(skillIdOrSlug);
  }

  getRegistry() {
    return this.registry;
  }
}

export function createSkillCatalog({
  source = "local",
  skillsDir,
  logger = null,
} = {}) {
  void source;
  return new LocalSkillCatalog({
    skillsDir,
    logger,
  });
}

