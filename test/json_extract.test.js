import test from "node:test";
import assert from "node:assert/strict";
import { findFirstJsonObject, parseJsonObjectFromText } from "../src/shared/json_extract.js";

test("findFirstJsonObject extracts the first balanced JSON object", () => {
  const text = "prefix {\"a\":1,\"b\":{\"c\":2}} suffix {\"d\":3}";
  assert.equal(findFirstJsonObject(text), '{"a":1,"b":{"c":2}}');
});

test("parseJsonObjectFromText handles fenced JSON", () => {
  const text = [
    "Here is the plan",
    "```json",
    '{"reason":"ok","actions":[{"type":"git_summary"}]}',
    "```",
  ].join("\n");
  const parsed = parseJsonObjectFromText(text);
  assert.equal(parsed.reason, "ok");
  assert.equal(parsed.actions[0].type, "git_summary");
});

test("parseJsonObjectFromText handles inline object", () => {
  const text = "Result => {\"k\":\"v\",\"n\":2}";
  const parsed = parseJsonObjectFromText(text);
  assert.deepEqual(parsed, { k: "v", n: 2 });
});
