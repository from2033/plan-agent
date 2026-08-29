import crypto from "node:crypto";
import type { Entry } from "./types.js";

export interface QqTaskMessage {
  externalId: string;
  groupId: string;
  groupName: string;
  sender: string;
  content: string;
  sentAt: string;
}

const ACTION_RE = /(提交|上交|交作业|完成|做完|填写|上传|发送|发到|下载|购买|带齐|带上|携带|到校|返校|参加|开会|报名|缴费|支付|打印|准备|回复|确认|领取|归还|打卡|复习|订正|检查|值班|护学岗|考试|测验|上课|放学|接送)/;
const DATE_RE = /(今天|今日|今晚|明天|明晚|后天|(?:本|这|下下|下)?(?:周|星期|礼拜)[一二三四五六日天]|(?:\d{4}[年./-])?\d{1,2}[月./-]\d{1,2}日?)/g;
const IGNORE_RE = /^(收到|好的|谢谢|感谢|欢迎|辛苦|祝|已完成|已经完成|已提交|已经提交|不用|取消)[！!。,.，\s]/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiParts(value: string | Date): { year: number; month: number; day: number; weekday: number } {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return ymd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function resolveDate(text: string, sentAt: string): string | undefined {
  const base = shanghaiParts(sentAt);
  const baseDate = ymd(base.year, base.month, base.day);
  if (/(后天)/.test(text)) return addDays(baseDate, 2);
  if (/(明天|明晚)/.test(text)) return addDays(baseDate, 1);
  if (/(今天|今日|今晚)/.test(text)) return baseDate;

  const weekdayMatch = text.match(/(本|这|下下|下)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const target = "日一二三四五六".indexOf(weekdayMatch[2] === "天" ? "日" : weekdayMatch[2]);
    const prefix = weekdayMatch[1] || "";
    let delta = (target - base.weekday + 7) % 7;
    if (prefix === "下") delta += 7;
    if (prefix === "下下") delta += 14;
    return addDays(baseDate, delta);
  }

  const full = text.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/);
  if (full) return ymd(Number(full[1]), Number(full[2]), Number(full[3]));
  const short = text.match(/(\d{1,2})[月./-](\d{1,2})日?/);
  if (short) {
    let year = base.year;
    let candidate = ymd(year, Number(short[1]), Number(short[2]));
    if (candidate < baseDate) candidate = ymd(year + 1, Number(short[1]), Number(short[2]));
    return candidate;
  }
  return undefined;
}

function inferTime(text: string): string {
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上|晚间)?\s*(\d{1,2})(?::|：|点)(\d{1,2})?\s*分?/);
  if (!match) return "";
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  if (/(下午|晚上|晚间)/.test(match[1] || "") && hour < 12) hour += 12;
  if ((match[1] || "") === "中午" && hour < 11) hour += 12;
  if ((match[1] || "") === "凌晨" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function scheduledTimestamp(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time || "09:00").split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute)).toISOString();
}

function splitSegments(content: string): string[] {
  const initial = content
    .replace(/@[全体成员all]+/gi, " ")
    .split(/[\n；;。！？!?]|[✅☑️🔔📌]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const segments: string[] = [];
  for (const part of initial) {
    const markers = [...part.matchAll(DATE_RE)].map((match) => match.index || 0);
    if (markers.length <= 1) {
      segments.push(part);
      continue;
    }
    for (let i = 0; i < markers.length; i += 1) {
      const prefix = i === 0 ? part.slice(0, markers[i]).trim() : "";
      segments.push(`${prefix}${part.slice(markers[i], markers[i + 1] ?? part.length)}`.trim());
    }
  }
  return segments;
}

function cleanDescription(segment: string): string {
  return segment
    .replace(/^[\s:：,，、\-—]+/, "")
    .replace(/^(重要)?(时间)?(通知|提醒|安排)[：:]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractQqTasks(message: QqTaskMessage, today = new Date()): Entry[] {
  const current = shanghaiParts(today);
  const currentDate = ymd(current.year, current.month, current.day);
  const seen = new Set<string>();
  const entries: Entry[] = [];

  for (const segment of splitSegments(message.content)) {
    if (!ACTION_RE.test(segment) || IGNORE_RE.test(segment)) continue;
    const scheduledDate = resolveDate(segment, message.sentAt);
    if (!scheduledDate || scheduledDate < currentDate) continue;
    const description = cleanDescription(segment);
    const normalized = description.replace(/[\s，。！？、,.!?]/g, "").toLowerCase();
    const fingerprint = `${message.externalId}\n${scheduledDate}\n${normalized}`;
    const id = `qq-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const time = inferTime(segment);
    entries.push({
      id,
      type: "memo",
      raw: message.content,
      time,
      description: `${description}（来源：${message.groupName} · ${message.sender}）`,
      category: "QQ群任务",
      priority: "medium",
      done: false,
      scheduledDate,
      timestamp: scheduledTimestamp(scheduledDate, time),
    });
  }
  return entries;
}
