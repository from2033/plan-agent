import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

// AI 报告：根据用户某一天/某一个月的流水账记录，生成口语化的亮点 / 待改进 / 建议。
// 只产出文字点评；具体数字（花费、条数等）由前端本地即时算，无需 AI。

export type ReportScope = "day" | "week" | "month";

export interface ReportEntry {
  type: string;
  category: string;
  description: string;
  amount?: number;
  timeRange?: { start: string; end: string };
  done?: boolean;
}

const ReportSchema = z.object({
  highlights: z.array(z.string()),
  improvements: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export type Report = z.infer<typeof ReportSchema>;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 5 });
  return client;
}

function serialize(entries: ReportEntry[]): string {
  return entries
    .map((e) => {
      const bits = [e.type, e.category, e.description];
      if (e.amount != null) bits.push(`¥${e.amount}`);
      if (e.timeRange) bits.push(`${e.timeRange.start}-${e.timeRange.end}`);
      if (e.type === "memo") bits.push(e.done ? "已完成" : "未完成");
      return `- ${bits.join(" | ")}`;
    })
    .join("\n");
}

function buildSystemPrompt(scope: ReportScope, dateLabel: string): string {
  const span = scope === "day"
    ? `这一天（${dateLabel}）`
    : scope === "week"
      ? `这一周（${dateLabel}）`
      : `这个月（${dateLabel}）`;
  const next = scope === "day" ? "明天" : scope === "week" ? "下周" : "下个月";
  return `你是一个贴心的中文生活记录助手。下面是用户${span}的流水账记录（每行一条：类型 | 分类 | 描述，可能带金额、时间段、完成状态）。

请据此写一份简短、口语化、带点鼓励的小结，分三部分，各 2~4 条，每条一句话：
- highlights：${span}做得好的、值得肯定的亮点（具体引用记录里的事，别空泛）。
- improvements：可以改进或需要注意的地方（比如花费偏高、待办没完成、缺少运动等）。
- suggestions：给${next}的具体小建议。

要求：
- 只依据给出的记录，不要编造没有的数据或事项。
- 语气自然、像朋友聊天，不要客套套话，不要 emoji。
- 如果某部分实在没什么可写，宁可少写一两条，也不要硬凑。`;
}

// 生成报告。无 API key 或调用失败时抛错/返回 null，由上层回退到前端本地规则文案。
export async function generateReport(
  scope: ReportScope,
  dateLabel: string,
  entries: ReportEntry[],
): Promise<{ report: Report; via: "claude" } | null> {
  if (!entries.length) return null;
  const c = getClient();
  if (!c) return null;

  const message = await c.beta.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: buildSystemPrompt(scope, dateLabel),
    output_format: betaZodOutputFormat(ReportSchema),
    messages: [{ role: "user", content: serialize(entries) }],
  });

  const parsed = message.parsed_output as Report | null;
  if (message.stop_reason === "refusal" || !parsed) return null;
  return { report: parsed, via: "claude" };
}
