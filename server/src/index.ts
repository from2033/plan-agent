import "dotenv/config";
import "./proxy.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { requireAuth, resolveUserId } from "./auth.js";
import {
  listEntries,
  insertEntry,
  setDone,
  deleteEntry,
  getEntry,
  updateEntry,
  repairEntryReminder,
  listKnowledge,
  insertKnowledge,
  deleteKnowledge,
  importClientData,
  deleteAccountData,
} from "./db.js";
import { parseEntry } from "./parse.js";
import { correctEntry } from "./correct.js";
import { answerQuestion } from "./knowledge.js";
import { encryptionEnabled } from "./crypto-field.js";
import { generateReport, type Report, type ReportEntry, type ReportScope } from "./summary.js";
import { getCachedReport, reportFingerprint, saveCachedReport } from "./report-cache.js";
import { transcribe, nlsConfigured } from "./transcribe.js";
import { bridgeToNls } from "./asr.js";
import {
  assistantClock,
  entryTiming,
  inferReminderTimeFromText,
  inferTimeRangeFromText,
  isFutureObligation,
  reminderTimestamp,
  type AssistantClock,
} from "./entry-date.js";
import type { Entry } from "./types.js";
import { knowledgeIntentHint, type IntentHint } from "./intent.js";
import { requestEmailCode, verifyEmailCode } from "./email-auth.js";
import { createGuestSession, isGuestUser } from "./guest-auth.js";
import { privacyPageHtml } from "./privacy-page.js";
import {
  CODEX_QUEUE_POLICY_VERSION,
  CODEX_QUEUE_PROTOCOL_VERSION,
  claimAiJob,
  codexQueueEnabled,
  codexWorkerOnline,
  completeAiJob,
  enqueueAiJob,
  failAiJob,
  findActiveSummaryJob,
  getAiJob,
  heartbeatAiJob,
  validWorkerToken,
  type AiJob,
} from "./ai-queue.js";

const PORT = Number(process.env.PORT) || 8787;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// 前端在哪个路径前缀下提供（与 vite base 一致）。
const BASE_PATH = process.env.BASE_PATH ?? "";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()) }));
app.use(express.json());

const API = `${BASE_PATH}/api`;

app.get(`${BASE_PATH}/privacy`, (_req, res) => {
  res.type("html").send(privacyPageHtml);
});

// 健康检查（免鉴权）
app.get(`${API}/health`, (_req, res) => {
  res.json({
    ok: true,
    llm: codexQueueEnabled()
      ? codexWorkerOnline()
        ? "codex-desktop"
        : "codex-offline"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : false,
    voice: nlsConfigured(),
  });
});

app.post(`${API}/auth/email/code`, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "请输入有效的邮箱地址" });
    return;
  }
  try {
    const status = await requestEmailCode(email);
    if (status === "unavailable") {
      res.status(503).json({ error: "邮箱登录尚未配置" });
      return;
    }
    res.status(202).json({ ok: true });
  } catch (error) {
    console.error("[email auth] 验证码发送失败:", error);
    res.status(502).json({ error: "验证码发送失败，请稍后重试" });
  }
});

app.post(`${API}/auth/email/verify`, (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "请输入 6 位验证码" });
    return;
  }
  try {
    const session = verifyEmailCode(email, code);
    if (!session) {
      res.status(401).json({ error: "验证码无效或已过期" });
      return;
    }
    res.json(session);
  } catch (error) {
    console.error("[email auth] 验证失败:", error);
    res.status(500).json({ error: "登录失败，请稍后重试" });
  }
});

const guestIssueLimits = new Map<string, { count: number; resetAt: number }>();
app.post(`${API}/auth/guest`, (req, res) => {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = guestIssueLimits.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + 60 * 60_000 }
    : current;
  bucket.count += 1;
  guestIssueLimits.set(key, bucket);
  if (bucket.count > 20) {
    res.status(429).json({ error: "访客会话创建过于频繁，请稍后再试" });
    return;
  }
  res.status(201).json(createGuestSession());
});

