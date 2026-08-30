import assert from "node:assert/strict";
import test from "node:test";

import { explicitTomorrowChecklist, includeEntryInTomorrowBrief } from "../src/tomorrow-brief.js";
import type { Entry } from "../src/types.js";

function memo(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    type: "memo",
    raw: "",
    time: "",
    description: "事项",
    category: "备忘",
    timestamp: "2026-08-30T08:00:00.000Z",
    done: false,
    ...overrides,
  };
}

test("明日简报排除昨天和下个月，只保留明天及无日期未完成待办", () => {
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-08-29" }), "2026-08-31"), false);
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-09-30" }), "2026-08-31"), false);
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-08-31" }), "2026-08-31"), true);
  assert.equal(includeEntryInTomorrowBrief(memo({}), "2026-08-31"), true);
});

test("群消息的必带物品逐项保留", () => {
  const items = explicitTomorrowChecklist([{
    type: "knowledge",
    category: "资料",
    description: "明天报到请带好收纳箱和桌垫。语文包括打印的暑假作业、练字帖、默写本、气象研学的工程日志（选择气象实验的请将制作的模型带来）。",
  }]);
  assert.ok(items.includes("练字帖"));
  assert.ok(items.includes("默写本"));
  assert.ok(items.includes("打印的暑假作业"));
  assert.ok(items.some((item) => item.includes("工程日志")));
});
