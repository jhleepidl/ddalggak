import test from "node:test";
import assert from "node:assert/strict";

import { GocClient } from "../src/goc_client.js";

test("GocClient strips a trailing /api from GOC_API_BASE", () => {
  const client = new GocClient({
    apiBase: "http://example.test/api/",
    serviceKey: "svk.test.token",
  });

  assert.equal(client._url("/api/threads"), "http://example.test/api/threads");
});

test("createThread primary error points at canonical plural route and summarizes fallbacks", async () => {
  class FailingClient extends GocClient {
    constructor() {
      super({
        apiBase: "http://example.test",
        serviceKey: "svk.test.token",
      });
      this.paths = [];
    }

    async _request({ method, path }) {
      this.paths.push(path);
      const error = new Error(`GoC API ${method} http://example.test${path} failed (404)`);
      error.status = 404;
      error.url = `http://example.test${path}`;
      throw error;
    }
  }

  const client = new FailingClient();
  await assert.rejects(
    () => client.createThread("job:test"),
    (error) => {
      assert.match(error.message, /\/api\/threads failed \(404\)/);
      assert.match(error.message, /attempted fallback routes:/);
      assert.match(error.message, /\/api\/thread -> 404/);
      assert.equal(error.status, 404);
      return true;
    },
  );

  assert.deepEqual(client.paths, [
    "/api/threads",
    "/threads",
    "/v1/threads",
    "/api/thread",
  ]);
});
