import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import * as runtimeCore from "../src/application/telegram_runtime_ops.js";
import {
  sendChatStatus,
  sendAgentOrToolListQuick,
} from "../src/application/telegram_runtime_ui.js";

test("application-level telegram runtime modules expose extracted orchestration services", () => {
  const opsPath = path.resolve("src/application/telegram_runtime_ops.js");
  const opsSource = fs.readFileSync(opsPath, "utf8");

  assert.match(opsSource, /export \* from "\.\/telegram_runtime_state\.js";/);
  assert.match(opsSource, /export \* from "\.\/telegram_runtime_io\.js";/);
  assert.match(opsSource, /export \* from "\.\/telegram_route_planning\.js";/);
  assert.match(opsSource, /export \* from "\.\/telegram_chat_execution\.js";/);
  assert.match(opsSource, /export \* from "\.\/telegram_goc_runtime\.js";/);
  assert.doesNotMatch(opsSource, /^(async function|function) /m);

  assert.equal(typeof runtimeCore.buildContextInfo, "function");
  assert.equal(typeof runtimeCore.createJob, "function");
  assert.equal(typeof runtimeCore.decideRunRoute, "function");
  assert.equal(typeof runtimeCore.suggestNextPrompt, "function");
  assert.equal(typeof runtimeCore.refreshSharedContext, "function");
  assert.equal(typeof runtimeCore.buildSupervisorExecutionCallbacks, "function");
  assert.equal(typeof runtimeCore.executeActions, "function");
  assert.equal(typeof runtimeCore.executeRoutedPlan, "function");
  assert.equal(typeof runtimeCore.sendAgentStatusTransitionMessage, "function");
  assert.equal(typeof sendChatStatus, "function");
  assert.equal(typeof sendAgentOrToolListQuick, "function");
});
