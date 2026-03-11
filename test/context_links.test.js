import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGocUiLink,
  buildContextLinks,
  buildContextLinkButtons,
} from "../src/adapters/telegram/context_links.js";

test("buildGocUiLink keeps agents page query shape", () => {
  const link = buildGocUiLink({
    base: "https://goc.example.com",
    page: "agents",
    threadId: "thread_1",
    ctxId: "ctx_1",
  });
  assert.match(link, /^https:\/\/goc\.example\.com\/agents\?/);
  assert.match(link, /thread=thread_1/);
  assert.match(link, /ctx=ctx_1/);
});

test("buildContextLinks supports bearer-token mode with tokenized links", async () => {
  const client = {
    async mintUiToken(ttl) {
      return {
        token: `tok_${ttl}`,
        exp: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  const links = await buildContextLinks(client, {
    base: "https://goc.example.com",
    threadId: "thread_1",
    ctxId: "ctx_1",
    linkMode: "bearer_token",
    uiTokenTtlSec: 100,
    browserTokenTtlSec: 200,
  });
  assert.match(links.miniAppLink, /#token=tok_100$/);
  assert.match(links.browserLink, /#token=tok_200$/);
  assert.equal(links.miniAppSupported, true);
});

test("buildContextLinkButtons omits mini app button for non-https links", () => {
  const httpButtons = buildContextLinkButtons({
    miniAppLink: "http://local.invalid/?thread=t1&ctx=c1",
    browserLink: "http://local.invalid/?thread=t1&ctx=c1",
  });
  assert.equal(httpButtons.hasMiniApp, false);
  assert.equal(httpButtons.buttons.length, 1);
  assert.equal(httpButtons.buttons[0].text, "Open GoC (Browser)");
});
