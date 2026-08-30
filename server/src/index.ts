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
import { PRIMARY_USER, configuredUserIds, requireAuth, resolveUserId } from "./auth.js";
import {
  listEntries,
  listEntriesForViewer,
  insertEntry,
  setDone,
  setDoneForViewer,
  deleteEntry,
  getEntry,
  updateEntry,
  repairEntryReminder,
  clearEntryScheduledDate,
  clearEntryReminder,
  setEntryScheduledDate,
  listKnowledge,
  listKnowledgeForViewer,
  getKnowledgeForViewer,
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
  hasExplicitDateExpression,
  hasFutureRelativeDateExpression,
  inferReminderTimeFromText,
  inferTimeRangeFromText,
  isFutureObligation,
  normalizeScheduledDescription,
  reminderTimeAt,
  reminderTimestamp,
  type AssistantClock,
} from "./entry-date.js";
import type { Entry } from "./types.js";
import { extractQqTasks, qqMessageKnowledge } from "./qq-task-import.js";
import { knowledgeIntentHint, researchTopic, type IntentHint } from "./intent.js";
import { requestEmailCode, verifyEmailCode } from "./email-auth.js";
import { createGuestSession, isGuestUser } from "./guest-auth.js";
import { privacyPageHtml } from "./privacy-page.js";
import { knowledgeSpaceIdForUser } from "./knowledge-space.js";
import { conversationDocumentAccess, sharedDocumentScopesForViewer } from "./document-access.js";
import {
  addConversationResource,
  beginAiInteraction,
  completeAiInteraction,
  conversationContextForAi,
  createConversation,
  deleteConversation,
  deleteConversationAccountData,
  failAiInteraction,
  inviteConversationMember,
  listConversationInvitations,
  listConversationContacts,
  listConversationMembers,
  listConversationMessages,
  listConversationResources,
  listConversations,
  respondToConversationInvitation,
} from "./conversation-store.js";
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
  getLatestCompletedAiJob,
  getLatestAiJob,
  heartbeatAiJob,
  getLeasedAiJob,
  validWorkerToken,
  type AiJob,
} from "./ai-queue.js";
import {
  bindDocumentJob,
  appendDocumentNote,
  completeDocument,
  createResearchDocument,
  deleteUserDocuments,
  discardDocument,
  failDocument,
  findDuplicateDocument,
  getDocument,
  getDocumentForViewer,
  listDocuments,
  listDocumentsForViewer,
  readDocumentUpload,
  readDocumentUploadForViewer,
  registerLocalDocument,
  resolveDocumentEvidence,
  storeDocumentUpload,
} from "./document-store.js";
import {
  deleteFamilyAccountData,
  getFamilyState,
  inviteFamilyMember,
  respondToFamilyInvitation,
  shareResourceWithFamily,
  unshareResourceFromFamily,
} from "./family-sharing.js";
import {
  chunkedUploadStore,
  MAX_CHUNKED_DOCUMENT_SIZE,
} from "./chunked-upload.js";
import {
  deleteMistake,
  insertMistake,
  listMistakes,
  reviewMistake,
} from "./mistakes.js";
import {
  buildWorldPulseDiscoveryInput,
  currentWorldPulseDiscovery,
  getWorldPulse,
  saveWorldPulseAnalysis,
  saveWorldPulseDiscovery,
  type WorldPulseAnalysis,
  type WorldPulseDiscovery,
} from "./world-pulse.js";

const PORT = Number(process.env.PORT) || 8787;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// 前端在哪个路径前缀下提供（与 vite base 一致）。
const BASE_PATH = process.env.BASE_PATH ?? "";
const STUDY_APP_URL = process.env.STUDY_APP_URL || "https://sutyd.5656ai.com/app/";
const STUDY_SSO_SECRET = process.env.STUDY_SSO_SECRET || "";
const QQ_TASK_SYNC_SECRET = process.env.QQ_TASK_SYNC_SECRET || "";
const QQ_TASK_SYNC_USER = process.env.QQ_TASK_SYNC_USER || process.env.PRIMARY_USER || "我";

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

const qqTaskMessageSchema = z.object({
  externalId: z.string().min(1).max(200),
  groupId: z.string().min(1).max(100),
  groupName: z.string().min(1).max(200),
  sender: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  sentAt: z.string().datetime(),
});

// QQ 采集服务的内部入口：使用独立共享密钥，不经过个人登录态。
app.post(`${API}/integrations/qq-tasks`, (req, res) => {
  if (!QQ_TASK_SYNC_SECRET) {
    res.status(503).json({ error: "QQ群任务同步尚未配置" });
    return;
  }
  const token = String(req.get("x-integration-token") || "");
  const expected = Buffer.from(QQ_TASK_SYNC_SECRET);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: "同步凭证无效" });
    return;
  }
  const parsed = qqTaskMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "消息格式无效" });
    return;
  }
  // Keep the original message searchable in the owner's knowledge space. The
  // structured task below is only a derived view and must not replace source data.
  const source = qqMessageKnowledge(parsed.data);
  if (!getKnowledgeForViewer(source.id, QQ_TASK_SYNC_USER)) {
    insertKnowledge(QQ_TASK_SYNC_USER, source.title, source.content, source.id);
  }
  const candidates = extractQqTasks(parsed.data);
  const created: Entry[] = [];
  for (const entry of candidates) {
    if (getEntry(entry.id, QQ_TASK_SYNC_USER)) continue;
    insertEntry(entry, QQ_TASK_SYNC_USER);
    created.push(entry);
  }
  res.status(201).json({ created: created.length, skipped: candidates.length - created.length, entries: created });
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
  const requestedConversationId = String(
    (claimed.job.input as { conversationId?: unknown })?.conversationId || "",
  );
  const conversationAccess = requestedConversationId
    ? conversationDocumentAccess(requestedConversationId, claimed.job.userId)
    : null;
  res.json({
    protocolVersion: CODEX_QUEUE_PROTOCOL_VERSION,
    policyVersion: CODEX_QUEUE_POLICY_VERSION,
    leaseToken: claimed.leaseToken,
    leaseSeconds: claimed.leaseSeconds,
    job: {
      id: claimed.job.id,
      kind: claimed.job.kind,
      spaceId: knowledgeSpaceIdForUser(claimed.job.userId),
      ...(conversationAccess
        ? {
            primaryDocumentIds: conversationAccess.primaryDocumentIds,
            sharedDocumentScopes: conversationAccess.sharedDocumentScopes,
          }
        : { sharedDocumentScopes: sharedDocumentScopesForViewer(claimed.job.userId) }),
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

app.get(`${WORKER_API}/jobs/:id/document`, requireWorker, (req, res) => {
  const leaseToken = req.header("x-job-lease") || "";
  const job = getLeasedAiJob(req.params.id, leaseToken);
  const documentId = job?.kind === "document"
    ? String((job.input as { documentId?: unknown })?.documentId || "")
    : "";
  if (!job || !documentId) {
    res.status(409).json({ error: "invalid_or_expired_lease" });
    return;
  }
  const uploaded = readDocumentUpload(documentId, job.userId);
  if (!uploaded) {
    res.status(404).json({ error: "document_not_found" });
    return;
  }
  res.setHeader("content-type", uploaded.document.mimeType || "application/octet-stream");
  res.setHeader("x-document-id", uploaded.document.id);
  res.setHeader("x-file-name-b64", Buffer.from(uploaded.document.fileName, "utf8").toString("base64"));
  res.send(uploaded.content);
});

const LocalDocumentRegistrationSchema = z.object({
  userId: z.string().min(1).max(320),
  spaceId: z.string().regex(/^[a-f0-9]{64}$/),
  documentId: z.string().uuid(),
  fileName: z.string().min(1).max(240),
  mimeType: z.string().min(1).max(120),
  byteSize: z.number().int().nonnegative().max(10 * 1024 * 1024 * 1024),
  vaultPath: z.string().min(1).max(1_000),
  result: z.object({
    documentId: z.string().uuid(),
    title: z.string().min(1).max(200),
    category: z.string().min(1).max(60),
    summary: z.string().max(5_000),
    people: z.array(z.string().min(1).max(80)).max(20),
    keywords: z.array(z.string().min(1).max(80)).max(30),
    documentDate: z.string().max(20),
    vaultPath: z.string().min(1).max(1_000),
    attachmentPath: z.string().min(1).max(1_000),
    textLength: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1).max(300)).max(20),
  }),
  notes: z.array(z.string().min(1).max(2_000)).max(50).default([]),
}).superRefine((value, context) => {
  if (value.documentId !== value.result.documentId || value.vaultPath !== value.result.vaultPath) {
    context.addIssue({ code: "custom", message: "local_document_identity_mismatch" });
  }
});

app.post(`${WORKER_API}/local-documents`, requireWorker, (req, res) => {
  const parsed = LocalDocumentRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "local_document_invalid" });
    return;
  }
  if (knowledgeSpaceIdForUser(parsed.data.userId) !== parsed.data.spaceId) {
    res.status(403).json({ error: "knowledge_space_mismatch" });
    return;
  }
  const document = registerLocalDocument(parsed.data.userId, parsed.data);
  res.status(201).json({ ok: true, documentId: document.id, storageKind: document.storageKind });
});

