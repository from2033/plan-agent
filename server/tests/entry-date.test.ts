import assert from "node:assert/strict";
import test from "node:test";

import {
  isFutureObligation,
  hasExplicitDateExpression,
  hasFutureRelativeDateExpression,
  inferReminderTimeFromText,
  normalizeScheduledDescription,
  reminderTimeAt,
  reminderTimestamp,
  validateTemporalModelFields,
  type AssistantClock,
} from "../src/entry-date.js";
import { parseWithRegex } from "../src/parse.js";

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

test("明确时刻的拿药短句自动作为提醒", () => {
  assert.equal(isFutureObligation("8点30拿药", undefined, "08:30", {
    currentDate: "2026-08-18",
    currentTime: "07:00",
    timeZone: "Asia/Shanghai",
  }), true);
  assert.equal(
    reminderTimestamp("8点30拿药", undefined, "08:30", {
      currentDate: "2026-08-18",
      currentTime: "07:00",
      timeZone: "Asia/Shanghai",
    }),
    "2026-08-18T00:30:00.000Z",
  );
});

test("正则回退也能把8点30拿药解析为带提醒时间的备忘", () => {
  const [entry] = parseWithRegex("8点30拿药");
  assert.equal(entry.type, "memo");
  assert.equal(entry.reminderTime, "08:30");
  assert.equal(entry.category, "备忘");
});

test("明确未完成的权益即使没日期也是待办", () => {
  assert.equal(
    isFutureObligation("平安好车主有优惠券待使用", undefined, undefined, clock),
    true,
  );
  assert.equal(
    isFutureObligation("平安好车主优惠券已经使用了", undefined, undefined, clock),
    false,
  );
  assert.equal(
    isFutureObligation("我需要买牛奶", undefined, undefined, clock),
    true,
  );
  assert.equal(
    isFutureObligation("平安好车主还有礼包没有用", undefined, undefined, clock),
    true,
  );
});

test("只接受用户真正说出的日期", () => {
  assert.equal(hasExplicitDateExpression("平安好车主还有礼包没有用"), false);
  assert.equal(hasExplicitDateExpression("今天把平安好车主礼包用了"), true);
  assert.equal(hasExplicitDateExpression("下周一交材料"), true);
  assert.equal(hasExplicitDateExpression("9月3日交材料"), true);
});

test("旧版活动修复只接受面向未来的相对日期", () => {
  assert.equal(hasFutureRelativeDateExpression("明天带孩子理发"), true);
  assert.equal(hasFutureRelativeDateExpression("下周一交材料"), true);
  assert.equal(hasFutureRelativeDateExpression("今天请朋友吃饭"), false);
  assert.equal(hasFutureRelativeDateExpression("今天进行了学习"), false);
});

test("结构化日期后的展示文案不保留会过期的相对日期", () => {
  assert.equal(normalizeScheduledDescription("明天带孩子理发"), "带孩子理发");
  assert.equal(normalizeScheduledDescription("提醒我下周一交材料"), "交材料");
  assert.equal(normalizeScheduledDescription("今晚12点需要上线"), "12点需要上线");
  assert.equal(normalizeScheduledDescription("准备好明天的材料"), "准备好明天的材料");
});

test("有日期没时间的必做事项仍然是待办但不生成闹钟", () => {
  assert.equal(
    isFutureObligation("明天需要交水费", "2026-08-19", undefined, clock),
    true,
  );
  assert.equal(
    reminderTimestamp("明天需要交水费", "2026-08-19", undefined, clock),
    undefined,
  );
});

test("重复口述时选择最后一个更完整的时刻", () => {
  assert.equal(
    inferReminderTimeFromText("今天六点今天晚上6点40，提醒我把风扇带上去充电"),
    "18:40",
  );
});

test("模型时间结果必须与原话证据一致", () => {
  const context: AssistantClock = {
    currentDate: "2026-09-02",
    currentTime: "13:00",
    timeZone: "Asia/Shanghai",
  };
  assert.equal(validateTemporalModelFields(
    "今晚6点40提醒我把风扇带上去充电",
    context,
    [{ type: "memo", date: "2026-09-02", reminderTime: "18:40", dateEvidence: "今晚", timeEvidence: "今晚6点40" }],
  ).ok, true);
  const invalid = validateTemporalModelFields(
    "今晚6点40提醒我把风扇带上去充电",
    context,
    [{ type: "memo", date: "2026-09-02", reminderTime: "20:40", dateEvidence: "今晚", timeEvidence: "今晚6点40" }],
  );
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes("field_0_time_mismatch"));
});

test("今晚十二点允许跨到次日但证据仍须来自原话", () => {
  const context: AssistantClock = {
    currentDate: "2026-09-02",
    currentTime: "13:00",
    timeZone: "Asia/Shanghai",
  };
  assert.equal(validateTemporalModelFields(
    "今晚12点提醒我上线",
    context,
    [{ type: "memo", date: "2026-09-03", reminderTime: "00:00", dateEvidence: "今晚", timeEvidence: "今晚12点" }],
  ).ok, true);
});

test("没有待办语义的健康记录不能误分为备忘", () => {
  const result = validateTemporalModelFields(
    "记录9月2号体重120.7斤",
    { currentDate: "2026-09-03", currentTime: "08:00", timeZone: "Asia/Shanghai" },
    [{ type: "memo", date: "2026-09-02", dateEvidence: "9月2号" }],
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("field_0_memo_without_action_evidence"));
});