// Codex 桌面 worker：与用户会话完全分离，只接受服务器配置的哈希令牌。
function requireWorker(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!validWorkerToken(token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const WORKER_API = `${API}/internal/codex-worker`;
app.post(`${WORKER_API}/claim`, requireWorker, (req, res) => {
  const workerId = String(req.body?.workerId || "desktop-codex")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 80) || "desktop-codex";
  const claimed = claimAiJob(workerId);
  if (!claimed) {
    res.status(204).end();
    return;
  }
  res.json({
    protocolVersion: CODEX_QUEUE_PROTOCOL_VERSION,
    policyVersion: CODEX_QUEUE_POLICY_VERSION,
    leaseToken: claimed.leaseToken,
    leaseSeconds: claimed.leaseSeconds,
    job: {
      id: claimed.job.id,
      kind: claimed.job.kind,
      input: claimed.job.input,
      createdAt: claimed.job.createdAt,
    },
  });
});

app.post(`${WORKER_API}/jobs/:id/heartbeat`, requireWorker, (req, res) => {
  const leaseSeconds = heartbeatAiJob(req.params.id, req.header("x-job-lease") || "");
  if (!leaseSeconds) {
    res.status(409).json({ error: "invalid_or_expired_lease" });
    return;
  }
  res.json({ ok: true, leaseSeconds });
});

interface WorkerIngestResult {
  kind: "record" | "save" | "ask";
  fields?: Array<Omit<Entry, "id" | "raw" | "time" | "timestamp" | "reminderAt"> & {
    date?: string;
    reminderTime?: string;
  }>;
  title?: string;
  content?: string;
  answer?: string;
  sourceIds?: string[];
}

function fallbackKnowledge(raw: string): { title: string; content: string } {
  const content = raw
    .replace(/^(?:请)?(?:帮我)?(?:记|存|保存)(?:到|进|入)(?:我的)?(?:个人)?知识库[：:\s]*/u, "")
    .trim() || raw.trim();
  const title = (content.split(/[，。；;：:\n]/u)[0] || content).slice(0, 24);
  return { title, content };
}

function knowledgeFromRequest(req: express.Request): Array<{
  id: string;
  title: string;
  content: string;
  timestamp: string;
}> {
  if (!isGuestUser(req.userId) || !Array.isArray(req.body?.knowledge)) {
    return listKnowledge(req.userId!);
  }
  return req.body.knowledge.slice(0, 100).flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.slice(0, 100) : "";
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 100) : "";
    const content = typeof item.content === "string" ? item.content.trim().slice(0, 10_000) : "";
    if (!id || !title || !content) return [];
    return [{ id, title, content, timestamp: new Date().toISOString() }];
  });
}

function ensureSummaryJob(
  userId: string,
  scope: ReportScope,
  periodKey: string,
  dateLabel: string,
  entries: ReportEntry[],
): { id: string; inputHash: string } {
  const inputHash = reportFingerprint(entries);
  const active = findActiveSummaryJob(userId, scope, periodKey, inputHash);
  if (active) return { id: active.id, inputHash };
  const job = enqueueAiJob(userId, "summary", {
    scope,
    dateLabel,
    entries,
    reportCache: { scope, periodKey, inputHash },
  });
  return { id: job.id, inputHash };
}

function shanghaiDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function reportEntry(entry: Entry): ReportEntry {
  return {
    type: entry.type,
    category: entry.category,
    description: entry.description,
    amount: entry.amount,
    timeRange: entry.timeRange,
    done: entry.done,
  };
}

const reportRefreshTimers = new Map<string, NodeJS.Timeout>();
function scheduleReportRefresh(userId: string): void {
  const existing = reportRefreshTimers.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    reportRefreshTimers.delete(userId);
    if (!codexWorkerOnline()) return;
    const today = assistantClock().currentDate;
    const monday = weekStart(today);
    const all = listEntries(userId);
    const dayEntries = all.filter((entry) => shanghaiDate(entry.timestamp) === today).map(reportEntry);
    const weekEntries = all.filter((entry) => {
      const date = shanghaiDate(entry.timestamp);
      return date >= monday && date <= today;
    }).map(reportEntry);
    if (dayEntries.length) ensureSummaryJob(userId, "day", today, today, dayEntries);
    if (weekEntries.length) ensureSummaryJob(userId, "week", monday, `${monday} 至 ${today}`, weekEntries);
  }, 3 * 60 * 1000);
  timer.unref();
  reportRefreshTimers.set(userId, timer);
}