interface WorkerIngestResult {
  kind: "record" | "save" | "ask";
  fields?: Array<Omit<Entry, "id" | "raw" | "time" | "timestamp" | "scheduledDate" | "reminderAt"> & {
    date?: string;
    reminderTime?: string;
  }>;
  title?: string;
  content?: string;
  answer?: string;
  sourceIds?: string[];
  conversationTitle?: string;
  documentSources?: Array<{
    documentId: string;
    title: string;
    category: string;
    vaultPath: string;
    excerpt: string;
    relatedDocumentIds?: string[];
  }>;
}

function fallbackKnowledge(raw: string): { title: string; content: string } {
  const content = raw
    .replace(/^(?:请)?(?:帮我)?(?:记|记录|存|保存)(?:到|进|入)(?:我的)?(?:个人)?(?:知识库|芝士库)[：:\s]*/u, "")
    .trim() || raw.trim();
  const title = (content.split(/[，。；;：:\n]/u)[0] || content).slice(0, 24);
  return { title, content };
}

function knowledgeFromRequest(req: express.Request, conversationId = ""): Array<{
  id: string;
  title: string;
  content: string;
  timestamp: string;
}> {
  const visible = !isGuestUser(req.userId!) ? listKnowledgeForViewer(req.userId!) : [];
  if (conversationId && conversationDocumentAccess(conversationId, req.userId!) !== null) {
    const resources = listConversationResources(conversationId, req.userId!) || [];
    const scoped = resources
      .filter(resource => resource.resourceType === "knowledge")
      .flatMap(resource => {
        const item = getKnowledgeForViewer(resource.resourceId, req.userId!);
        return item ? [{ id: item.id, title: item.title, content: item.content, timestamp: item.timestamp }] : [];
      });
    const qqNotes = listKnowledge(QQ_TASK_SYNC_USER)
      .filter((item) => item.id.startsWith("qq-message-"))
      .map(({ id, title, content, timestamp }) => ({ id, title, content, timestamp }));
    const base = [...visible, ...scoped];
    return addUnifiedSources(req, conversationId, [...base, ...qqNotes.filter((item) => !base.some((candidate) => candidate.id === item.id))]);
  }
  if (!isGuestUser(req.userId) || !Array.isArray(req.body?.knowledge)) {
    const qqNotes = listKnowledge(QQ_TASK_SYNC_USER)
      .filter((item) => item.id.startsWith("qq-message-") && QQ_TASK_SYNC_USER !== req.userId)
      .map(({ id, title, content, timestamp }) => ({ id, title, content, timestamp }));
    return addUnifiedSources(req, conversationId, [...visible, ...qqNotes.filter((item) => !visible.some((candidate) => candidate.id === item.id))]);
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

/** Build one permission-filtered corpus for knowledge, entries and chat evidence.
 * The worker may rank this corpus, but it must never receive data outside this list.
 */
function addUnifiedSources(
  req: express.Request,
  conversationId: string,
  notes: Array<{ id: string; title: string; content: string; timestamp: string }>,
) {
  const seen = new Set(notes.map(item => item.id));
  const entries = isGuestUser(req.userId!) ? [] : listEntriesForViewer(req.userId!, QQ_TASK_SYNC_USER);
  for (const entry of entries) {
    const id = `entry-${entry.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    notes.push({
      id,
      title: `日常记录｜${entry.category}`.slice(0, 100),
      content: `${entry.description}\n原始内容：${entry.raw}\n时间：${entry.timestamp}`.slice(0, 10_000),
      timestamp: entry.timestamp,
    });
  }
  if (conversationId) {
    const history = conversationContextForAi(conversationId, req.userId!, 30) || [];
    history.forEach((message, index) => {
      const id = `conversation-${conversationId}-${index}`;
      if (seen.has(id)) return;
      seen.add(id);
      notes.push({
        id,
        title: `聊天记录｜${message.role === "user" ? "用户" : "助手"}`,
        content: message.content.slice(0, 10_000),
        timestamp: new Date().toISOString(),
      });
    });
  }
  return notes;
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

function tomorrowBriefEntries(userId: string, now = new Date()): ReportEntry[] {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dateKey = shanghaiDate(tomorrow.toISOString());
  const entries = listEntriesForViewer(userId, QQ_TASK_SYNC_USER)
    .filter((entry) => (entry.scheduledDate || entry.reminderAt && shanghaiDate(entry.reminderAt)) === dateKey
      || (entry.type === "memo" && !entry.done))
    .map((entry) => ({
      type: entry.type,
      category: entry.category,
      description: entry.description,
      amount: entry.amount,
      timeRange: entry.timeRange,
      done: entry.done,
      date: entry.scheduledDate || (entry.reminderAt ? shanghaiDate(entry.reminderAt) : undefined),
    }));
  const knowledge = listKnowledgeForViewer(userId).slice(0, 80).map((item) => ({
    type: "knowledge",
    category: "资料",
    description: `${item.title}：${item.content}`,
  }));
  return [...entries, ...knowledge];
}

function shanghaiDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

const WORLD_DISCOVERY_MINUTE = 6 * 60 + 30;
let worldDiscoveryScheduling = false;

function shanghaiMinuteOfDay(now: Date): number {
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(values.find(part => part.type === type)?.value || 0);
  return value("hour") * 60 + value("minute");
}

async function ensureScheduledWorldDiscovery(now = new Date()): Promise<void> {
  if (worldDiscoveryScheduling || !codexQueueEnabled() || shanghaiMinuteOfDay(now) < WORLD_DISCOVERY_MINUTE) return;
  const dayKey = shanghaiDate(now.toISOString());
  const latest = getLatestAiJob("world-pulse-system", "world_discovery");
  const latestDay = String((latest?.input as { dayKey?: unknown } | undefined)?.dayKey || "");
  if (latestDay === dayKey) return;
  worldDiscoveryScheduling = true;
  try {
    const pulse = await getWorldPulse(true);
    const input = await buildWorldPulseDiscoveryInput(pulse, dayKey);
    enqueueAiJob("world-pulse-system", "world_discovery", input, 60);
    console.log(`[world pulse] 已创建 ${dayKey} 06:30 每日巡检任务`);
  } catch (error) {
    console.error("[world pulse] 创建每日巡检任务失败:", error);
  } finally {
    worldDiscoveryScheduling = false;
  }
}

function scheduledDateFor(
  date: string | undefined,
  reminderAt: string | undefined,
  timeRange: { start: string; end: string } | undefined,
  clock: AssistantClock,
): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return date;
  if (reminderAt) return shanghaiDate(reminderAt);
  return timeRange ? clock.currentDate : undefined;
}

function finalizeWorkerResult(job: AiJob, value: unknown): unknown {
  if (job.kind === "world_discovery") {
    const dayKey = String((job.input as { dayKey?: unknown }).dayKey || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      throw new Error("world_discovery_day_missing");
    }
    const candidates = (job.input as {
      candidateGroups?: Array<{ candidates?: Array<{
        sourceIndex?: unknown; title?: unknown; source?: unknown; url?: unknown; publishedAt?: unknown;
        sourceTier?: unknown;
      }> }>;
    }).candidateGroups?.flatMap(group => group.candidates || []) || [];
    const sourcesByIndex = new Map(candidates.map(source => [Number(source.sourceIndex), source]));
    const discovery = value as Omit<WorldPulseDiscovery, "events"> & {
      events: Array<Omit<WorldPulseDiscovery["events"][number], "sources"> & { sourceIndexes: number[] }>;
    };
    // A model can occasionally echo the field descriptions from the prompt
    // (for example, "准确简洁的中文标题") while still satisfying the loose
    // JSON schema. Never publish such a result as a daily briefing.
    const placeholderPattern = /^(?:准确简洁的中文标题|一句话总结|一句话说明影响|一句话后续验证信号)$/u;
    const hasPlaceholder = (event: typeof discovery.events[number]) =>
      [event.title, event.summary, event.whyItMatters, event.watchNext]
        .some(text => placeholderPattern.test(String(text || "").trim()));
    if (discovery.events.some(hasPlaceholder)) {
      throw new Error("world_discovery_placeholder_content");
    }
    const safeValue: WorldPulseDiscovery = {
      ...discovery,
      events: discovery.events.flatMap(event => {
        const sources = event.sourceIndexes.flatMap(sourceIndex => {
          const candidate = sourcesByIndex.get(sourceIndex);
          if (!candidate) return [];
          return [{
            title: String(candidate.title || "").slice(0, 300),
            publisher: String(candidate.source || "").slice(0, 120),
            url: String(candidate.url || "").slice(0, 2_000),
            publishedAt: String(candidate.publishedAt || "").slice(0, 40),
          }];
        });
        if (!sources.length) return [];
        const { sourceIndexes: _, ...safeEvent } = event;
        const publishers = new Set(sources.map(source => source.publisher));
        const hasPrimarySource = event.sourceIndexes.some(sourceIndex =>
          sourcesByIndex.get(sourceIndex)?.sourceTier === "authority");
        const verification = hasPrimarySource
          ? "official" as const
          : publishers.size >= 2 ? "multi_source" as const : "single_source" as const;
        return [{ ...safeEvent, verification, sources: sources.slice(0, 3) }];
      }),
    };
    if (!safeValue.events.length) {
      throw new Error("world_discovery_no_grounded_events");
    }
    saveWorldPulseDiscovery(dayKey, safeValue);
    return safeValue;
  }
  if (job.kind === "world_pulse") {
    const fingerprint = String((job.input as { fingerprint?: unknown }).fingerprint || "");
    if (!fingerprint) throw new Error("world_pulse_fingerprint_missing");
    saveWorldPulseAnalysis(fingerprint, value as WorldPulseAnalysis);
    return value;
  }
  if (job.kind === "research") {
    const reportId = String((job.input as { reportId?: unknown })?.reportId || "");
    const report = getDocument(reportId, job.userId);
    if (!report || report.storageKind !== "research") {
      throw new Error("research_report_missing");
    }
    completeDocument(reportId, job.userId, value);
    return value;
  }
  if (job.kind === "document") {
    const documentId = String((job.input as { documentId?: unknown })?.documentId || "");
    if (!documentId) throw new Error("document_id_missing");
    completeDocument(documentId, job.userId, value);
    return value;
  }
  if (job.kind === "document_note") {
    const input = job.input as { documentId?: unknown; note?: unknown };
    const documentId = String(input.documentId || "");
    const note = String(input.note || "").trim();
    if (!documentId || !note || !appendDocumentNote(documentId, job.userId, note)) {
      throw new Error("document_note_target_missing");
    }
    return value;
  }
  if (job.kind === "document_question") {
    const result = value as {
      sources?: Array<{ documentId?: unknown; relatedDocumentIds?: unknown }>;
    };
    for (const source of result.sources || []) {
      const documentId = String(source.documentId || "");
      const relatedDocumentIds = Array.isArray(source.relatedDocumentIds)
        ? source.relatedDocumentIds.filter((id): id is string => typeof id === "string")
        : [];
      if (!documentId || !resolveDocumentEvidence(job.userId, documentId, relatedDocumentIds)) {
        throw new Error("document_question_source_ownership_mismatch");
      }
    }
    return value;
  }
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
    interactionMode?: "conversation" | "home" | "capture";
    inputMode?: "voice" | "text";
    conversationId?: string;
    context?: AssistantClock;
    knowledge?: Array<{ id: string; title: string; content: string; timestamp: string }>;
    conversationHistory?: Array<{ role: string; content: string }>;
  };
  if (input.intentHint === "save") {
    const fallback = fallbackKnowledge(input.raw);
    const title = result.kind === "save" && result.title ? result.title : fallback.title;
    const content = result.kind === "save" && result.content ? result.content : fallback.content;
    const item = isGuestUser(job.userId)
      ? { id: `ai-${job.id}`, title, content, timestamp: new Date().toISOString() }
      : insertKnowledge(job.userId, title, content, `ai-${job.id}`);
    return { kind: "save", item, conversationTitle: result.conversationTitle };
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
    return { kind: "save", item, conversationTitle: result.conversationTitle };
  }
  if (result.kind === "ask") {
    const wanted = new Set(result.sourceIds || []);
    let knowledgeSources = (input.knowledge || [])
      .filter((item) => wanted.has(item.id))
      .map((item) => ({ ...item, sourceType: "knowledge" as const }));
    const documentSources = (result.documentSources || []).map((source) => {
      const resolved = resolveDocumentEvidence(
        job.userId,
        source.documentId,
        source.relatedDocumentIds || [],
      );
      if (!resolved) throw new Error("ingest_document_source_ownership_mismatch");
      const { document, sourceKind } = resolved;
      return {
        id: source.documentId,
        title: source.title,
        content: source.excerpt,
        timestamp: document.createdAt,
        sourceType: "document" as const,
        category: source.category,
        mimeType: sourceKind === "derived" ? "text/markdown" : document.mimeType,
        fileName: sourceKind === "derived" ? `${source.title}.md` : document.fileName,
        vaultPath: source.vaultPath,
        sourceKind,
      };
    });
    let resultConversationId = input.conversationId || "";
    if (input.interactionMode === "home" && !isGuestUser(job.userId)) {
      resultConversationId = createConversation(job.userId, "新对话");
      beginAiInteraction(
        job.userId,
        job.id,
        input.raw,
        input.inputMode || "voice",
        resultConversationId,
      );
    }
    return {
      kind: "ask",
      answer: result.answer,
      sources: [...documentSources, ...knowledgeSources],
      conversationTitle: result.conversationTitle,
      ...(resultConversationId ? { conversationId: resultConversationId } : {}),
    };
  }

  const now = new Date();
  const clock = input.context || assistantClock(now);
  const entries = (result.fields || []).map((fields, i): Entry => {
    const { date: modelDate, reminderTime, ...entryFields } = fields;
    const date = hasExplicitDateExpression(input.raw) ? modelDate : undefined;
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
    const modelRange = fields.timeRange?.start !== fields.timeRange?.end ? fields.timeRange : undefined;
    const timeRange = inferredRange || modelRange;
    if (timeRange) entryFields.timeRange = timeRange;
    else delete entryFields.timeRange;
    if (entryFields.type !== "expense") {
      delete entryFields.amount;
      delete entryFields.currency;
    }
    const reminderAt = entryFields.type === "memo"
      ? reminderTimestamp(input.raw, date, reminderTime, clock)
      : undefined;
    const reminderClock = reminderAt ? reminderTimeAt(reminderAt) : undefined;
    const timing = reminderAt
      ? { time: reminderClock || "", timestamp: reminderAt }
      : entryTiming(input.raw, date, timeRange, clock, i, now);
    const scheduledDate = scheduledDateFor(date, reminderAt, timeRange, clock);
    if (scheduledDate) {
      entryFields.description = normalizeScheduledDescription(entryFields.description);
    }
    return {
      id: `ai-${job.id}-${i}`,
      raw: input.raw,
      ...timing,
      ...entryFields,
      ...(scheduledDate ? { scheduledDate } : {}),
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
  }
  return { kind: "record", entries, via: "codex-desktop", conversationTitle: result.conversationTitle };
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
    completeAiInteraction(job.userId, job.id, job.kind, job.result);
    res.json({ ok: true, jobId: job.id });
  } catch (error) {
    console.error("[codex-worker result] 校验失败:", error);
    res.status(422).json({ error: "invalid_result" });
  }
});

app.post(`${WORKER_API}/jobs/:id/fail`, requireWorker, (req, res) => {
  const leaseToken = req.header("x-job-lease") || "";
  const leased = getLeasedAiJob(req.params.id, leaseToken);
  const ok = failAiJob(
    req.params.id,
    leaseToken,
    String(req.body?.reason || "worker_failed"),
    req.body?.retryable !== false,
  );
  if (!ok) {
    res.status(409).json({ error: "invalid_or_expired_lease" });
    return;
  }
  if (leased?.kind === "document" || leased?.kind === "research") {
    const current = getAiJob(leased.id, leased.userId);
    if (current?.status === "FAILED") {
      failDocument(
        String((leased.input as { documentId?: unknown; reportId?: unknown })?.documentId
          || (leased.input as { reportId?: unknown })?.reportId
          || ""),
        leased.userId,
        current.error || "document_processing_failed",
      );
    }
  }
  const current = leased ? getAiJob(leased.id, leased.userId) : null;
  if (leased && current?.status === "FAILED") failAiInteraction(leased.userId, leased.id);
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

app.get(`${API}/world-pulse`, async (req, res) => {
  try {
    const pulse = await getWorldPulse(req.query.refresh === "1");
    const dayKey = shanghaiDate(new Date().toISOString());
    const discoveryJob = getLatestAiJob("world-pulse-system", "world_discovery");
    const discoveryJobDay = String((discoveryJob?.input as { dayKey?: unknown } | undefined)?.dayKey || "");
    const completedDiscoveryJob = getLatestCompletedAiJob("world-pulse-system", "world_discovery");
    const completedDiscoveryDay = String((completedDiscoveryJob?.input as { dayKey?: unknown } | undefined)?.dayKey || "");
    if (
      completedDiscoveryJob?.result &&
      currentWorldPulseDiscovery()?.dayKey !== completedDiscoveryDay
    ) {
      saveWorldPulseDiscovery(completedDiscoveryDay, completedDiscoveryJob.result as WorldPulseDiscovery);
    }
    const briefing = currentWorldPulseDiscovery();
    const completedGroups = (completedDiscoveryDay === briefing?.dayKey
      ? (completedDiscoveryJob?.input as {
          candidateGroups?: Array<{
            candidates?: Array<{ source?: unknown }>;
          }>;
        } | undefined)?.candidateGroups
      : undefined) || [];
    const collectionTotals = completedDiscoveryDay === briefing?.dayKey
      ? (completedDiscoveryJob?.input as {
          collectionStrategy?: {
            totals?: {
              configured?: unknown; succeeded?: unknown; failed?: unknown;
              authorityCandidates?: unknown; newsCandidates?: unknown; hotspotCandidates?: unknown;
            };
          };
        } | undefined)?.collectionStrategy?.totals
      : undefined;
    const candidateCount = completedGroups.reduce(
      (total, group) => total + (group.candidates?.length || 0),
      0,
    );
    const sourceCount = new Set(
      completedGroups.flatMap(group =>
        (group.candidates || [])
          .map(candidate => String(candidate.source || ""))
          .filter(Boolean),
      ),
    ).size;
    res.json({
      ...pulse,
      discoveryStatus: discoveryJobDay === dayKey ? discoveryJob?.status : undefined,
      dailyBriefing: briefing ? {
        dayKey: briefing.dayKey,
        ...briefing.value,
        coverage: {
          sections: completedGroups.length,
          candidates: candidateCount,
          sources: sourceCount,
          configuredSources: Number(collectionTotals?.configured || 0),
          succeededSources: Number(collectionTotals?.succeeded || 0),
          failedSources: Number(collectionTotals?.failed || 0),
          authorityCandidates: Number(collectionTotals?.authorityCandidates || 0),
          newsCandidates: Number(collectionTotals?.newsCandidates || 0),
          hotspotCandidates: Number(collectionTotals?.hotspotCandidates || 0),
        },
      } : undefined,
      discoverySchedule: "每天 06:30",
    });
  } catch (error) {
    console.error("[world pulse] 新闻聚合失败:", error);
    res.status(502).json({ error: "暂时无法获取全球新闻，请稍后重试" });
  }
});

// 当前登录用户（用于前端显示是谁、以及校验 token 是否有效）。
app.get(`${API}/me`, (req, res) => {
  res.json({
    user: isGuestUser(req.userId) ? "访客" : req.userId,
    guest: isGuestUser(req.userId),
  });
});

app.get(`${API}/family`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json({ family: null, invitations: [] });
    return;
  }
  res.json(getFamilyState(req.userId!, PRIMARY_USER));
});

const FamilyInviteSchema = z.object({ account: z.string().trim().min(1).max(200) });
app.post(`${API}/family/invitations`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再邀请家庭成员" });
    return;
  }
  const parsed = FamilyInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "请输入对方的登录邮箱或账号" });
    return;
  }
  const invitation = inviteFamilyMember(req.userId!, parsed.data.account, PRIMARY_USER);
  if (!invitation) {
    res.status(409).json({ error: "无法邀请该账号，可能已加入家庭或邀请对象不正确" });
    return;
  }
  res.status(201).json(invitation);
});

const FamilyResponseSchema = z.object({ accept: z.boolean() });
app.post(`${API}/family/invitations/:id/respond`, (req, res) => {
  const parsed = FamilyResponseSchema.safeParse(req.body);
  if (!parsed.success || !respondToFamilyInvitation(req.params.id, req.userId!, parsed.data.accept)) {
    res.status(404).json({ error: "家庭邀请不存在或已处理" });
    return;
  }
  res.json(getFamilyState(req.userId!, PRIMARY_USER));
});

// Create a short-lived, one-time-style launch ticket for the QQ group center.
// The account id itself is never placed in the URL.
app.post(`${API}/study/launch`, (req, res) => {
  if (!STUDY_SSO_SECRET) {
    res.status(503).json({ error: "QQ群消息中心尚未配置" });
    return;
  }
  const subject = crypto
    .createHash("sha256")
    .update(req.userId!)
    .digest("hex")
    .slice(0, 32);
  const payload = Buffer.from(JSON.stringify({
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 120,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", STUDY_SSO_SECRET)
    .update(payload)
    .digest("hex");
  const url = new URL(STUDY_APP_URL);
  url.searchParams.set("sso", `${payload}.${signature}`);
  res.json({ url: url.toString() });
});

// App Store account-deletion requirement: deletion is initiated in-app and is
// effective immediately. The same email may create a new, empty account later.
app.delete(`${API}/account`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "访客模式没有云端账户" });
    return;
  }
  try {
    deleteUserDocuments(req.userId!);
    deleteFamilyAccountData(req.userId!);
    deleteConversationAccountData(req.userId!);
    deleteAccountData(req.userId!);
    res.status(204).end();
  } catch (error) {
    console.error("[account deletion] 删除失败:", error);
    res.status(500).json({ error: "账户删除失败，请稍后重试" });
  }
});

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "audio/wav",
  "audio/x-wav",
]);

function acceptDocumentUpload(
  userId: string,
  fileName: string,
  mimeType: string,
  content: Buffer,
  userNote: string,
): { status: number; body: Record<string, unknown> } {
  const duplicate = findDuplicateDocument(userId, content);
  if (duplicate && duplicate.status !== "FAILED") {
    if (userNote && duplicate.status === "COMPLETE") {
      const job = enqueueAiJob(userId, "document_note", {
        documentId: duplicate.id,
        note: userNote,
      }, 95);
      return {
        status: 202,
        body: {
          duplicate: true,
          noteQueued: true,
          documentId: duplicate.id,
          jobId: job.id,
          status: job.status,
        },
      };
    }
    return {
      status: 200,
      body: { duplicate: true, documentId: duplicate.id, status: duplicate.status },
    };
  }
  if (duplicate) discardDocument(duplicate.id, userId);
  const document = storeDocumentUpload(userId, fileName, mimeType, content, userNote);
  try {
    const job = enqueueAiJob(userId, "document", {
      documentId: document.id,
      ...(userNote ? { userNote } : {}),
    }, 90);
    bindDocumentJob(document.id, userId, job.id);
    return {
      status: 202,
      body: { documentId: document.id, jobId: job.id, status: "QUEUED" },
    };
  } catch (error) {
    discardDocument(document.id, userId);
    throw error;
  }
}

const ChunkedDocumentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120).transform(value => value.toLowerCase()),
  userNote: z.string().trim().max(100_000).default(""),
  totalBytes: z.number().int().positive().max(MAX_CHUNKED_DOCUMENT_SIZE),
});

app.post(`${API}/documents/uploads`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再上传家庭资料" });
    return;
  }
  const parsed = ChunkedDocumentUploadSchema.safeParse(req.body);
  if (!parsed.success || !DOCUMENT_MIME_TYPES.has(parsed.data?.mimeType || "")) {
    res.status(400).json({ error: "上传资料参数无效" });
    return;
  }
  try {
    const upload = chunkedUploadStore.create(req.userId!, parsed.data);
    res.status(201).json({
      uploadId: upload.id,
      chunkSize: upload.chunkSize,
      chunkCount: upload.chunkCount,
    });
  } catch (error) {
    console.error("[chunked document upload] 创建失败:", error);
    res.status(500).json({ error: "无法开始资料上传" });
  }
});

app.put(
  `${API}/documents/uploads/:id/chunks/:index`,
  express.raw({ type: () => true, limit: "9mb" }),
  (req, res) => {
    if (isGuestUser(req.userId)) {
      res.status(403).json({ error: "请先登录后再上传家庭资料" });
      return;
    }
    try {
      chunkedUploadStore.writeChunk(
        req.userId!,
        req.params.id,
        Number(req.params.index),
        req.body as Buffer,
      );
      res.status(204).end();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const status = code === "upload_not_found" ? 404 : 400;
      res.status(status).json({ error: status === 404 ? "上传任务不存在" : "录音分片无效" });
    }
  },
);

app.post(`${API}/documents/uploads/:id/complete`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再上传家庭资料" });
    return;
  }
  try {
    const assembled = chunkedUploadStore.assemble(req.userId!, req.params.id);
    const accepted = acceptDocumentUpload(
      req.userId!,
      assembled.metadata.fileName,
      assembled.metadata.mimeType,
      assembled.content,
      assembled.metadata.userNote,
    );
    chunkedUploadStore.remove(req.userId!, req.params.id);
    res.status(accepted.status).json(accepted.body);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "upload_not_found" || code === "upload_incomplete" || code === "upload_size_mismatch") {
      res.status(code === "upload_not_found" ? 404 : 409).json({
        error: code === "upload_not_found" ? "上传任务不存在" : "录音分片尚未上传完整",
      });
      return;
    }
    console.error("[chunked document upload] 合并失败:", error);
    res.status(500).json({ error: "录音合并保存失败" });
  }
});

app.get(`${API}/documents`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  res.json(listDocumentsForViewer(req.userId!));
});

app.get(`${API}/documents/:id/content`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再查看原始资料" });
    return;
  }
  const uploaded = readDocumentUploadForViewer(req.params.id, req.userId!);
  if (!uploaded) {
    res.status(404).json({ error: "原始文件不存在或不属于当前账号" });
    return;
  }
  res.setHeader("content-type", uploaded.document.mimeType || "application/octet-stream");
  res.setHeader("content-length", uploaded.content.length);
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.send(uploaded.content);
});

app.delete(`${API}/documents/:id`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再删除资料" });
    return;
  }
  const document = getDocument(req.params.id, req.userId!);
  if (!document) {
    res.status(404).json({ error: "资料不存在或不属于当前账号" });
    return;
  }
  unshareResourceFromFamily(req.userId!, "document", document.id);
  discardDocument(document.id, req.userId!);
  res.status(204).end();
});

app.put(`${API}/documents/:id/family`, (req, res) => {
  const document = getDocument(req.params.id, req.userId!);
  if (!document) {
    res.status(404).json({ error: "资料不存在" });
    return;
  }
  if (!shareResourceWithFamily(req.userId!, "document", document.id)) {
    res.status(409).json({ error: "请先加入家庭，再共享资料" });
    return;
  }
  res.json(getDocumentForViewer(document.id, req.userId!));
});

app.delete(`${API}/documents/:id/family`, (req, res) => {
  if (!unshareResourceFromFamily(req.userId!, "document", req.params.id)) {
    res.status(404).json({ error: "这份资料尚未共享" });
    return;
  }
  res.status(204).end();
});

const MistakeInputSchema = z.object({
  childName: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1).max(40),
  grade: z.string().trim().max(40).optional().default(""),
  knowledgePoint: z.string().trim().max(100).optional().default(""),
  problem: z.string().trim().min(1).max(10_000),
  wrongAnswer: z.string().trim().max(5_000).optional().default(""),
  correctAnswer: z.string().trim().max(5_000).optional().default(""),
  explanation: z.string().trim().max(10_000).optional().default(""),
  errorType: z.enum(["概念不清", "审题错误", "计算失误", "方法不熟", "其他"]),
  mastery: z.enum(["learning", "review", "mastered"]).optional(),
  documentId: z.string().uuid().nullable().optional(),
});

app.get(`${API}/mistakes`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  res.json(listMistakes(req.userId!));
});

app.post(`${API}/mistakes`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再保存孩子的错题" });
    return;
  }
  const parsed = MistakeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "错题信息不完整" });
    return;
  }
  if (parsed.data.documentId && !getDocument(parsed.data.documentId, req.userId!)) {
    res.status(400).json({ error: "关联的原题图片不存在" });
    return;
  }
  res.status(201).json(insertMistake(req.userId!, parsed.data));
});

app.delete(`${API}/mistakes/:id`, (req, res) => {
  const ok = deleteMistake(req.params.id, req.userId!);
  res.status(ok ? 204 : 404).end();
});

const MistakeReviewSchema = z.object({
  result: z.enum(["again", "hard", "good"]),
  note: z.string().trim().max(1_000).optional().default(""),
});

app.post(`${API}/mistakes/:id/reviews`, (req, res) => {
  const parsed = MistakeReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "复习结果无效" });
    return;
  }
  const mistake = reviewMistake(req.params.id, req.userId!, parsed.data.result, parsed.data.note);
  if (!mistake) {
    res.status(404).json({ error: "错题不存在" });
    return;
  }
  res.json(mistake);
});

const DocumentQuestionSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  inputMode: z.enum(["voice", "text"]).optional().default("text"),
  conversationId: z.string().uuid().optional(),
});

app.post(`${API}/documents/questions`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再提问家庭资料" });
    return;
  }
  const parsed = DocumentQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "问题不能为空" });
    return;
  }
  const job = enqueueAiJob(req.userId!, "document_question", {
    question: parsed.data.question,
    ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
  }, 95);
  beginAiInteraction(
    req.userId!,
    job.id,
    parsed.data.question,
    parsed.data.inputMode,
    parsed.data.conversationId,
  );
  res.status(202).json({ jobId: job.id, status: job.status });
});

const DocumentNoteSchema = z.object({
  note: z.string().trim().min(1).max(2_000),
});

app.post(`${API}/documents/:id/notes`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再补充资料说明" });
    return;
  }
  const parsed = DocumentNoteSchema.safeParse(req.body);
  const document = getDocument(req.params.id, req.userId!);
  if (!parsed.success) {
    res.status(400).json({ error: "补充说明不能为空" });
    return;
  }
  if (!document || document.status !== "COMPLETE") {
    res.status(404).json({ error: "资料不存在或仍在处理中" });
    return;
  }
  const job = enqueueAiJob(req.userId!, "document_note", {
    documentId: document.id,
    note: parsed.data.note,
  }, 95);
  res.status(202).json({ jobId: job.id, status: job.status });
});

app.post(
  `${API}/documents`,
  // Older app versions upload a complete WAV in one request. Keep enough room
  // to recover their pending recordings; current builds use chunked uploads.
  express.raw({ type: () => true, limit: "256mb" }),
  (req, res) => {
    if (isGuestUser(req.userId)) {
      res.status(403).json({ error: "请先登录后再上传家庭资料" });
      return;
    }
    const fileName = String(req.query.fileName || "").trim().slice(0, 240);
    const encodedNote = String(req.header("x-document-note-b64") || "").trim();
    const userNote = encodedNote
      ? Buffer.from(encodedNote, "base64").toString("utf8").trim().slice(0, 2_000)
      : "";
    const mimeType = String(req.header("content-type") || "application/octet-stream")
      .split(";")[0].trim().toLowerCase();
    const content = req.body as Buffer;
    if (!fileName || !content?.length) {
      res.status(400).json({ error: "文件名和文件内容不能为空" });
      return;
    }
    if (!DOCUMENT_MIME_TYPES.has(mimeType)) {
      res.status(415).json({ error: "支持 PDF、Word、图片、文本和 WAV 录音" });
      return;
    }
    try {
      const accepted = acceptDocumentUpload(req.userId!, fileName, mimeType, content, userNote);
      res.status(accepted.status).json(accepted.body);
    } catch (error) {
      console.error("[document upload] 保存失败:", error);
      res.status(500).json({ error: "资料上传失败" });
    }
  },
);

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
    scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
    ...(item.scheduledDate ? { scheduledDate: item.scheduledDate } : {}),
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

app.get(`${API}/conversations`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q : "";
  res.json(listConversations(req.userId!, query));
});

const CreateConversationSchema = z.object({
  title: z.string().trim().max(80).optional().default("新对话"),
});

app.post(`${API}/conversations`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再新建对话" });
    return;
  }
  const parsed = CreateConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "对话名称无效" });
    return;
  }
  const id = createConversation(req.userId!, parsed.data.title);
  res.status(201).json({ id });
});

app.delete(`${API}/conversations/:id`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再删除对话" });
    return;
  }
  if (!deleteConversation(req.params.id, req.userId!)) {
    res.status(404).json({ error: "对话不存在或当前账号无权访问" });
    return;
  }
  res.status(204).end();
});

app.get(`${API}/conversation-invitations`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  res.json(listConversationInvitations(req.userId!));
});

app.get(`${API}/conversation-contacts`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  const recent = new Set(listConversationContacts(req.userId!));
  const family = getFamilyState(req.userId!, PRIMARY_USER).family;
  const familyMembers = new Set(
    (family?.members || [])
      .map(member => member.userId)
      .filter(account => account !== req.userId),
  );
  res.json([...new Set([...familyMembers, ...recent])]
    .sort((first, second) => first.localeCompare(second))
    .map(account => ({
      account,
      familyMember: familyMembers.has(account),
      contactedBefore: recent.has(account),
    })));
});

const ConversationInvitationResponseSchema = z.object({ accept: z.boolean() });
app.post(`${API}/conversation-invitations/:id/respond`, (req, res) => {
  const parsed = ConversationInvitationResponseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "邀请处理方式无效" });
    return;
  }
  const conversationId = respondToConversationInvitation(
    req.params.id,
    req.userId!,
    parsed.data.accept,
  );
  if (!conversationId) {
    res.status(404).json({ error: "邀请不存在或已经处理" });
    return;
  }
  res.json({ conversationId, accepted: parsed.data.accept });
});

app.get(`${API}/conversations/:id/members`, (req, res) => {
  const members = listConversationMembers(req.params.id, req.userId!);
  if (!members) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  res.json(members);
});

const InviteConversationMemberSchema = z.object({
  account: z.string().trim().min(1).max(320),
});
app.post(`${API}/conversations/:id/invitations`, (req, res) => {
  const parsed = InviteConversationMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "请输入要邀请的账号" });
    return;
  }
  const invitation = inviteConversationMember(
    req.params.id,
    req.userId!,
    parsed.data.account,
  );
  if (!invitation) {
    res.status(409).json({ error: "无法邀请：仅对话创建者可以邀请，或该账号已经在对话中" });
    return;
  }
  res.status(201).json(invitation);
});

app.get(`${API}/conversations/:id/resources`, (req, res) => {
  const resources = listConversationResources(req.params.id, req.userId!);
  if (!resources) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  res.json(resources);
});

app.put(`${API}/conversations/:id/resources/:type/:resourceId`, (req, res) => {
  const resourceType = req.params.type;
  if (resourceType !== "document" && resourceType !== "knowledge") {
    res.status(400).json({ error: "资料类型无效" });
    return;
  }
  let resourceTitle = "资料";
  if (resourceType === "document") {
    const document = getDocument(req.params.resourceId, req.userId!);
    if (!document) {
      res.status(404).json({ error: "只能把自己拥有的资料加入群聊" });
      return;
    }
    resourceTitle = String(((document.result as { title?: unknown } | null)?.title) || document.fileName);
  } else {
    const knowledge = getKnowledgeForViewer(req.params.resourceId, req.userId!);
    if (!knowledge || !knowledge.canEdit) {
      res.status(404).json({ error: "只能把自己拥有的资料加入群聊" });
      return;
    }
    resourceTitle = knowledge.title;
  }
  if (!resourceTitle) {
    res.status(404).json({ error: "只能把自己拥有的资料加入群聊" });
    return;
  }
  if (!addConversationResource(
    req.params.id,
    req.userId!,
    resourceType,
    req.params.resourceId,
    req.userId!,
    resourceTitle,
  )) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  res.status(201).json({ ok: true });
});

app.get(`${API}/conversations/:id/messages`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.status(403).json({ error: "请先登录后再查看 AI 对话" });
    return;
  }
  const messages = listConversationMessages(
    req.params.id,
    req.userId!,
    Number(req.query.limit || 100),
  );
  if (!messages) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  res.json(messages);
});

app.get(`${API}/entries`, (req, res) => {
  if (isGuestUser(req.userId)) {
    res.json([]);
    return;
  }
  const clock = assistantClock();
  const now = new Date(`${clock.currentDate}T${clock.currentTime}:00+08:00`).getTime();
  const entries = listEntriesForViewer(req.userId!, QQ_TASK_SYNC_USER).map((entry) => {
    // 共享 QQ 群任务不参与当前账号的日期/闹钟修复，避免跨账号写错所有者。
    if (entry.category === "QQ群任务") {
      return entry.scheduledDate || entry.reminderAt
        ? { ...entry, description: normalizeScheduledDescription(entry.description) }
        : entry;
    }
    if (
      entry.type === "activity" &&
      !entry.scheduledDate &&
      !entry.reminderAt &&
      hasFutureRelativeDateExpression(entry.raw)
    ) {
      entry = setEntryScheduledDate(
        entry.id,
        shanghaiDate(entry.timestamp),
        req.userId!,
      ) || entry;
    }
    if (
      entry.type === "memo" &&
      entry.scheduledDate &&
      !entry.reminderAt &&
      !hasExplicitDateExpression(entry.raw)
    ) {
      entry = clearEntryScheduledDate(entry.id, req.userId!) || entry;
    }
    if (entry.scheduledDate || entry.reminderAt) {
      entry = {
        ...entry,
        description: normalizeScheduledDescription(entry.description),
      };
    }
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
    const repaired = repairEntryReminder(entry.id, req.userId!, reminderTime, reminderAt);
    return repaired
      ? { ...repaired, description: normalizeScheduledDescription(repaired.description) }
      : entry;
  });
  res.json(entries);
});

// 统一语音入口：先判意图，再分流为「记录 / 存入知识库 / 查询知识库」。
app.post(`${API}/entries`, requireGuestQuota("ingest", 120), async (req, res) => {
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  const inputMode = req.body?.inputMode === "text" ? "text" as const : "voice" as const;
  const conversationId = typeof req.body?.conversationId === "string"
    ? req.body.conversationId.trim().slice(0, 100)
    : "";
  const conversationHistory = conversationId
    ? conversationContextForAi(conversationId, req.userId!, 16)
    : null;
  if (conversationId && !conversationHistory) {
    res.status(404).json({ error: "对话不存在或当前账号无权访问" });
    return;
  }
  let synchronousInteractionId: string | null = null;
  const interactionConversationId = conversationId;
  if (!raw) {
    res.status(400).json({ error: "raw 不能为空" });
    return;
  }
  try {
    const topic = researchTopic(raw, conversationHistory || []);
    if (topic) {
      if (isGuestUser(req.userId)) {
        res.status(403).json({ error: "请先登录后再创建后台研究报告" });
        return;
      }
      if (!codexQueueEnabled()) {
        res.status(503).json({ error: "后台研究服务尚未就绪" });
        return;
      }
      const document = createResearchDocument(req.userId!, topic);
      const researchConversationId = interactionConversationId
        || createConversation(req.userId!, "新对话");
      try {
        const job = enqueueAiJob(req.userId!, "research", {
          reportId: document.id,
          query: topic,
          originalRequest: raw,
          requestedAt: new Date().toISOString(),
          locale: "zh-CN",
          audience: "中国普通用户",
          ...(conversationHistory?.length ? { conversationHistory } : {}),
          conversationId: researchConversationId,
        }, 70);
        beginAiInteraction(req.userId!, job.id, raw, inputMode, researchConversationId);
        bindDocumentJob(document.id, req.userId!, job.id);
        res.status(201).json({
          kind: "research",
          reportId: document.id,
          jobId: job.id,
          status: "QUEUED",
          title: `研究报告：${topic}`,
        });
      } catch (error) {
        discardDocument(document.id, req.userId!);
        throw error;
      }
      return;
    }
    const intentHint = knowledgeIntentHint(raw);
    if (codexWorkerOnline()) {
      const knowledge = knowledgeFromRequest(req, conversationId);
      const job = enqueueAiJob(req.userId!, "ingest", {
        raw,
        intentHint,
        interactionMode: interactionConversationId ? "conversation" : "home",
        inputMode,
        context: assistantClock(),
        knowledge,
        ...(conversationHistory?.length ? { conversationHistory } : {}),
        ...(interactionConversationId ? { conversationId: interactionConversationId } : {}),
      });
      if (!isGuestUser(req.userId) && interactionConversationId) {
        beginAiInteraction(req.userId!, job.id, raw, inputMode, interactionConversationId || undefined);
      }
      res.status(202).json({ kind: "pending", jobId: job.id });
      return;
    }
    if (!isGuestUser(req.userId) && interactionConversationId) {
      synchronousInteractionId = `sync-${crypto.randomUUID()}`;
      beginAiInteraction(req.userId!, synchronousInteractionId, raw, inputMode, interactionConversationId || undefined);
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
      const response = { kind: "save", item };
      if (synchronousInteractionId) {
        completeAiInteraction(req.userId!, synchronousInteractionId, "ingest", response);
      }
      res.status(201).json(response);
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
      const response = { kind: "save", item };
      if (synchronousInteractionId) {
        completeAiInteraction(req.userId!, synchronousInteractionId, "ingest", response);
      }
      res.status(201).json(response);
      return;
    }

    // 查询知识库
    if (result.kind === "ask") {
      const notes = knowledgeFromRequest(req, conversationId);
      const ans = await answerQuestion(notes, result.query);
      if (!ans) {
        if (synchronousInteractionId) failAiInteraction(req.userId!, synchronousInteractionId);
        res.status(503).json({ kind: "ask", answer: "未配置 AI，无法查询知识库。", sources: [] });
        return;
      }
      let resultConversationId = interactionConversationId;
      if (!resultConversationId && !isGuestUser(req.userId)) {
        resultConversationId = createConversation(req.userId!, "新对话");
        synchronousInteractionId = `sync-${crypto.randomUUID()}`;
        beginAiInteraction(req.userId!, synchronousInteractionId, raw, inputMode, resultConversationId);
      }
      const response = {
        kind: "ask",
        answer: ans.answer,
        sources: ans.sources,
        ...(resultConversationId ? { conversationId: resultConversationId } : {}),
      };
      if (synchronousInteractionId) {
        completeAiInteraction(req.userId!, synchronousInteractionId, "ingest", response);
      }
      res.json(response);
      return;
    }

    // 默认：记录入库
    const now = new Date();
    const clock = assistantClock(now);
    // 一句话可能拆成多条；逐条入库。timestamp 加毫秒偏移，保证拆出的顺序稳定。
    const entries: Entry[] = result.fields.map((f, i) => {
      const { date: modelDate, reminderTime, ...entryFields } = f;
      const date = hasExplicitDateExpression(raw) ? modelDate : undefined;
      const forceMemo = isFutureObligation(raw, date, reminderTime, clock);
      if (forceMemo) {
        entryFields.type = "memo";
        entryFields.category = "备忘";
        entryFields.priority ??= "medium";
      }
      const inferredRange =
        f.type === "activity" || f.type === "memo" ? inferTimeRangeFromText(raw) : undefined;
      const modelRange = f.timeRange?.start !== f.timeRange?.end ? f.timeRange : undefined;
      const timeRange = inferredRange || modelRange;
      if (timeRange) entryFields.timeRange = timeRange;
      else delete entryFields.timeRange;
      if (entryFields.type !== "expense") {
        delete entryFields.amount;
        delete entryFields.currency;
      }
      const reminderAt = entryFields.type === "memo"
        ? reminderTimestamp(raw, date, reminderTime, clock)
        : undefined;
      const reminderClock = reminderAt ? reminderTimeAt(reminderAt) : undefined;
      const scheduledDate = scheduledDateFor(date, reminderAt, timeRange, clock);
      if (scheduledDate) {
        entryFields.description = normalizeScheduledDescription(entryFields.description);
      }
      return {
        id: crypto.randomUUID(),
        raw,
        ...(reminderAt
          ? { time: reminderClock || "", timestamp: reminderAt }
          : entryTiming(raw, date, timeRange, clock, i, now)),
        ...entryFields,
        ...(scheduledDate ? { scheduledDate } : {}),
        ...(reminderAt ? { reminderAt } : {}),
      };
    });
    if (!isGuestUser(req.userId)) {
      for (const entry of entries) insertEntry(entry, req.userId!);
    }
    const response = { kind: "record", entries, via: result.via };
    if (synchronousInteractionId) {
      completeAiInteraction(req.userId!, synchronousInteractionId, "ingest", response);
    }
    res.status(201).json(response);
  } catch (err) {
    if (synchronousInteractionId) failAiInteraction(req.userId!, synchronousInteractionId);
    console.error("[POST entries] 失败:", err);
    res.status(500).json({ error: "记录失败" });
  }
});

// 知识库：列出 / 删除
app.get(`${API}/knowledge`, (req, res) => {
  res.json(listKnowledgeForViewer(req.userId!));
});

app.delete(`${API}/knowledge/:id`, (req, res) => {
  unshareResourceFromFamily(req.userId!, "knowledge", req.params.id);
  const ok = deleteKnowledge(req.params.id, req.userId!);
  if (!ok) {
    res.status(404).json({ error: "知识不存在" });
    return;
  }
  res.status(204).end();
});

app.put(`${API}/knowledge/:id/family`, (req, res) => {
  const own = listKnowledge(req.userId!).find((item) => item.id === req.params.id);
  if (!own) {
    res.status(404).json({ error: "知识不存在" });
    return;
  }
  if (!shareResourceWithFamily(req.userId!, "knowledge", own.id)) {
    res.status(409).json({ error: "请先加入家庭，再共享资料" });
    return;
  }
  res.json({ ok: true });
});

app.delete(`${API}/knowledge/:id/family`, (req, res) => {
  if (!unshareResourceFromFamily(req.userId!, "knowledge", req.params.id)) {
    res.status(404).json({ error: "这条知识尚未共享" });
    return;
  }
  res.status(204).end();
});

// AI 报告（日报/周报/月报）：只在报告页请求时按需生成；内容未变化则直接命中缓存。
app.post(`${API}/summary`, requireGuestQuota("summary", 30), async (req, res) => {
  const scope: ReportScope = req.body?.scope === "tomorrow"
    ? "tomorrow"
    : req.body?.scope === "month"
    ? "month"
    : req.body?.scope === "week"
      ? "week"
      : "day";
  const dateLabel = typeof req.body?.dateLabel === "string" ? req.body.dateLabel : "";
  const periodKey = typeof req.body?.periodKey === "string" && req.body.periodKey
    ? req.body.periodKey.slice(0, 40)
    : dateLabel.slice(0, 40);
  let entries: ReportEntry[] = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 2000) : [];
  if (scope === "tomorrow") entries = tomorrowBriefEntries(req.userId!);
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
  const updated = setDoneForViewer(
    req.params.id,
    req.body.done,
    req.userId!,
    QQ_TASK_SYNC_USER,
  );
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

void ensureScheduledWorldDiscovery();
const worldDiscoveryTimer = setInterval(() => {
  void ensureScheduledWorldDiscovery();
}, 60_000);
worldDiscoveryTimer.unref();

// 每天上海时间 18:00 后为已配置账号预生成明日管家简报。若服务重启晚于 18:00，
// 也会在首次巡检时补生成；内容变化时由 App 请求接口触发刷新。
let tomorrowBriefScheduledDate = "";
function ensureScheduledTomorrowBrief(now = new Date()): void {
  const today = shanghaiDate(now.toISOString());
  if (shanghaiMinuteOfDay(now) < 18 * 60 || tomorrowBriefScheduledDate === today) return;
  tomorrowBriefScheduledDate = today;
  for (const userId of configuredUserIds()) {
    const entries = tomorrowBriefEntries(userId, now);
    if (!entries.length) continue;
    const periodKey = shanghaiDate(new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());
    ensureSummaryJob(userId, "tomorrow", periodKey, periodKey, entries);
  }
}
void ensureScheduledTomorrowBrief();
const tomorrowBriefTimer = setInterval(() => {
  ensureScheduledTomorrowBrief();
}, 60_000);
tomorrowBriefTimer.unref();

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
