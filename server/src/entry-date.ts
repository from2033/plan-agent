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

export function inferDateFromText(raw: string, currentDate: string): string | undefined {
  if (/大后天/.test(raw)) return addDays(currentDate, 3);
  if (/后天/.test(raw)) return addDays(currentDate, 2);
  if (/明天|明日/.test(raw)) return addDays(currentDate, 1);
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

function normalizeHour(hour: number, period: string | undefined): number {
  if (period === "晚上" || period === "今晚" || period === "夜里") {
    if (hour === 12) return 0;
    return hour >= 1 && hour < 12 ? hour + 12 : hour;
  }
  if (period === "下午") {
    return hour >= 1 && hour < 12 ? hour + 12 : hour;
  }
  if (period === "中午") {
    return hour >= 1 && hour < 11 ? hour + 12 : hour;
  }
  if (period === "凌晨" && hour === 12) return 0;
  if ((period === "上午" || period === "早上") && hour === 12) return 0;
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
  const match = raw.match(
    /(凌晨|早上|上午|中午|下午|晚上|今晚|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：](\d{1,2}|[零〇一二两三四五六七八九十]{1,3})|点(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})分?)?)/,
  );
  if (!match) return undefined;
  return hhmm(match[2], match[3] || match[4], match[1]);
}

export function reminderTimestamp(
  raw: string,
  explicitDate: string | undefined,
  explicitTime: string | undefined,
  clock: AssistantClock,
): string | undefined {
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
  if (!/(?:需要|必须|务必|得要|得去|一定要|别忘)/.test(raw)) return false;
  const timestamp = reminderTimestamp(raw, explicitDate, explicitTime, clock);
  if (!timestamp) return false;
  const current = new Date(`${clock.currentDate}T${clock.currentTime}:00+08:00`).getTime();
  return new Date(timestamp).getTime() > current;
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
