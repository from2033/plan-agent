import "dotenv/config";
import "./proxy.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import { requireAuth, resolveUserId } from "./auth.js";
import {
  listEntries,
  insertEntry,
  setDone,
  deleteEntry,
  getEntry,
  updateEntry,
  listKnowledge,
  insertKnowledge,
  deleteKnowledge,
} from "./db.js";
import { parseEntry } from "./parse.js";
import { correctEntry } from "./correct.js";
import { answerQuestion } from "./knowledge.js";
import { encryptionEnabled } from "./crypto-field.js";
import { generateReport, type ReportEntry, type ReportScope } from "./summary.js";
import { transcribe, nlsConfigured } from "./transcribe.js";
import { bridgeToNls } from "./asr.js";
import type { Entry } from "./types.js";

const PORT = Number(process.env.PORT) || 8787;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// 前端在哪个路径前缀下提供（与 vite base 一致）。
const BASE_PATH = process.env.BASE_PATH || "/app";

const app = express();
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()) }));
app.use(express.json());

const API = `${BASE_PATH}/api`;

// 健康检查（免鉴权）
app.get(`${API}/health`, (_req, res) => {
  res.json({ ok: true, llm: Boolean(process.env.ANTHROPIC_API_KEY), voice: nlsConfigured() });
});

// 语音转写：接收音频二进制（WAV 16k 单声道），需鉴权。
// 放在 express.json() 之外，单独用 raw 解析二进制。
app.post(
  `${API}/transcribe`,
  requireAuth,
  express.raw({ type: () => true, limit: "8mb" }),
  async (req, res) => {
    if (!nlsConfigured()) {
      res.status(503).json({ error: "语音识别未配置（缺少阿里云 NLS 凭证）" });
      return;
    }
    const audio = req.body as Buffer;
    if (!audio || !audio.length) {
      res.status(400).json({ error: "音频为空" });
      return;
    }
    try {
      const text = await transcribe(audio);
      res.json({ text });
    } catch (err) {
      console.error("[transcribe] 失败:", err);
      res.status(502).json({ error: "语音识别失败" });
    }
  },
);

// 以下 API 都需要鉴权
app.use(API, requireAuth);

// 当前登录用户（用于前端显示是谁、以及校验 token 是否有效）。
app.get(`${API}/me`, (req, res) => {
  res.json({ user: req.userId });
});

app.get(`${API}/entries`, (req, res) => {
  res.json(listEntries(req.userId!));
});

// 统一语音入口：先判意图，再分流为「记录 / 存入知识库 / 查询知识库」。
app.post(`${API}/entries`, async (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  if (!raw) {
    res.status(400).json({ error: "raw 不能为空" });
    return;
  }
  try {
    const result = await parseEntry(raw);

    // 存入知识库
    if (result.kind === "save") {
      const item = insertKnowledge(req.userId!, result.title, result.content);
      res.status(201).json({ kind: "save", item });
      return;
    }

    // 查询知识库
    if (result.kind === "ask") {
      const notes = listKnowledge(req.userId!);
      const ans = await answerQuestion(notes, result.query);
      if (!ans) {
        res.status(503).json({ kind: "ask", answer: "未配置 AI，无法查询知识库。", sources: [] });
        return;
      }
      res.json({ kind: "ask", answer: ans.answer, sources: ans.sources });
      return;
    }

    // 默认：记录入库
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    // 一句话可能拆成多条；逐条入库。timestamp 加毫秒偏移，保证拆出的顺序稳定。
    const entries: Entry[] = result.fields.map((f, i) => ({
      id: crypto.randomUUID(),
      raw,
      time,
      timestamp: new Date(now.getTime() + i).toISOString(),
      ...f,
    }));
    for (const entry of entries) insertEntry(entry, req.userId!);
    res.status(201).json({ kind: "record", entries, via: result.via });
  } catch (err) {
    console.error("[POST entries] 失败:", err);
    res.status(500).json({ error: "记录失败" });
  }
});

// 知识库：列出 / 删除
app.get(`${API}/knowledge`, (req, res) => {
  res.json(listKnowledge(req.userId!));
});

