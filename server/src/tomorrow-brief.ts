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
  for (const entry of entries) {
    if (entry.category !== "资料" && entry.category !== "QQ群任务") continue;
    const text = entry.description.replace(/\r/g, "");
    const patterns = [
      /(?:语文|数学|英语)?包括[：:]?([^。！？\n]+)/g,
      /请(?:带好|带齐|带上|携带)[：:]?([^。！？\n]+)/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const detail = String(match[1] || "").replace(/（来源：[^）]+）/g, "");
        for (const part of detail.split(/[、，,；;]|(?<=收纳箱)和|(?<=练字帖)和|(?<=默写本)和/)) {
          const item = part.trim().replace(/^(?:语文|数学|英语)包括[：:]?/, "");
          if (item.length >= 2 && item.length <= 100 && !items.includes(item)) items.push(item);
        }
      }
    }
  }
  return items.slice(0, 12);
}
