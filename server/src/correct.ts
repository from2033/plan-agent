import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Entry, ParsedFields } from "./types.js";

// 语音口述修正：把用户的一句修改要求应用到一条已有记录上，输出修改后的字段。
// 用 Claude 结构化输出；没配 LLM 或失败时返回 null（上层报错给前端）。

const EXPENSE_CATS = ["餐饮", "交通", "购物", "娱乐", "生活", "健康", "其他"];
const ACTIVITY_CATS = ["工作", "运动", "饮食", "休息", "学习", "生活", "社交", "日常"];

const EntrySchema = z.object({
  type: z.enum(["activity", "expense", "memo", "wish"]),
  description: z.string(),
  category: z.string(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  timeRange: z.object({ start: z.string(), end: z.string() }).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 5 });
  return client;
}

function buildSystemPrompt(nowStr: string): string {
  return `你是「流水账」记录的修正助手。用户会给你一条**已有记录**和一句**口头修改要求**，请把修改应用上去，输出修改后的**完整记录字段**。

当前时间：${nowStr}（用来理解"下午3点""明天"等口语/相对时间）。

规则：
- 只改用户要求改的部分，其余字段保持原样。
- 字段含义：type（activity 行程 / expense 账单 / memo 备忘 / wish 心愿）、description（简洁描述）、category、amount（金额，单位元）、currency（统一 "CNY"）、timeRange{start,end}（"HH:MM" 24 小时制）、priority（low/medium/high，仅 memo）。
- category 必须从对应 type 的合法列表里选：expense=${EXPENSE_CATS.join("、")}；activity=${ACTIVITY_CATS.join("、")}；memo 固定 "备忘"；wish 固定 "心愿"。
- 用户要求设置/修改时间但原记录没有 timeRange 时，**新增 timeRange**；说"取消时间/去掉时间"则不要输出 timeRange。
- 如果修改改变了记录性质（例如"这其实是一笔花费""把它变成备忘"），相应改 type，并补齐/去掉该 type 对应的字段（如改成 expense 要给 amount/分类）。
- 只输出与最终 type 相关的字段，不要无关字段。`;
}

export async function correctEntry(
  entry: Entry,
  correction: string,
): Promise<ParsedFields | null> {
  const c = getClient();
  if (!c) return null;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${wd}`;

  const current = {
    type: entry.type,
    description: entry.description,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    timeRange: entry.timeRange,
    priority: entry.priority,
  };

  const userContent = `已有记录：\n${JSON.stringify(current, null, 2)}\n\n修改要求：${correction}`;

  const message = await c.beta.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: buildSystemPrompt(nowStr),
    output_format: betaZodOutputFormat(EntrySchema),
    messages: [{ role: "user", content: userContent }],
  });

  const parsed = message.parsed_output as ParsedFields | null;
  if (message.stop_reason === "refusal" || !parsed) return null;
  return parsed;
}
