import type { Report, ReportEntry } from "./summary.js";
import type { Entry } from "./types.js";

function shanghaiDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export function includeEntryInTomorrowBrief(entry: Entry, dateKey: string): boolean {
  const scheduled = entry.scheduledDate || (entry.reminderAt ? shanghaiDate(entry.reminderAt) : undefined);
  // 明日简报只接收明确落在明天的记录；无日期待办属于积压事项，不能让模型自行猜测何时处理。
  return scheduled === dateKey;
}

export function explicitTomorrowChecklist(entries: ReportEntry[]): string[] {
  const items: string[] = [];
  const add = (raw: string, prefix = "") => {
    let item = raw.trim()
      .replace(/（来源：[^）]+）/g, "")
      .replace(/(?:上交|提交|谢谢配合|家长督促)+[！!。,.，\s]*$/g, "")
      .trim();
    if (!item || /^(?:谢谢配合|家长督促)$/.test(item)) return;
    if (prefix && !item.startsWith(prefix)) item = `${prefix}${item}`;
    if (item.length >= 2 && item.length <= 100 && !items.includes(item)) items.push(item);
  };
  for (const entry of entries) {
    if (entry.category !== "资料" && entry.category !== "QQ群任务") continue;
    const text = entry.description.replace(/\r/g, "");
    for (const match of text.matchAll(/(语文|数学|英语)包括[：:]?([^。！？\n]+)/g)) {
      for (const part of String(match[2] || "").split(/[、，,；;]/)) add(part, `${match[1]}：`);
    }
    for (const match of text.matchAll(/请(?:带好|带齐|带上|携带)[：:]?([^。！？\n]+)/g)) {
      let detail = String(match[1] || "").replace(/（来源：[^）]+）/g, "");
      const subjects = detail.match(/^((?:语文|数学|英语)(?:、(?:语文|数学|英语))*)的暑假作业/);
      if (subjects) {
        for (const subject of subjects[1].split("、")) add(`${subject}暑假作业`);
        detail = detail.slice(subjects[0].length).replace(/^[，,、\s]+/, "");
      }
      for (const part of detail.split(/[、，,；;]|(?<=收纳箱)和|(?<=桌垫)和/)) {
        add(part);
      }
    }
  }
  return items.slice(0, 12);
}

function normalizedChecklistItem(value: string): string {
  return value.replace(/^带上[：:]?/, "").replace(/[\s，。！？、,.!?：:]/g, "");
}

export function finalizeTomorrowReport(report: Report, entries: ReportEntry[]): Report {
  const forbiddenDate = /昨天|昨日|下个月|下月/;
  const required = explicitTomorrowChecklist(entries).filter((item) => !forbiddenDate.test(item));
  const requiredNormalized = required.map(normalizedChecklistItem);
  const generated = (report.checklist || []).filter((item) => {
    if (forbiddenDate.test(item)) return false;
    const normalized = normalizedChecklistItem(item);
    // 明确物品由程序逐项列出，丢弃模型生成的合并或改写版本，避免重复和截断。
    return !requiredNormalized.some((requiredItem) =>
      normalized === requiredItem || normalized.includes(requiredItem) || requiredItem.includes(normalized));
  });
  const checklist = [...required.map((item) => `带上：${item}`), ...generated]
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 18);
  return {
    ...report,
    overview: report.overview || (checklist.length
      ? "明天有明确的准备事项，今晚请按清单逐项核对，避免遗漏。"
      : "明天暂无明确安排。"),
    checklist,
    preparations: report.preparations?.length
      ? report.preparations.filter((item) => !forbiddenDate.test(item))
      : checklist.length ? ["今晚把明天要带的物品和作业集中放好，并逐项核对。"] : [],
    highlights: report.highlights.filter((item) => !forbiddenDate.test(item)),
    improvements: report.improvements.filter((item) => !forbiddenDate.test(item)),
    suggestions: report.suggestions.filter((item) => !forbiddenDate.test(item)),
  };
}