function finalizeWorkerResult(job: AiJob, value: unknown): unknown {
  if (job.kind === "summary") {
    const input = job.input as {
      reportCache?: { scope: ReportScope; periodKey: string; inputHash: string };
    };
    if (input.reportCache && !isGuestUser(job.userId)) {
      saveCachedReport(
        job.userId,
        input.reportCache.scope,
        input.reportCache.periodKey,
        input.reportCache.inputHash,
        value as Report,
      );
    }
    return value;
  }
  if (job.kind !== "ingest") return value;
  const result = value as WorkerIngestResult;
  const input = job.input as {
    raw: string;
    intentHint?: IntentHint;
    context?: AssistantClock;
    knowledge?: Array<{ id: string; title: string; content: string; timestamp: string }>;
  };
  if (input.intentHint === "save") {
    const fallback = fallbackKnowledge(input.raw);
    const title = result.kind === "save" && result.title ? result.title : fallback.title;
    const content = result.kind === "save" && result.content ? result.content : fallback.content;
    const item = isGuestUser(job.userId)
      ? { id: `ai-${job.id}`, title, content, timestamp: new Date().toISOString() }
      : insertKnowledge(job.userId, title, content, `ai-${job.id}`);
    return { kind: "save", item };
  }
  if (result.kind === "save") {
    const item = isGuestUser(job.userId)
      ? {
          id: `ai-${job.id}`,
          title: result.title!,
          content: result.content!,
          timestamp: new Date().toISOString(),
        }
      : insertKnowledge(job.userId, result.title!, result.content!, `ai-${job.id}`);
    return { kind: "save", item };
  }
  if (result.kind === "ask") {
    const wanted = new Set(result.sourceIds || []);
    const sources = (input.knowledge || []).filter((item) => wanted.has(item.id));
    return { kind: "ask", answer: result.answer, sources };
  }

  const now = new Date();
  const clock = input.context || assistantClock(now);
  const entries = (result.fields || []).map((fields, i): Entry => {
    const { date, reminderTime, ...entryFields } = fields;
    const forceMemo = isFutureObligation(input.raw, date, reminderTime, clock);
    if (forceMemo) {
      entryFields.type = "memo";
      entryFields.category = "备忘";
      entryFields.priority ??= "medium";
    }
    const inferredRange =
      fields.type === "activity" || fields.type === "memo"
        ? inferTimeRangeFromText(input.raw)
        : undefined;
    const timeRange = inferredRange || fields.timeRange;
    if (timeRange) entryFields.timeRange = timeRange;
    const reminderAt = entryFields.type === "memo"
      ? reminderTimestamp(input.raw, date, reminderTime, clock)
      : undefined;
    const reminderClock = reminderAt ? reminderTime || inferReminderTimeFromText(input.raw) : undefined;
    const timing = reminderAt
      ? { time: reminderClock || "", timestamp: reminderAt }
      : entryTiming(input.raw, date, timeRange, clock, i, now);
    return {
      id: `ai-${job.id}-${i}`,
      raw: input.raw,
      ...timing,
      ...entryFields,
      ...(reminderAt ? { reminderAt } : {}),
    };
  });
  if (!isGuestUser(job.userId)) {
    for (const entry of entries) {
      try {
        insertEntry(entry, job.userId);
      } catch (error) {
        // 回传超时后 worker 可能重试；确定性 ID 让落库保持幂等。
        if (!getEntry(entry.id, job.userId)) throw error;
      }
    }
    scheduleReportRefresh(job.userId);
  }
  return { kind: "record", entries, via: "codex-desktop" };
}

app.post(`${WORKER_API}/jobs/:id/result`, requireWorker, (req, res) => {
  try {
    const job = completeAiJob(
      req.params.id,
      req.header("x-job-lease") || "",
      req.body?.result,
      finalizeWorkerResult,
    );
    if (!job) {
      res.status(409).json({ error: "invalid_or_expired_lease" });
      return;
    }
    res.json({ ok: true, jobId: job.id });
  } catch (error) {
    console.error("[codex-worker result] 校验失败:", error);
    res.status(422).json({ error: "invalid_result" });
  }
});

app.post(`${WORKER_API}/jobs/:id/fail`, requireWorker, (req, res) => {
  const ok = failAiJob(
    req.params.id,
    req.header("x-job-lease") || "",
    String(req.body?.reason || "worker_failed"),
    req.body?.retryable !== false,
  );
  if (!ok) {
    res.status(409).json({ error: "invalid_or_expired_lease" });
    return;
  }
  res.json({ ok: true });
});

const guestUsageLimits = new Map<string, { count: number; resetAt: number }>();
function requireGuestQuota(action: string, hourlyLimit: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!isGuestUser(req.userId)) {
      next();
      return;
    }
    const key = `${req.userId}:${action}`;
    const now = Date.now();
    const current = guestUsageLimits.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 60 * 60_000 }
      : current;
    bucket.count += 1;
    guestUsageLimits.set(key, bucket);
    if (bucket.count > hourlyLimit) {
      res.status(429).json({ error: "访客体验次数已达上限，请稍后再试或登录使用" });
      return;
    }
    next();
  };
}

