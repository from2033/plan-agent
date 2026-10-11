import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_PATH = ":memory:";
process.env.DB_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
delete process.env.FCM_SERVICE_ACCOUNT_JSON;
delete process.env.FCM_SERVICE_ACCOUNT_PATH;

const push = await import("../src/push-notifications.js");

test("push token registers per account and can move between accounts", () => {
  push.registerPushDevice("user-1", "token-a", "ios");
  assert.equal(push.pushDeviceCount("user-1"), 1);
  push.registerPushDevice("user-2", "token-a", "ios");
  assert.equal(push.pushDeviceCount("user-1"), 0);
  assert.equal(push.pushDeviceCount("user-2"), 1);
});

test("push token can only be removed by its current owner", () => {
  push.registerPushDevice("user-1", "token-b", "ios");
  assert.equal(push.unregisterPushDevice("user-2", "token-b"), false);
  assert.equal(push.unregisterPushDevice("user-1", "token-b"), true);
  assert.equal(push.pushDeviceCount("user-1"), 0);
});

test("send reports an explicit unconfigured result without credentials", async () => {
  const result = await push.sendPushToUser("user-1", "title", "body");
  assert.deepEqual(result, {
    configured: false,
    attempted: 0,
    sent: 0,
    failed: 0,
  });
});
