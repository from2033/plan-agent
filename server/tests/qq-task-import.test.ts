import assert from "node:assert/strict";
import test from "node:test";

import { extractQqTasks, type QqTaskMessage } from "../src/qq-task-import.js";

const now = new Date("2026-08-29T04:00:00.000Z");

function message(content: string, overrides: Partial<QqTaskMessage> = {}): QqTaskMessage {
  return {
    externalId: "group-100:message-200",
    groupId: "100",
    groupName: "三年级一班",
    sender: "王老师",
    content,
    sentAt: "2026-08-29T02:00:00.000Z",
    ...overrides,
  };
}

test("有明确日期的群任务进入待办但不生成闹钟", () => {
  const [entry] = extractQqTasks(message("8月31日上午8:30到校，带齐暑假作业"), now);
  assert.equal(entry.type, "memo");
  assert.equal(entry.scheduledDate, "2026-08-31");
  assert.equal(entry.time, "08:30");
  assert.equal(entry.reminderAt, undefined);
  assert.match(entry.description, /三年级一班 · 王老师/);
});

test("群消息里的周几按消息发送日期解析", () => {
  const [entry] = extractQqTasks(message("周日晚前上交周记"), now);
  assert.equal(entry.scheduledDate, "2026-08-30");
  assert.equal(entry.reminderAt, undefined);
});

test("下周按下一个自然周解析而不是额外多加一周", () => {
  const [entry] = extractQqTasks(message("下周一上午8点到校报到"), now);
  assert.equal(entry.scheduledDate, "2026-08-31");
  assert.equal(entry.time, "08:00");
});

test("截止日前做完或上传的表述也会成为待办", () => {
  const [entry] = extractQqTasks(message("请在9月2日前填写资料并上传到群里"), now);
  assert.equal(entry.scheduledDate, "2026-09-02");
  assert.equal(entry.reminderAt, undefined);
});

test("一条通知里的多个日期拆成多个待办", () => {
  const entries = extractQqTasks(message("重要时间提醒：8月31日上午8:30到校。9月1日正式上课。"), now);
  assert.deepEqual(entries.map((entry) => entry.scheduledDate), ["2026-08-31", "2026-09-01"]);
});

test("闲聊和没有日期的要求不自动建待办", () => {
  assert.equal(extractQqTasks(message("感谢老师，大家辛苦了"), now).length, 0);
  assert.equal(extractQqTasks(message("记得带齐作业"), now).length, 0);
});

test("相同 QQ 消息生成稳定 id 供服务端去重", () => {
  const first = extractQqTasks(message("明天提交报名表"), now)[0];
  const second = extractQqTasks(message("明天提交报名表"), now)[0];
  assert.equal(first.id, second.id);
});
