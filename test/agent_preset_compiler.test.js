import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadPresetSpec } from "../src/catalog/preset_spec_loader.js";
import { compilePresetSpec } from "../src/catalog/preset_compiler.js";
import { PresetRegistry } from "../src/catalog/preset_registry.js";

test("preset compiler turns text-first DART spec into normalized agent preset", () => {
  const spec = loadPresetSpec(path.resolve(process.cwd(), "presets/dart_financial_researcher"));
  const compiled = compilePresetSpec(spec);

  assert.ok(compiled);
  assert.equal(compiled.preset_id, "dart_financial_researcher");
  assert.equal(compiled.role_id, "researcher");
  assert.ok(compiled.default_skill_ids.includes("skill.kr_equity_analysis.v1"));
  assert.ok(compiled.retrieval_text.includes("DART"));
  assert.ok(compiled.prompt_text.includes("primary filing evidence"));
});

test("preset registry loads compiled presets from disk", () => {
  const registry = new PresetRegistry({
    presetsDir: path.resolve(process.cwd(), "presets"),
  });
  const loaded = registry.load({ refresh: true });

  assert.equal(loaded.presets.length >= 3, true);
  const reviewer = registry.resolve("skeptical_claim_reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer.role_id, "reviewer");
  assert.ok(reviewer.default_skill_ids.includes("skill.claim_evidence_audit.v1"));
});
