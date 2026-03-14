import test from "node:test";
import assert from "node:assert/strict";

import * as runtimeCore from "../src/application/telegram_runtime_ops.js";
import {
  sendChatStatus,
  sendAgentOrToolListQuick,
} from "../src/application/telegram_runtime_ui.js";

test("application-level telegram runtime modules expose extracted orchestration services", () => {
  assert.equal(typeof runtimeCore.decideRunRoute, "function");
  assert.equal(typeof runtimeCore.suggestNextPrompt, "function");
  assert.equal(typeof runtimeCore.executeActions, "function");
  assert.equal(typeof runtimeCore.executeRoutedPlan, "function");
  assert.equal(typeof runtimeCore.sendAgentStatusTransitionMessage, "function");
  assert.equal(typeof sendChatStatus, "function");
  assert.equal(typeof sendAgentOrToolListQuick, "function");
});
