import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ParsedFields } from "./types.js";

// ─── 正则回退（从前端 src/app/App.tsx 移植） ──────────────────────────────────

const EXPENSE_KEYWORDS = /花了|花|消费了|消费|买了|买|付了|付|充值|转账|打车|吃饭|喝|点了/;
const MEMO_KEYWORDS = /记得|提醒|备忘|别忘了|记一下|记住|要|待办|TODO|todo/;
const TIME_RANGE = /(\d{1,2})[点:时](?:(\d{1,2})分?)?\s*[到至~～]\s*(\d{1,2})[点:时](?:(\d{1,2})分?)?/;
const AMOUNT = /([\d.]+)\s*[元块钱rmb￥]/i;

function cleanDescription(text: string): string {
  return (
    text
      .replace(/记得|提醒我|备忘录|别忘了|记一下|记住/, "")
      .replace(TIME_RANGE, "")
      .replace(AMOUNT, "")
      .replace(/花了|消费了|买了|付了/, "")
      .replace(/[，。！？\s]+$/, "")
      .replace(/^\s+/, "")
      .trim() || text
  );
}

function guessExpenseCategory(text: string): string {
  if (/餐|吃|饭|饮|喝|奶茶|咖啡|外卖/.test(text)) return "餐饮";
  if (/打车|滴滴|出租|地铁|公交|交通|油/.test(text)) return "交通";
  if (/超市|购物|买|商场|淘宝|京东/.test(text)) return "购物";
  if (/娱乐|电影|游戏|KTV/.test(text)) return "娱乐";
  if (/房租|水电|物业|话费|充值/.test(text)) return "生活";
  if (/医|药|诊|健康/.test(text)) return "健康";
  return "其他";
}

function guessActivityCategory(text: string): string {
  if (/工作|开会|会议|项目|代码|写作|汇报|接待|客户/.test(text)) return "工作";
  if (/跑步|健身|锻炼|运动|瑜伽/.test(text)) return "运动";
  if (/吃|饭|餐|喝|咖啡/.test(text)) return "饮食";
  if (/睡|休息|午休/.test(text)) return "休息";
  if (/学|读书|看书|课|学习|考/.test(text)) return "学习";
  if (/家|做饭|打扫|购物|超市/.test(text)) return "生活";
  if (/朋友|聚|出去|玩|电影|旅/.test(text)) return "社交";
  return "日常";
}

export function parseWithRegex(raw: string): ParsedFields {
  const text = raw.trim();

  if (EXPENSE_KEYWORDS.test(text)) {
    const amountMatch = text.match(AMOUNT);
    return {
      type: "expense",
      description: cleanDescription(text),
      category: guessExpenseCategory(text),
      amount: amountMatch ? parseFloat(amountMatch[1]) : undefined,
      currency: "CNY",
    };
  }

  if (MEMO_KEYWORDS.test(text)) {
    const priority = text.includes("重要") || text.includes("紧急")
      ? "high"
      : text.includes("尽快")
        ? "medium"
        : "low";
    return {
      type: "memo",
      description: cleanDescription(text),
      category: "备忘",
      priority,
    };
  }

  const rangeMatch = text.match(TIME_RANGE);
  let timeRange: { start: string; end: string } | undefined;
  if (rangeMatch) {
    const pad = (n: string | undefined) => String(parseInt(n || "0")).padStart(2, "0");
    timeRange = {
      start: `${pad(rangeMatch[1])}:${pad(rangeMatch[2])}`,
      end: `${pad(rangeMatch[3])}:${pad(rangeMatch[4])}`,
    };
  }

  return {
    type: "activity",
    description: cleanDescription(text),
    category: guessActivityCategory(text),
    timeRange,
  };
}

// ─── Claude 结构化解析 ────────────────────────────────────────────────────────

const EXPENSE_CATS = ["餐饮", "交通", "购物", "娱乐", "生活", "健康", "其他"] as const;
const ACTIVITY_CATS = ["工作", "运动", "饮食", "休息", "学习", "生活", "社交", "日常"] as const;

const EntrySchema = z.object({
  type: z.enum(["activity", "expense", "memo"]),
  description: z.string(),
  category: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const SYSTEM_PROMPT = `你是一个中文「流水账」记录助手。用户会输入一句话，你要把它解析成一条结构化记录。

判断 type：
- expense（消费）：涉及花钱、买东西、付款、充值等。抽取 amount（数字，单位元）和 currency（统一写 "CNY"）。category 从这些里选最贴切的一个：${EXPENSE_CATS.join("、")}。
- memo（备忘/提醒）：要记住、提醒、待办的事。category 固定为 "备忘"。根据语气判断 priority：含"重要/紧急"→high，含"尽快"→medium，否则 low。
- activity（活动/日志）：其它日常记录。category 从这些里选最贴切的一个：${ACTIVITY_CATS.join("、")}。如果句子里有时间段（如"9点到11点"），填 timeRange（start/end 用 "HH:MM" 24 小时制）。

description：对这件事的简洁描述（去掉"记得/提醒/花了"等口头词，去掉金额和时间表达，但保留核心内容）。
category 必须从上面对应的列表里选，不要自创新分类。只输出与该 type 相关的字段。`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // maxRetries 调高：本地代理客户端首次连接常需预热，靠重试+退避穿过冷启动。
  if (!client) client = new Anthropic({ maxRetries: 5 });
  return client;
}

export async function parseEntry(raw: string): Promise<{ fields: ParsedFields; via: "claude" | "regex" }> {
  const c = getClient();
  if (!c) return { fields: parseWithRegex(raw), via: "regex" };

  try {
    const message = await c.beta.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_format: betaZodOutputFormat(EntrySchema),
      messages: [{ role: "user", content: raw }],
    });

    if (message.stop_reason === "refusal" || !message.parsed_output) {
      return { fields: parseWithRegex(raw), via: "regex" };
    }
    return { fields: message.parsed_output as ParsedFields, via: "claude" };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`[parse] Claude API error ${err.status ?? ""}: ${err.message} — 回退到正则`);
    } else {
      console.error("[parse] 未知错误，回退到正则:", err);
    }
    return { fields: parseWithRegex(raw), via: "regex" };
  }
}