// 语音转写：接收音频二进制（WAV 16k 单声道），需鉴权。
// 放在 express.json() 之外，单独用 raw 解析二进制。
app.post(
  `${API}/transcribe`,
  requireAuth,
  requireGuestQuota("transcribe", 60),
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
  res.json({
    user: isGuestUser(req.userId) ? "访客" : req.userId,
    guest: isGuestUser(req.userId),
  });
});

// App Store account-deletion requirement: deletion is initiated in-app and is
// effective immediately. The same email may create a new, empty account later.
app.delete(`${API}/account`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "访客模式没有云端账户" });
    return;
  }
  const userId = req.userId!;
  const refreshTimer = reportRefreshTimers.get(userId);
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    reportRefreshTimers.delete(userId);
  }
  try {
    deleteAccountData(userId);
    res.status(204).end();
  } catch (error) {
    console.error("[account deletion] 删除失败:", error);
    res.status(500).json({ error: "账户删除失败，请稍后重试" });
  }
});

const ClientImportSchema = z.object({
  migrationId: z.string().min(1).max(100),
  entries: z.array(z.object({
    id: z.string().min(1).max(100),
    type: z.enum(["activity", "expense", "memo", "wish"]),
    description: z.string().min(1).max(500),
    category: z.string().min(1).max(40),
    timestamp: z.iso.datetime(),
    time: z.string().max(20).default(""),
    amount: z.number().finite().nonnegative().optional(),
    done: z.boolean().default(false),
    priority: z.enum(["low", "medium", "high"]).optional(),
    timeRange: z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    }).optional(),
    reminderAt: z.iso.datetime().optional(),
  })).max(5_000).default([]),
  knowledge: z.array(z.object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(100),
    content: z.string().min(1).max(10_000),
  })).max(1_000).default([]),
});

app.post(`${API}/import`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再迁移访客数据" });
    return;
  }
  const parsed = ClientImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "访客数据格式无效" });
    return;
  }
  const entries: Entry[] = parsed.data.entries.map((item) => ({
    id: item.id,
    type: item.type,
    raw: item.description,
    time: item.time,
    description: item.description,
    category: item.category,
    timestamp: item.timestamp,
    ...(item.amount == null ? {} : { amount: item.amount, currency: "CNY" }),
    ...(item.done ? { done: true } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.timeRange ? { timeRange: item.timeRange } : {}),
    ...(item.reminderAt ? { reminderAt: item.reminderAt } : {}),
  }));
  try {
    const result = importClientData(
      req.userId!,
      parsed.data.migrationId,
      entries,
      parsed.data.knowledge,
    );
    res.status(result.alreadyImported ? 200 : 201).json(result);
  } catch (error) {
    console.error("[client import] 失败:", error);
    res.status(500).json({ error: "访客数据迁移失败" });
  }
});

app.get(`${API}/ai-jobs/:id`, (req, res) => {
  const job = getAiJob(req.params.id, req.userId!);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ status: job.status, result: job.result, error: job.error });
});

app.get(`${API}/entries`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  const clock = assistantClock();
  const now = new Date(`${clock.currentDate}T${clock.currentTime}:00+08:00`).getTime();
  const entries = listEntries(req.userId!).map((entry) => {
    if (entry.reminderAt || entry.done) return entry;
    const reminderTime = /^\d{2}:\d{2}$/.test(entry.time)
      ? entry.time
      : inferReminderTimeFromText(entry.raw);
    if (!reminderTime) return entry;
    let reminderAt: string | undefined;
    if (entry.type === "memo") {
      reminderAt = reminderTimestamp(entry.raw, shanghaiDate(entry.timestamp), reminderTime, clock);
    } else if (isFutureObligation(entry.raw, undefined, reminderTime, clock)) {
      reminderAt = reminderTimestamp(entry.raw, undefined, reminderTime, clock);
    }
    if (!reminderAt || new Date(reminderAt).getTime() <= now) return entry;
    return repairEntryReminder(entry.id, req.userId!, reminderTime, reminderAt) || entry;
  });
  res.json(entries);
});

