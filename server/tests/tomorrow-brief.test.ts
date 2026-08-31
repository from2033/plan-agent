import assert from "node:assert/strict";
import test from "node:test";

import { explicitTomorrowChecklist, finalizeTomorrowReport, includeEntryInTomorrowBrief } from "../src/tomorrow-brief.js";
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

test("明日简报排除昨天、下个月和无日期待办，只保留明确属于明天的事项", () => {
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-08-29" }), "2026-08-31"), false);
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-09-30" }), "2026-08-31"), false);
  assert.equal(includeEntryInTomorrowBrief(memo({ scheduledDate: "2026-08-31" }), "2026-08-31"), true);
  assert.equal(includeEntryInTomorrowBrief(memo({}), "2026-08-31"), false);
});

test("群消息的必带物品逐项保留", () => {
  const items = explicitTomorrowChecklist([{
    type: "knowledge",
    category: "资料",
    description: "明天报到请带好收纳箱和桌垫。语文包括打印的暑假作业、练字帖、默写本、气象研学的工程日志（选择气象实验的请将制作的模型带来）。",
  }]);
  assert.ok(items.includes("语文：练字帖"));
  assert.ok(items.includes("语文：默写本"));
  assert.ok(items.includes("语文：打印的暑假作业"));
  assert.ok(items.some((item) => item.includes("工程日志")));
  assert.ok(items.includes("收纳箱"));
  assert.ok(items.includes("桌垫"));
  assert.ok(!items.some((item) => item.includes("谢谢配合")));
});

test("最终明日清单逐项置顶原始物品且不被模型合并项挤掉", () => {
  const entries = [{
    type: "knowledge" as const,
    category: "资料",
    description: "明天报到请带好语文、数学、英语的暑假作业，收纳箱和桌垫。语文包括打印的暑假作业、练字帖、默写本、工程日志。",
  }];
  const report = finalizeTomorrowReport({
    overview: "明天报到。",
    checklist: ["带齐语数英暑假作业、收纳箱和桌垫", "参加昨天的家长会", "去学校报到"],
    preparations: ["准备下个月的活动", "今晚整理书包"],
    highlights: [],
    improvements: [],
    suggestions: [],
  }, entries);
  for (const item of ["带上：收纳箱", "带上：桌垫", "带上：语文：练字帖", "带上：语文：默写本"]) {
    assert.ok(report.checklist.includes(item), `${item} 应明确保留`);
  }
  assert.ok(!report.checklist.some((item) => /昨天|下个月/.test(item)));
  assert.deepEqual(report.preparations, ["今晚整理书包"]);
});

test("清单验收使用群消息原文，不能漏掉数量物品和家长书", () => {
  const items = explicitTomorrowChecklist([{
    type: "knowledge",
    category: "QQ群任务",
    description: "明天报到请带好语文、数学作业。",
    raw: "明天报到请带好语文、数学作业，还有2本作业记录本，另外要带告家长书。",
  }]);
  assert.ok(items.some((item) => /2本作业记录本/.test(item)));
  assert.ok(items.some((item) => /告家长书/.test(item)));
});

test("近期学校通知中的携带要求逐项保留", () => {
  const items = explicitTomorrowChecklist([{
    type: "knowledge",
    category: "资料",
    description: "QQ群消息",
    raw: "新学期请每位家长给孩子带好作业记录本。",
  }]);
  assert.ok(items.includes("作业记录本"));
});

test("没有事项时明日管家也产生明确空状态，不返回空白报告", () => {
  const report = finalizeTomorrowReport({
    overview: "",
    checklist: [],
    preparations: [],
    highlights: [],
    improvements: [],
    suggestions: [],
  }, []);
  assert.equal(report.overview, "明天暂无明确安排。");
});

test("明日清单过滤误拆动词和模型过程文字，并确定性保留告家长书", () => {
  const entries = [{
    type: "knowledge" as const,
    category: "资料",
    description: "QQ群消息",
    raw: "新学期请每位家长给孩子带好作业记录本，每天的作业都会写在黑板上。今天发的教辅告家长书请家长签好，明天带过来。请今天没带齐作业的，明天补交来。",
  }];
  const report = finalizeTomorrowReport({
    overview: "",
    checklist: ["带上：过来", "带上：作业的", "听写本 > Wait Need exact. I must ensure strict."],
    preparations: [],
    highlights: [],
    improvements: [],
    suggestions: [],
  }, entries);
  assert.ok(report.checklist.includes("带上：作业记录本"));
  assert.ok(report.checklist.includes("带上：告家长书"));
  assert.ok(!report.checklist.some((item) => /过来|作业的|Wait|每天的作业/.test(item)));
});

test("模型把建议拼入清单时只保留首个可执行事项", () => {
  const report = finalizeTomorrowReport({
    overview: "",
    checklist: ["如在名单中，补交听写本；建议单独装袋，明天到校后确认登记。"],
    preparations: [],
    highlights: [],
    improvements: [],
    suggestions: [],
  }, []);
  assert.deepEqual(report.checklist, ["如在名单中，补交听写本"]);
});
