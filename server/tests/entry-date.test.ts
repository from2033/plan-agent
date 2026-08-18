import assert from "node:assert/strict";
import test from "node:test";

import {
  reminderTimeAt,
  reminderTimestamp,
  type AssistantClock,
} from "../src/entry-date.js";

const clock: AssistantClock = {
  currentDate: "2026-08-18",
  currentTime: "23:50",
  timeZone: "Asia/Shanghai",
};

test("一分钟之后跨过模型错误的绝对时间，按当前时刻计算", () => {
  const timestamp = reminderTimestamp("一分钟之后提醒我睡觉。", "2026-08-18", "00:00", clock);
  assert.equal(timestamp, "2026-08-18T15:51:00.000Z");
  assert.equal(reminderTimeAt(timestamp!), "23:51");
});

test("相对小时提醒可以跨天", () => {
  const timestamp = reminderTimestamp("两小时后提醒我关灯", undefined, undefined, clock);
  assert.equal(timestamp, "2026-08-18T17:50:00.000Z");
  assert.equal(reminderTimeAt(timestamp!), "01:50");
});

test("半小时和一刻钟提醒", () => {
  assert.equal(
    reminderTimestamp("半小时后叫我", undefined, undefined, clock),
    "2026-08-18T16:20:00.000Z",
  );
  assert.equal(
    reminderTimestamp("一刻钟以后提醒我", undefined, undefined, clock),
    "2026-08-18T16:05:00.000Z",
  );
});

test("绝对时间提醒保持原有行为", () => {
  const timestamp = reminderTimestamp("明天下午三点提醒我打电话", "2026-08-19", "15:00", clock);
  assert.equal(timestamp, "2026-08-19T07:00:00.000Z");
  assert.equal(reminderTimeAt(timestamp!), "15:00");
});
