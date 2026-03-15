import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PresetRegistry } from "../src/catalog/preset_registry.js";
import { PresetResolver } from "../src/control_plane/preset_resolver.js";

test("preset resolver selects a matching compiled preset after filtering and ranking", () => {
  const presetRegistry = new PresetRegistry({
    presetsDir: path.resolve(process.cwd(), "presets"),
  });
  presetRegistry.load({ refresh: true });
  const resolver = new PresetResolver({
    presetRegistry,
    registry: { agents: [] },
    threshold: 20,
  });

  const resolved = resolver.resolveForTeam({
    goal: "Summarize the latest market news headlines into a brief",
    taskInterpretation: {
      task_summary: "Summarize the latest market news headlines into a brief",
      preferred_domains: ["market_news"],
      preferred_locales: ["en-US"],
      pinned_preset_ids: ["market_news_researcher"],
      review_policy: "optional",
    },
    teamPlan: {
      slots: [
        {
          slot_id: "slot_market_news",
          role_id: "researcher",
          purpose: "Collect market news evidence",
          preferred_skill_ids: ["skill.telegram_briefing.v1"],
          authority_profile_id: "worker_readonly_research",
        },
      ],
    },
  });

  assert.equal(resolved.runtime_agents.length, 1);
  assert.equal(resolved.runtime_agents[0].preset_id, "market_news_researcher");
  assert.equal(resolved.runtime_agents[0].synthesized, false);
  assert.equal(resolved.slot_preset_map.slot_market_news, "market_news_researcher");
});

test("preset resolver synthesizes runtime agents when no preset clears the threshold", () => {
  const presetRegistry = new PresetRegistry({
    presetsDir: path.resolve(process.cwd(), "presets"),
  });
  presetRegistry.load({ refresh: true });
  const resolver = new PresetResolver({
    presetRegistry,
    registry: { agents: [] },
    threshold: 999,
  });

  const resolved = resolver.resolveForTeam({
    goal: "Implement the code patch",
    taskInterpretation: {
      task_summary: "Implement the code patch",
      preferred_domains: ["codebase"],
      preferred_locales: ["en-US"],
      pinned_preset_ids: [],
      review_policy: "code_default",
    },
    teamPlan: {
      slots: [
        {
          slot_id: "slot_builder_1",
          role_id: "builder",
          purpose: "Implement the requested patch",
          authority_profile_id: "worker_publish_guarded",
        },
      ],
    },
  });

  assert.equal(resolved.runtime_agents.length, 1);
  assert.equal(resolved.runtime_agents[0].role_id, "builder");
  assert.equal(resolved.runtime_agents[0].synthesized, true);
  assert.equal(resolved.runtime_agents[0].preset_id, null);
  assert.equal(resolved.missing_roles.includes("builder"), true);
});
