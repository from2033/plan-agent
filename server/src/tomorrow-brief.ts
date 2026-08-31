import type { Report, ReportEntry } from "./summary.js";
import type { Entry } from "./types.js";
import "./agent-standards.js";
import { createCapabilityTask, verifyAgentTask } from "./agent-contract.js";

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
    if (!item || /^(?:谢谢配合|家长督促|过来|作业的|明天补交来)$/.test(item)) return;
    if (/^(?:每天|前一个月|一个月后)/.test(item) || /(?:都会|将收上来|继续检查)$/.test(item)) return;
    if (prefix && !item.startsWith(prefix)) item = `${prefix}${item}`;
    if (item.length >= 2 && item.length <= 100 && !items.includes(item)) items.push(item);
  };
  for (const entry of entries) {
    if (entry.category !== "资料" && entry.category !== "QQ群任务") continue;
    // 群任务的 description 可能被清洗成第一句；raw 才是完整通知，验收时必须同时审计两者。
    const text = `${entry.description}\n${entry.raw}`.replace(/\r/g, "");
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
    // 覆盖“还要带…/记得带…/带2本…”等不以“请”开头的通知表达。
    for (const match of text.matchAll(/(?:还要|还需|需要|记得|务必)?\s*(?:带好|带齐|带上|携带|带)\s*([^。！？\n]+)/g)) {
      for (const part of String(match[1] || "").split(/[、，,；;和与及]/)) add(part);
    }
    // “告家长书请签好，明天带过来”里的宾语出现在“带”之前，需要单独保留。
    if (/告家长书[^。！？\n]{0,40}(?:明天|次日)[^。！？\n]{0,12}带/.test(text)) add("告家长书");
  }
  return items.slice(0, 12);
}

function normalizedChecklistItem(value: string): string {
  return value.replace(/^带上[：:]?/, "").replace(/[\s，。！？、,.!?：:]/g, "");
}

export function finalizeTomorrowReport(report: Report, entries: ReportEntry[]): Report {
  const forbiddenDate = /昨天|昨日|下个月|下月/;
  const unsafeGenerated = /(?:\bWait\b|\bNeed exact\b|\bI must\b|不能引入等价|模型提示|^带上[：:]?(?:过来|作业的|明天补交来)$)/i;
  const required = explicitTomorrowChecklist(entries).filter((item) => !forbiddenDate.test(item));
  const requiredNormalized = required.map(normalizedChecklistItem);
  const generated = (report.checklist || []).filter((item) => {
    if (forbiddenDate.test(item) || unsafeGenerated.test(item) || item.length > 120) return false;
    const normalized = normalizedChecklistItem(item);
    // 明确物品由程序逐项列出，丢弃模型生成的合并或改写版本，避免重复和截断。
    return !requiredNormalized.some((requiredItem) =>
      normalized === requiredItem || normalized.includes(requiredItem) || requiredItem.includes(normalized));
  });
  const checklist = [...required.map((item) => `带上：${item}`), ...generated]
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 18);
  const verification = verifyAgentTask(
    createCapabilityTask<{ required: string[] }, Report>({ id: `tomorrow-${Date.now()}`, capability: "tomorrow_brief", input: { required } }),
    { ...report, checklist },
  );
  if (verification.stage === "failed") throw new Error(`tomorrow_brief_acceptance_failed:${verification.failures.join(";")}`);
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
