import type { ReportEntry } from "./summary.js";
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
  return scheduled === dateKey
    || (entry.type === "memo" && !entry.done && !entry.scheduledDate && !entry.reminderAt);
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
