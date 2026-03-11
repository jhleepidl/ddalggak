import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSkillUsageEvent,
  recordSkillUsageEvent,
  summarizeSkillUsageEvents,
} from "../src/application/skill_feedback.js";

test("skill feedback records usage events to jsonl and summarizes counts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-skill-feedback-"));
  const outputPath = path.join(tmpDir, "skill_usage_events.jsonl");
  const inMemory = [];

  const event = createSkillUsageEvent({
    runId: "run_feedback_1",
    runtimeAgentInstanceId: "inst_1",
    skillId: "skill.telegram_briefing.v1",
    eventType: "attached",
    payload: { load_level: "instructions" },
  });
  const recorded = recordSkillUsageEvent(event, {
    inMemory,
    filePath: outputPath,
  });

  assert.ok(recorded);
  assert.equal(inMemory.length, 1);
  assert.equal(fs.existsSync(outputPath), true);
  const lines = fs.readFileSync(outputPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const summary = summarizeSkillUsageEvents(inMemory);
  assert.equal(summary.total, 1);
  assert.equal(summary.by_skill_id["skill.telegram_briefing.v1"], 1);
  assert.equal(summary.by_event_type.attached, 1);
});

