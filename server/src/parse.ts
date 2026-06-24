import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ParsedFields } from "./types.js";

// ─── 正则回退（从前端 src/app/App.tsx 移植） ──────────────────────────────────

const EXPENSE_KEYWORDS = /花了|花|消费了|消费|买了|买|付了|付|充值|转账|打车|吃饭|喝|点了/;
const MEMO_KEYWORDS = /记得|提醒|备忘|别忘了|记一下|记住|要|待办|TODO|todo/;
const WISH_KEYWORDS = /找个时间|找时间|有空|抽空|以后想|将来想|总有一天|哪天|有机会|梦想|心愿/;
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

export function parseWithRegex(raw: string): ParsedFields[] {
  const text = raw.trim();

  const rangeMatch = text.match(TIME_RANGE);
  let timeRange: { start: string; end: string } | undefined;
  if (rangeMatch) {
    const pad = (n: string | undefined) => String(parseInt(n || "0")).padStart(2, "0");
    timeRange = {
      start: `${pad(rangeMatch[1])}:${pad(rangeMatch[2])}`,
      end: `${pad(rangeMatch[3])}:${pad(rangeMatch[4])}`,
    };
  }

  const amountMatch = text.match(AMOUNT);
  const hasExpense = EXPENSE_KEYWORDS.test(text);
  const out: ParsedFields[] = [];

  // 既有时间段又有花费时，正则也拆成「行程 + 账单」两条。
  if (timeRange) {
    out.push({
      type: "activity",
      description: cleanDescription(text),
      category: guessActivityCategory(text),
      timeRange,
    });
  }

  if (hasExpense) {
    out.push({
      type: "expense",
      description: cleanDescription(text),
      category: guessExpenseCategory(text),
      amount: amountMatch ? parseFloat(amountMatch[1]) : undefined,
      currency: "CNY",
    });
  }

  if (out.length) return out;

  if (WISH_KEYWORDS.test(text)) {
    return [{ type: "wish", description: cleanDescription(text), category: "心愿" }];
  }

  if (MEMO_KEYWORDS.test(text)) {
    const priority = text.includes("重要") || text.includes("紧急")
      ? "high"
      : text.includes("尽快")
        ? "medium"
        : "low";
    return [{
      type: "memo",
      description: cleanDescription(text),
      category: "备忘",
      priority,
    }];
  }

  return [{
    type: "activity",
    description: cleanDescription(text),
    category: guessActivityCategory(text),
  }];
}

// ─── Claude 结构化解析 ────────────────────────────────────────────────────────

const EXPENSE_CATS = ["餐饮", "交通", "购物", "娱乐", "生活", "健康", "其他"] as const;
const ACTIVITY_CATS = ["工作", "运动", "饮食", "休息", "学习", "生活", "社交", "日常"] as const;

