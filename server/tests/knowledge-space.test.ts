import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { knowledgeSpaceIdForUser } = await import("../src/knowledge-space.js");

test("账号资料空间编号稳定且互相隔离", () => {
  const first = knowledgeSpaceIdForUser("user-1");
  const repeated = knowledgeSpaceIdForUser("user-1");
  const second = knowledgeSpaceIdForUser("user-2");

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /user-1/);
});
