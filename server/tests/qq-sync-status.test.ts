import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_PATH = ":memory:";
const status = await import("../src/qq-sync-status.js");

test("QQ 采集心跳区分在线、离线和过期", () => {
  status.recordQqCollectorStatus({
    connected: true,
    accountLabel: "采集账号",
    checkedAt: "2026-08-30T10:00:00.000Z",
  });
  assert.equal(status.getQqSyncStatus(true, new Date("2026-08-30T10:02:00.000Z")).state, "online");
  assert.equal(status.getQqSyncStatus(true, new Date("2026-08-30T10:04:00.000Z")).state, "stale");
  status.recordQqCollectorStatus({ connected: false, checkedAt: "2026-08-30T10:05:00.000Z" });
  assert.equal(status.getQqSyncStatus(true, new Date("2026-08-30T10:06:00.000Z")).state, "offline");
});

test("消息同步时间和群消息时间分别保留", () => {
  status.recordQqMessageSync("2026-08-30T04:27:37.000Z");
  const value = status.getQqSyncStatus(true, new Date("2026-08-30T10:06:00.000Z"));
  assert.equal(value.lastMessageAt, "2026-08-30T04:27:37.000Z");
  assert.ok(value.lastSuccessfulSyncAt);
});