const EntrySchema = z.object({
  type: z.enum(["activity", "expense", "memo", "wish"]),
  description: z.string(),
  category: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

// 一次调用同时完成「意图判定」与（record/save 的）解析。
const IngestSchema = z.object({
  intent: z.enum(["record", "save", "ask"]),
  entries: z.array(EntrySchema).optional(), // intent=record
  title: z.string().optional(), // intent=save：提炼的简短标题
  content: z.string().optional(), // intent=save：清理后的知识正文
  query: z.string().optional(), // intent=ask：要查询的问题
});

// 统一入口的判别式结果。
export type IngestResult =
  | { kind: "record"; fields: ParsedFields[]; via: "claude" | "regex" }
  | { kind: "save"; title: string; content: string }
  | { kind: "ask"; query: string };

function buildSystemPrompt(nowStr: string): string {
  return `你是一个中文助手，先判断用户这句话的**意图**（intent），再据此输出：

- intent="save"（存入知识库）：用户想**记下一条长期参考型知识**以便日后查阅，通常是经验/技巧/做法/路线/总结，或明确说"记到知识库/存一下这个知识/记住这个方法"等。
  → 输出 title（一个简短标题，便于以后检索）和 content（把口语整理清楚、去掉"记一下/记到知识库"这类口头词的正文）。不要输出 entries。
- intent="ask"（查询知识库）：用户在**提问、想回忆/查找**之前记过的东西（如"……怎么做来着""……的路线是什么""我之前记的……"）。
  → 输出 query（要查询的问题，通常等于用户原话）。不要输出 entries。
- intent="record"（默认）：其余日常流水（已发生或要做的事、花费、提醒、心愿等）。
  → 按下面规则把它拆成一条或多条结构化记录放进 entries 数组。

判断要点：知识(save)是"沉淀下来供以后看的方法/资料"；备忘(memo,属于 record)是"近期要做的待办"；提问(ask)是疑问句/检索意图。拿不准时优先按 record 处理。

以下是 intent=record 时的拆分规则：

用户会说一句或几句话，里面可能包含**多件事**，你要把它们拆成**一条或多条**结构化记录，放进 entries 数组。

当前时间：${nowStr}。请据此判断每件事是否「已经发生」——综合时态（"了/过/在"=已发生或进行中；"待会/等下/下午/晚上/明天/准备/要去"=将来）和提到的时间点与当前时间的先后。

拆分原则：
- 一句话里若包含多件事（比如先吃饭、之后去唱歌），每件事各出一条。
- 同一件事若**既有时间段、又有花费**，拆成两条：一条 activity（带 timeRange，记行程/时长）+ 一条 expense（带 amount，记账）。例如"12点到13点吃饭花了30"→ 一条 activity(饮食, 12:00–13:00) + 一条 expense(餐饮, 30)。
- **还没发生**的带时间安排（提到的时间晚于当前时间，或用"下午/晚上/明天/待会"等指将来且尚未到）：**必须输出 2 条，缺一不可** —— 一条 type=activity（行程，带 timeRange）＋ 一条 type=memo（备忘提醒，description 带上时间）。绝不能只出其中一条。
  例：现在是早上 06:55，用户说"下午2点到3点开会"，必须输出这两条：
  {"type":"activity","category":"工作","description":"开会","timeRange":{"start":"14:00","end":"15:00"}} 和 {"type":"memo","category":"备忘","description":"下午2点到3点开会","priority":"low"}
- **已经发生**的活动（时间早于当前、或用过去时"了/过"）只出 activity，不要 memo。
- 只有花费没有时间 → 只出 expense。

每条记录判断 type：
- expense（消费）：涉及花钱、买东西、付款、充值。抽取 amount（数字，单位元）和 currency（统一写 "CNY"）。category 从这些里选最贴切的一个：${EXPENSE_CATS.join("、")}。
- memo（备忘/提醒）：明确的待办/提醒事项（含"记得/提醒/别忘了/待办"等），或上面规则里"还没发生的带时间安排"的提醒副本。category 固定为 "备忘"。根据语气判断 priority：含"重要/紧急"→high，含"尽快"→medium，否则 low。
- wish（心愿/期待）：**没有具体时间**的将来愿望、打算、想做的事（如"找个时间去丽江旅游"、"有空想学钢琴"、"以后想买房"、"总有一天去看极光"）。和 memo 的区别：memo 是近期要落实的待办，wish 是没排期的长期心愿。category 固定为 "心愿"。
- activity（活动/行程）：日常记录，既包括**已经做过的事**，也包括**有明确时间安排的计划**（如"15:00-16:00去唱歌"）。category 从这些里选最贴切的一个：${ACTIVITY_CATS.join("、")}。有时间段就填 timeRange（start/end 用 "HH:MM" 24 小时制）。

description：简洁描述（去掉"记得/提醒/花了/在"等口头词、去掉金额）。activity 和 expense 的 description 去掉时间表达；memo 的 description 可保留时间，方便提醒。
category 必须从上面对应的列表里选，不要自创新分类。每条只输出与该 type 相关的字段。`;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // maxRetries 调高：本地代理客户端首次连接常需预热，靠重试+退避穿过冷启动。
  if (!client) client = new Anthropic({ maxRetries: 5 });
  return client;
}

export async function parseEntry(raw: string): Promise<IngestResult> {
  const c = getClient();
  // 无 LLM：只能按记录处理（正则），不支持存知识/查询。
  if (!c) return { kind: "record", fields: parseWithRegex(raw), via: "regex" };

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${wd}`;

  try {
    const message = await c.beta.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: buildSystemPrompt(nowStr),
      output_format: betaZodOutputFormat(IngestSchema),
      messages: [{ role: "user", content: raw }],
    });

    const parsed = message.parsed_output as {
      intent?: string;
      entries?: ParsedFields[];
      title?: string;
      content?: string;
      query?: string;
    } | null;

    if (message.stop_reason === "refusal" || !parsed) {
      return { kind: "record", fields: parseWithRegex(raw), via: "regex" };
    }
    if (parsed.intent === "save" && (parsed.content || parsed.title)) {
      const content = (parsed.content || raw).trim();
      const title = (parsed.title || content.slice(0, 16)).trim();
      return { kind: "save", title, content };
    }
    if (parsed.intent === "ask") {
      return { kind: "ask", query: (parsed.query || raw).trim() };
    }
    if (parsed.entries?.length) {
      return { kind: "record", fields: parsed.entries, via: "claude" };
    }
    return { kind: "record", fields: parseWithRegex(raw), via: "regex" };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`[parse] Claude API error ${err.status ?? ""}: ${err.message} — 回退到正则`);
    } else {
      console.error("[parse] 未知错误，回退到正则:", err);
    }
    return { kind: "record", fields: parseWithRegex(raw), via: "regex" };
  }
}
