import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { KnowledgeItem } from "./types.js";

// 统一证据问答：输入已完成权限过滤的知识、记录、QQ 原文和聊天记录，
// 使用关键词 + Ollama embedding 混合排序后交给模型。

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

async function prefilter(notes: KnowledgeItem[], query: string, limit: number): Promise<KnowledgeItem[]> {
  const q = new Set(bigrams(query));
  const scored = notes.map((n, index) => {
    const text = `${n.title} ${n.content}`.toLowerCase();
    let score = 0;
    for (const g of q) if (text.includes(g)) score += 1;
    if (text.includes(query.toLowerCase())) score += 10;
    return { n, score, index, vector: 0 };
  });
  const enabled = process.env.ASSISTANT_VECTOR_SEARCH !== "false";
  const url = (process.env.ASSISTANT_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = process.env.ASSISTANT_EMBEDDING_MODEL || "qwen3-embedding:0.6b";
  if (enabled && notes.length) {
    try {
      const response = await fetch(`${url}/api/embed`, { method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: [query, ...notes.map(n => `${n.title}\n${n.content}`)], truncate: true }) });
      const payload = await response.json() as { embeddings?: number[][] };
      const vectors = payload.embeddings;
      if (response.ok && Array.isArray(vectors) && vectors.length === notes.length + 1) {
        const qv = vectors[0]; const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        const qn = norm(qv);
        vectors.slice(1).forEach((v, i) => { scored[i].vector = v.reduce((s, x, d) => s + x * (qv[d] || 0), 0) / (qn * norm(v)); });
      }
    } catch { /* graceful lexical fallback */ }
  }
  scored.sort((a, b) => (b.score * 0.35 + b.vector * 100 * 0.65) - (a.score * 0.35 + a.vector * 100 * 0.65) || a.index - b.index);
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

  const candidates = await prefilter(notes, query, 20);
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
