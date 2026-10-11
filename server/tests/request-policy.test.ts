import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "daynote-request-policy-")), "data.db");
const policy = await import("../src/request-policy.js");

test("production CORS is same-origin by default and accepts an explicit allow-list", () => {
  assert.equal(policy.corsOriginPolicy(undefined, "production"), false);
  assert.equal(policy.corsOriginPolicy(undefined, "development"), true);
  assert.equal(policy.corsOriginPolicy("*", "production"), false);
  assert.equal(policy.corsOriginPolicy("*", "development"), true);
  assert.deepEqual(
    policy.corsOriginPolicy("https://assistant.5656ai.com, https://admin.example", "production"),
    ["https://assistant.5656ai.com", "https://admin.example"],
  );
});

test("persistent request buckets reset after their configured window", () => {
  const start = Date.UTC(2026, 9, 11, 0, 0, 0);
  assert.deepEqual(policy.consumeRequestLimit("email", "127.0.0.1", 2, 60_000, start), {
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 60,
  });
  assert.equal(policy.consumeRequestLimit("email", "127.0.0.1", 2, 60_000, start + 1_000).allowed, true);
  const blocked = policy.consumeRequestLimit("email", "127.0.0.1", 2, 60_000, start + 2_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 58);
  assert.equal(policy.consumeRequestLimit("email", "127.0.0.1", 2, 60_000, start + 60_001).allowed, true);
});

test("different scopes and identifiers do not share a bucket", () => {
  const now = Date.UTC(2026, 9, 11, 1, 0, 0);
  assert.equal(policy.consumeRequestLimit("guest", "ip-a", 1, 60_000, now).allowed, true);
  assert.equal(policy.consumeRequestLimit("guest", "ip-a", 1, 60_000, now + 1).allowed, false);
  assert.equal(policy.consumeRequestLimit("guest", "ip-b", 1, 60_000, now + 1).allowed, true);
  assert.equal(policy.consumeRequestLimit("pairing", "ip-a", 1, 60_000, now + 1).allowed, true);
});
