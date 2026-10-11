export interface AssistantClock {
  currentDate: string;
  currentTime: string;
  timeZone: "Asia/Shanghai";
}

function partsAtShanghai(now: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function assistantClock(now = new Date()): AssistantClock {
  const parts = partsAtShanghai(now);
  return {
    currentDate: `${parts.year}-${parts.month}-${parts.day}`,
    currentTime: `${parts.hour}:${parts.minute}`,
    timeZone: "Asia/Shanghai",
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function relativeReminderMilliseconds(raw: string): number | undefined {
  if (/(?:半个?|半)小时(?:之?后|以后)/.test(raw)) return 30 * 60_000;
  if (/(?:一刻钟|一刻)(?:之?后|以后)/.test(raw)) return 15 * 60_000;
  const match = raw.match(
    /(\d{1,4}|[零〇一二两三四五六七八九十]{1,4})\s*(分钟|分|小时|个小时|天)(?:之?后|以后)/,
  );
  if (!match) return undefined;
  const amount = chineseNumber(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (match[2] === "分钟" || match[2] === "分") return amount * 60_000;
  if (match[2] === "小时" || match[2] === "个小时") return amount * 60 * 60_000;
  return amount * 24 * 60 * 60_000;
}

function clockTimestamp(clock: AssistantClock): number {
  return new Date(`${clock.currentDate}T${clock.currentTime}:00+08:00`).getTime();
}

export function reminderTimeAt(timestamp: string): string {
  const parts = partsAtShanghai(new Date(timestamp));
  return `${parts.hour}:${parts.minute}`;
}

export function inferDateFromText(raw: string, currentDate: string): string | undefined {
  if (/大后天/.test(raw)) return addDays(currentDate, 3);
  if (/后天/.test(raw)) return addDays(currentDate, 2);
  if (/明天|明日|明早|明晨|明晚/.test(raw)) return addDays(currentDate, 1);
  if (/今天|今日/.test(raw)) return currentDate;

  const full = raw.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})[日号]?/);
  if (full) {
    const value = `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
    if (validDate(value)) return value;
  }

  const monthDay = raw.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (monthDay) {
    const year = Number(currentDate.slice(0, 4));
    let value = `${year}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
    if (validDate(value) && value < currentDate) {
      value = `${year + 1}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
    }
    if (validDate(value)) return value;
  }
  return undefined;
}

export function hasExplicitDateExpression(raw: string): boolean {
  return /(?:今天|今日|明天|明日|明早|明晨|明晚|后天|大后天|(?:本|这|下|下下)?(?:周|星期|礼拜)[一二三四五六日天]|20\d{2}[\u5e74/-]\d{1,2}[\u6708/-]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号])/.test(raw);
}

// 旧版会把未来活动的目标日期只编码在 timestamp 中，没有保存 scheduledDate。
// 仅识别明确面向未来的相对日期，避免把“今天学习了”这类已发生记录修成待办。
export function hasFutureRelativeDateExpression(raw: string): boolean {
  return /(?:明天|明日|后天|大后天|(?:下|下下)(?:周|星期|礼拜)(?:[一二三四五六日天])?)/.test(raw);
}

// 日期已经结构化保存后，展示文案不应继续保留会随时间失效的“今天/明天”。
// 只清理句首日期，避免误伤“准备好明天的材料”这类把相对日期作为宾语的描述。
export function normalizeScheduledDescription(description: string): string {
  const original = description.trim();
  const normalized = original.replace(
    /^(?:请\s*)?(?:(?:提醒我|记得|别忘(?:了)?)(?:在)?\s*)?(?:大后天|后天|明天|明日|明早|明晚|明晨|今天|今日|今早|今晚|今晨|(?:本|这|下|下下)(?:周|星期|礼拜)(?:[一二三四五六日天])?)\s*[，,、:：-]?\s*/,
    "",
  ).trim();
  return normalized || original;
}

function normalizeHour(hour: number, period: string | undefined): number {
  if (period === "晚上" || period === "今晚" || period === "明晚" || period === "夜里") {
    if (hour === 12) return 0;
    return hour >= 1 && hour < 12 ? hour + 12 : hour;
  }
  if (period === "下午") {
    return hour >= 1 && hour < 12 ? hour + 12 : hour;
  }
  if (period === "中午") {
    return hour >= 1 && hour < 11 ? hour + 12 : hour;
  }
  if ((period === "凌晨" || period === "明晨") && hour === 12) return 0;
  if ((period === "上午" || period === "早上" || period === "明早") && hour === 12) return 0;
  return hour;
}

function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return [...value].reduce((result, char) => result * 10 + (digits[char] ?? 0), 0);
}

function hhmm(hourText: string, minuteText: string | undefined, period: string | undefined): string | undefined {
  const hour = normalizeHour(chineseNumber(hourText), period);
  const minute = minuteText ? chineseNumber(minuteText) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function inferTimeRangeFromText(
  raw: string,
): { start: string; end: string } | undefined {
  const match = raw.match(
    /(凌晨|早上|上午|中午|下午|晚上|今晚|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：](\d{1,2}|[零〇一二两三四五六七八九十]{1,3})|点(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})分?)?)?\s*(?:到|至|[-–—~～])\s*(凌晨|早上|上午|中午|下午|晚上|今晚|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：](\d{1,2}|[零〇一二两三四五六七八九十]{1,3})|点(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})分?)?)?/,
  );
  if (!match) return undefined;
  const startPeriod = match[1];
  const endPeriod = match[5] || startPeriod;
  const start = hhmm(match[2], match[3] || match[4], startPeriod);
  const end = hhmm(match[6], match[7] || match[8], endPeriod);
  return start && end ? { start, end } : undefined;
}

export function inferReminderTimeFromText(raw: string): string | undefined {
  const matches = [...raw.matchAll(
    /(凌晨|早上|上午|明早|明晨|中午|下午|晚上|今晚|明晚|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：](\d{1,2}|[零〇一二两三四五六七八九十]{1,3})|点(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})分?)?)/g,
  )].map((match) => ({
    match,
    time: hhmm(match[2], match[3] || match[4], match[1]),
    score: Number(Boolean(match[1])) * 100 + Number(Boolean(match[3] || match[4])) * 10 + (match.index || 0),
  })).filter((candidate) => candidate.time);
  matches.sort((left, right) => left.score - right.score);
  return matches.at(-1)?.time;
}

export interface TemporalModelField {
  type: string;
  date?: string;
  reminderTime?: string;
  dateEvidence?: string;
  timeEvidence?: string;
}

export interface TemporalValidationResult {
  ok: boolean;
  issues: string[];
}

function hasUnambiguousClock(raw: string): boolean {
  return /(?:凌晨|早上|上午|明早|明晨|中午|下午|晚上|今晚|明晚|夜里)\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：]|点)/.test(raw)
    || /(?:1[3-9]|2[0-3])[:：点]/.test(raw);
}

export function validateTemporalModelFields(
  raw: string,
  clock: AssistantClock,
  fields: TemporalModelField[],
  requireEvidence = true,
): TemporalValidationResult {
  const issues: string[] = [];
  const single = fields.length === 1;
  let explicitDate = single ? inferDateFromText(raw, clock.currentDate) : undefined;
  const explicitTime = single && hasUnambiguousClock(raw) ? inferReminderTimeFromText(raw) : undefined;
  if (explicitDate && explicitTime === "00:00" && /今晚\s*(?:12|十二)点/.test(raw)) {
    explicitDate = addDays(explicitDate, 1);
  }
  fields.forEach((field, index) => {
    const dateEvidence = field.dateEvidence?.trim() || "";
    const timeEvidence = field.timeEvidence?.trim() || "";
    if (field.date) {
      if (requireEvidence && (!dateEvidence || !raw.includes(dateEvidence))) issues.push(`field_${index}_date_evidence`);
      let evidenceDate = dateEvidence ? inferDateFromText(dateEvidence, clock.currentDate) : undefined;
      if (
        evidenceDate
        && field.reminderTime === "00:00"
        && /今晚\s*(?:12|十二)点/.test(`${dateEvidence}${timeEvidence}`)
      ) {
        evidenceDate = addDays(evidenceDate, 1);
      }
      if (evidenceDate && evidenceDate !== field.date) issues.push(`field_${index}_date_mismatch`);
    } else if (dateEvidence) {
      issues.push(`field_${index}_unexpected_date_evidence`);
    }
    if (explicitDate && field.date !== explicitDate) issues.push(`field_${index}_explicit_date_mismatch`);
    if (field.reminderTime) {
      if (requireEvidence && (!timeEvidence || !raw.includes(timeEvidence))) issues.push(`field_${index}_time_evidence`);
      const evidenceTime = timeEvidence ? inferReminderTimeFromText(timeEvidence) : undefined;
      if (evidenceTime && evidenceTime !== field.reminderTime) issues.push(`field_${index}_time_mismatch`);
    } else if (timeEvidence) {
      issues.push(`field_${index}_unexpected_time_evidence`);
    }
    if (explicitTime && field.type === "memo" && field.reminderTime !== explicitTime) {
      issues.push(`field_${index}_explicit_time_mismatch`);
    }
  });
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

export function reminderTimestamp(
  raw: string,
  explicitDate: string | undefined,
  explicitTime: string | undefined,
  clock: AssistantClock,
): string | undefined {
  const relativeMilliseconds = relativeReminderMilliseconds(raw);
  if (relativeMilliseconds) {
    return new Date(clockTimestamp(clock) + relativeMilliseconds).toISOString();
  }
  const time = explicitTime || inferReminderTimeFromText(raw);
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  let date = validDate(explicitDate || "")
    ? explicitDate
    : inferDateFromText(raw, clock.currentDate) || clock.currentDate;
  if (
    date === clock.currentDate &&
    time === "00:00" &&
    /(?:今晚|晚上|夜里)\s*(?:12|十二)点/.test(raw)
  ) {
    date = addDays(date, 1);
  }
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

export function isFutureObligation(
  raw: string,
  explicitDate: string | undefined,
  explicitTime: string | undefined,
  clock: AssistantClock,
): boolean {
  // 用药类短句经常省略“提醒我/记得”等祈使词（例如“8点30拿药”），
  // 但带有明确时刻时应按提醒处理，不能只作为普通活动保存。
  const obligation = /(?:需要|必须|务必|得要|得去|一定要|别忘|记得|提醒我|拿药|取药|吃药|服药|喂药)/.test(raw);
  const explicitlyPending = /(?:待办|待使用|待领取|待兑换|待处理|待办理|待支付|待缴费|待提交|待回复|待确认|未使用|未领取|未兑换|还没使用|还没处理)/.test(raw)
    || /(?:优惠券|礼包|权益).*(?:没有用|没用|没使用)/.test(raw);
  if (!obligation && !explicitlyPending) return false;
  const timestamp = reminderTimestamp(raw, explicitDate, explicitTime, clock);
  if (timestamp) return new Date(timestamp).getTime() > clockTimestamp(clock);
  const date = explicitDate || inferDateFromText(raw, clock.currentDate);
  if (date) return validDate(date) && date >= clock.currentDate;
  return explicitlyPending || (obligation && !/(?:已经|刚刚|完成了|处理了|使用了|领取了)/.test(raw));
}

export function entryTiming(
  raw: string,
  explicitDate: string | undefined,
  timeRange: { start: string; end: string } | undefined,
  clock: AssistantClock,
  index: number,
  now = new Date(),
): { time: string; timestamp: string } {
  const inferredDate = validDate(explicitDate || "")
    ? explicitDate
    : inferDateFromText(raw, clock.currentDate);
  const targetDate = inferredDate || (timeRange ? clock.currentDate : undefined);
  if (!targetDate) {
    return {
      time: clock.currentTime,
      timestamp: new Date(now.getTime() + index).toISOString(),
    };
  }
  const displayTime = timeRange?.start || "";
  const sortTime = displayTime || "12:00";
  return {
    time: displayTime,
    timestamp: new Date(`${targetDate}T${sortTime}:00+08:00`).toISOString(),
  };
}
