import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { KnowledgeItem } from "./types.js";

// 知识库问答：把用户的全部知识（已解密）按问题轻量预筛后交给 Claude，综合作答并标注引用。
// 不用 embedding/向量库（个人规模足够，且避免引入第三方）。

const AnswerSchema = z.object({
  answer: z.string(),
  sourceIds: z.array(z.string()),
});

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 5 });
  return client;
}

// 中文无空格，用 2-gram 子串做粗略词重叠打分。
function bigrams(s: string): string[] {
  const t = s.replace(/\s+/g, "").toLowerCase();
  if (t.length <= 1) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

function prefilter(notes: KnowledgeItem[], query: string, limit: number): KnowledgeItem[] {
  if (notes.length <= limit) return notes;
  const q = new Set(bigrams(query));
  const scored = notes.map((n) => {
    const text = `${n.title} ${n.content}`.toLowerCase();
    let score = 0;
    for (const g of q) if (text.includes(g)) score += 1;
    return { n, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.n);
}

export interface AnswerResult {
  answer: string;
  sources: KnowledgeItem[];
}

// notes 为该用户全部知识（已解密）。返回答案与引用到的原始笔记；无 LLM 时返回 null。
export async function answerQuestion(
  notes: KnowledgeItem[],
  query: string,
): Promise<AnswerResult | null> {
  const c = getClient();
  if (!c) return null;
  if (notes.length === 0) {
    return { answer: "你的知识库里还没有内容，先对我说“记到知识库……”存一些吧。", sources: [] };
  }

  const candidates = prefilter(notes, query, 20);
  const numbered = candidates.map((item, i) => ({ idx: String(i + 1), item }));
  const docs = numbered.map(({ idx, item }) => `[${idx}] ${item.title}\n${item.content}`).join("\n\n");

  const system = `你是用户的私人知识库助手。下面是用户以前记过的一些笔记（每条前有编号）。请**只依据这些笔记**回答用户的问题：
- 用简洁、口语化的中文直接回答，必要时分点。
- 只用笔记里的信息，不要编造；若笔记里没有相关内容，就回答“知识库里没找到相关内容”，并让 sourceIds 为空。
- 在 sourceIds 里列出你实际用到的笔记编号（字符串数组，如 ["1","3"]）。`;
  const user = `笔记：\n${docs}\n\n问题：${query}`;

  const message = await c.beta.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system,
    output_format: betaZodOutputFormat(AnswerSchema),
    messages: [{ role: "user", content: user }],
  });

  const parsed = message.parsed_output as { answer?: string; sourceIds?: string[] } | null;
  if (message.stop_reason === "refusal" || !parsed?.answer) {
    return { answer: "没能回答这个问题，请换个说法再试。", sources: [] };
  }
  const sources = (parsed.sourceIds || [])
    .map((id) => numbered.find((n) => n.idx === id)?.item)
    .filter((x): x is KnowledgeItem => Boolean(x));
  return { answer: parsed.answer, sources };
}
