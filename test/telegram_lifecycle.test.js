import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  parseLockPid,
  createSingleInstanceLock,
  createPollingErrorHandler,
  registerLifecycleSignals,
} from "../src/adapters/telegram/lifecycle.js";

test("parseLockPid accepts json and legacy pid formats", () => {
  assert.equal(parseLockPid("{\"pid\":1234}"), 1234);
  assert.equal(parseLockPid("pid=5678"), 5678);
  assert.equal(parseLockPid("no pid"), null);
});

test("createSingleInstanceLock replaces stale locks and releases its own lock file", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-telegram-lock-"));
  const lockFile = path.join(tmpRoot, "telegram.lock");
  fs.writeFileSync(lockFile, "{\"pid\":999999}\n", "utf8");

  const processImpl = {
    pid: 4242,
    kill() {
      const error = new Error("not running");
      error.code = "ESRCH";
      throw error;
    },
  };

  const lock = createSingleInstanceLock({
    enabled: true,
    lockFile,
    processImpl,
  });

  assert.equal(lock.acquire(), true);
  const written = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(written.pid, 4242);
  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(lockFile), false);
});

test("createSingleInstanceLock throws on a live competing process", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-telegram-lock-live-"));
  const lockFile = path.join(tmpRoot, "telegram.lock");
  fs.writeFileSync(lockFile, "{\"pid\":5150}\n", "utf8");

  const processImpl = {
    pid: 4242,
    kill(pid) {
      assert.equal(pid, 5150);
    },
  };

  const lock = createSingleInstanceLock({
    enabled: true,
    lockFile,
    processImpl,
  });

  assert.throws(
    () => lock.acquire(),
    (error) => error?.code === "telegram_single_instance_conflict" && error?.pid === 5150
  );
});

test("createPollingErrorHandler suppresses repeated polling errors and escalates 409 conflicts", async () => {
  const logs = [];
  const shutdownCodes = [];
  const handler = createPollingErrorHandler({
    logger: (line) => logs.push(String(line)),
    shutdown: async (code) => {
      shutdownCodes.push(code);
    },
    suppressWindowMs: 10_000,
  });

  handler({ code: "ETELEGRAM", message: "rate limited", response: { body: { error_code: 429 } } });
  handler({ code: "ETELEGRAM", message: "rate limited", response: { body: { error_code: 429 } } });
  handler({ code: "EFATAL", message: "AggregateError: boom" });
  handler({ code: "ETELEGRAM", message: "conflict", response: { body: { error_code: 409 } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(logs[0], /polling_error \[ETELEGRAM\] rate limited/);
  assert.match(logs[1], /polling_error repeated 1 times/);
  assert.match(logs[2], /fatal network error/);
  assert.match(logs[4], /polling conflict \(409\)/i);
  assert.deepEqual(shutdownCodes, [1]);
});

test("registerLifecycleSignals wires exit and shutdown handlers", async () => {
  const processImpl = new EventEmitter();
  processImpl.off = processImpl.removeListener.bind(processImpl);

  const events = [];
  const unregister = registerLifecycleSignals({
    processImpl,
    releaseLock: () => {
      events.push("release");
    },
    shutdown: async (code) => {
      events.push(`shutdown:${code}`);
    },
  });

  processImpl.emit("exit");
  processImpl.emit("SIGINT");
  processImpl.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  unregister();

  assert.deepEqual(events, ["release", "shutdown:0", "shutdown:0"]);
});
