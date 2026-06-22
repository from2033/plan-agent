import "dotenv/config";
import "./proxy.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { requireAuth } from "./auth.js";
import { listEntries, insertEntry, setDone, deleteEntry } from "./db.js";
import { parseEntry } from "./parse.js";
import { transcribe, nlsConfigured } from "./transcribe.js";
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

app.get(`${API}/entries`, (_req, res) => {
  res.json(listEntries());
});

app.post(`${API}/entries`, async (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  if (!raw) {
    res.status(400).json({ error: "raw 不能为空" });
    return;
  }
  try {
    const { fields, via } = await parseEntry(raw);
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const entry: Entry = {
      id: crypto.randomUUID(),
      raw,
      time,
      timestamp: now.toISOString(),
      ...fields,
    };
    insertEntry(entry);
    res.status(201).json({ entry, via });
  } catch (err) {
    console.error("[POST entries] 失败:", err);
    res.status(500).json({ error: "记录失败" });
  }
});

app.patch(`${API}/entries/:id`, (req, res) => {
  if (typeof req.body?.done !== "boolean") {
    res.status(400).json({ error: "done 必须是布尔值" });
    return;
  }
  const updated = setDone(req.params.id, req.body.done);
  if (!updated) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.json(updated);
});

app.delete(`${API}/entries/:id`, (req, res) => {
  const ok = deleteEntry(req.params.id);
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

app.listen(PORT, () => {
  console.log(`后端已启动: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`前端目录: ${existsSync(WEB_DIST) ? WEB_DIST : "（未找到）"}`);
  console.log(`大模型解析: ${process.env.ANTHROPIC_API_KEY ? "已启用 (Claude)" : "未配置 (回退正则)"}`);
});