app.delete(`${API}/knowledge/:id`, (req, res) => {
  const ok = deleteKnowledge(req.params.id, req.userId!);
  if (!ok) {
    res.status(404).json({ error: "知识不存在" });
    return;
  }
  res.status(204).end();
});

// AI 报告（日报/月报）：前端把当天/当月记录传上来，Claude 生成文字点评。
// 失败或未配置 LLM 时返回 204，前端回退到本地规则文案。
app.post(`${API}/summary`, async (req, res) => {
  const scope: ReportScope = req.body?.scope === "month" ? "month" : "day";
  const dateLabel = typeof req.body?.dateLabel === "string" ? req.body.dateLabel : "";
  const entries: ReportEntry[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
  try {
    const result = await generateReport(scope, dateLabel, entries);
    if (!result) {
      res.status(204).end();
      return;
    }
    res.json({ ...result.report, via: result.via });
  } catch (err) {
    console.error("[summary] 生成失败:", err);
    res.status(502).json({ error: "报告生成失败" });
  }
});

// 语音口述修正：把一句修改要求应用到指定记录上（Claude 解析后更新）。
app.post(`${API}/entries/:id/correct`, async (req, res) => {
  const correction = typeof req.body?.correction === "string" ? req.body.correction.trim() : "";
  if (!correction) {
    res.status(400).json({ error: "correction 不能为空" });
    return;
  }
  const entry = getEntry(req.params.id, req.userId!);
  if (!entry) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  try {
    const fields = await correctEntry(entry, correction);
    if (!fields) {
      res.status(503).json({ error: "修正未生效（未配置 AI 或无法理解）" });
      return;
    }
    const updated = updateEntry(entry.id, req.userId!, fields);
    if (!updated) {
      res.status(404).json({ error: "记录不存在" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("[correct] 失败:", err);
    res.status(502).json({ error: "修正失败" });
  }
});

app.patch(`${API}/entries/:id`, (req, res) => {
  if (typeof req.body?.done !== "boolean") {
    res.status(400).json({ error: "done 必须是布尔值" });
    return;
  }
  const updated = setDone(req.params.id, req.body.done, req.userId!);
  if (!updated) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.json(updated);
});

app.delete(`${API}/entries/:id`, (req, res) => {
  const ok = deleteEntry(req.params.id, req.userId!);
  if (!ok) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.status(204).end();
});

// ─── 静态前端（构建产物 dist/），挂在 BASE_PATH 下 ─────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST
  ? path.resolve(process.env.WEB_DIST)
  : path.resolve(__dirname, "../../dist");

if (existsSync(WEB_DIST)) {
  // 仅把不带斜杠的 /app 重定向到 /app/（用 req.path 精确判断，避免 /app/ 也被匹配导致死循环）
  app.get(BASE_PATH, (req, res, next) => {
    if (req.path === BASE_PATH) return res.redirect(`${BASE_PATH}/`);
    next();
  });
  app.use(BASE_PATH, express.static(WEB_DIST));
  // SPA 回退：BASE_PATH 下的其它路径都返回 index.html
  app.get(`${BASE_PATH}/*`, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
} else {
  console.warn(`[static] 未找到前端构建目录: ${WEB_DIST}（仅提供 API）`);
}

const server = app.listen(PORT, () => {
  console.log(`后端已启动: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`前端目录: ${existsSync(WEB_DIST) ? WEB_DIST : "（未找到）"}`);
  console.log(`大模型解析: ${process.env.ANTHROPIC_API_KEY ? "已启用 (Claude)" : "未配置 (回退正则)"}`);
  if (encryptionEnabled()) {
    console.log("数据库字段加密: 已启用 (AES-256-GCM)");
  } else {
    console.warn("⚠️ 数据库字段加密: 未启用（未配置 DB_ENCRYPTION_KEY，记录将以明文存储）");
  }
});

// ─── 实时语音识别 WebSocket（流式）：${API}/asr?token=<访问令牌> ───────────────
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  let token = "";
  try {
    const u = new URL(req.url || "", "http://localhost");
    pathname = u.pathname;
    token = u.searchParams.get("token") || "";
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== `${API}/asr`) {
    socket.destroy();
    return;
  }
  if (!resolveUserId(token) || !nlsConfigured()) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    bridgeToNls(ws).catch((e) => {
      console.error("[asr] bridge 失败:", e);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });
});