// 统一语音入口：先判意图，再分流为「记录 / 存入知识库 / 查询知识库」。
app.post(`${API}/entries`, requireGuestQuota("ingest", 120), async (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  if (!raw) {
    res.status(400).json({ error: "raw 不能为空" });
    return;
  }
  try {
    const intentHint = knowledgeIntentHint(raw);
    if (codexWorkerOnline()) {
      const knowledge = knowledgeFromRequest(req);
      const job = enqueueAiJob(req.userId!, "ingest", {
        raw,
        intentHint,
        context: assistantClock(),
        knowledge,
      });
      res.status(202).json({ kind: "pending", jobId: job.id });
      return;
    }
    if (intentHint === "save") {
      const knowledge = fallbackKnowledge(raw);
      const item = isGuestUser(req.userId)
        ? {
            id: crypto.randomUUID(),
            ...knowledge,
            timestamp: new Date().toISOString(),
          }
        : insertKnowledge(req.userId!, knowledge.title, knowledge.content);
      res.status(201).json({ kind: "save", item });
      return;
    }
    const result = await parseEntry(raw);

    // 存入知识库
    if (result.kind === "save") {
      const item = isGuestUser(req.userId)
        ? {
            id: crypto.randomUUID(),
            title: result.title,
            content: result.content,
            timestamp: new Date().toISOString(),
          }
        : insertKnowledge(req.userId!, result.title, result.content);
      res.status(201).json({ kind: "save", item });
      return;
    }

    // 查询知识库
    if (result.kind === "ask") {
      const notes = knowledgeFromRequest(req);
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
    const clock = assistantClock(now);
    // 一句话可能拆成多条；逐条入库。timestamp 加毫秒偏移，保证拆出的顺序稳定。
    const entries: Entry[] = result.fields.map((f, i) => {
      const { date, reminderTime, ...entryFields } = f;
      const forceMemo = isFutureObligation(raw, date, reminderTime, clock);
      if (forceMemo) {
        entryFields.type = "memo";
        entryFields.category = "备忘";
        entryFields.priority ??= "medium";
      }
      const inferredRange =
        f.type === "activity" || f.type === "memo" ? inferTimeRangeFromText(raw) : undefined;
      const timeRange = inferredRange || f.timeRange;
      if (timeRange) entryFields.timeRange = timeRange;
      const reminderAt = entryFields.type === "memo"
        ? reminderTimestamp(raw, date, reminderTime, clock)
        : undefined;
      const reminderClock = reminderAt ? reminderTime || inferReminderTimeFromText(raw) : undefined;
      return {
        id: crypto.randomUUID(),
        raw,
        ...(reminderAt
          ? { time: reminderClock || "", timestamp: reminderAt }
          : entryTiming(raw, date, timeRange, clock, i, now)),
        ...entryFields,
        ...(reminderAt ? { reminderAt } : {}),
      };
    });
    if (!isGuestUser(req.userId)) {
      for (const entry of entries) insertEntry(entry, req.userId!);
      scheduleReportRefresh(req.userId!);
    }
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

// AI 报告（日报/周报/月报）：内容未变化直接命中缓存；变化时返回旧缓存并低优先级刷新。
app.post(`${API}/summary`, requireGuestQuota("summary", 30), async (req, res) => {
  const scope: ReportScope = req.body?.scope === "month"
    ? "month"
    : req.body?.scope === "week"
      ? "week"
      : "day";
  const dateLabel = typeof req.body?.dateLabel === "string" ? req.body.dateLabel : "";
  const periodKey = typeof req.body?.periodKey === "string" && req.body.periodKey
    ? req.body.periodKey.slice(0, 40)
    : dateLabel.slice(0, 40);
  const entries: ReportEntry[] = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 2000) : [];
  if (!entries.length) {
    res.status(204).end();
    return;
  }
  try {
    if (codexWorkerOnline()) {
      if (isGuestUser(req.userId)) {
        const job = enqueueAiJob(req.userId!, "summary", {
          scope,
          dateLabel,
          entries,
        });
        res.status(202).json({ kind: "pending", jobId: job.id });
        return;
      }
      const inputHash = reportFingerprint(entries);
      const cached = getCachedReport(req.userId!, scope, periodKey);
      if (cached?.inputHash === inputHash) {
        res.json({ ...cached.report, cached: true, stale: false, updatedAt: cached.updatedAt });
        return;
      }
      const job = ensureSummaryJob(req.userId!, scope, periodKey, dateLabel, entries);
      if (cached) {
        res.json({
          ...cached.report,
          cached: true,
          stale: true,
          updatedAt: cached.updatedAt,
          refreshJobId: job.id,
        });
        return;
      }
      res.status(202).json({ kind: "pending", jobId: job.id });
      return;
    }
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
    scheduleReportRefresh(req.userId!);
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
  scheduleReportRefresh(req.userId!);
  res.json(updated);
});

app.delete(`${API}/entries/:id`, (req, res) => {
  const ok = deleteEntry(req.params.id, req.userId!);
  if (!ok) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  scheduleReportRefresh(req.userId!);
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
