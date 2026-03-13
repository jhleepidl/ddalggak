export {
  LocalPlanner,
} from "../application/local_planner.js";

function normalizePlanSource(raw = "", { fallback = "local" } = {}) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "local" || key === "goc" || key === "local_fallback") return key;
  return fallback;
}

export class RemotePlanner {
  constructor({
    run = null,
    source = "goc",
  } = {}) {
    this.source = normalizePlanSource(source, { fallback: "goc" });
    this.run = typeof run === "function" ? run : null;
  }

  async plan(input = {}) {
    if (!this.run) {
      throw new Error("RemotePlanner requires run()");
    }
    const result = await this.run(input);
    return {
      ...result,
      plan_source: normalizePlanSource(result?.plan_source || this.source, {
        fallback: this.source,
      }),
    };
  }
}
