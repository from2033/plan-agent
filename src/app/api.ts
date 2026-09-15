// 后端 API 封装。所有请求带 Authorization: Bearer <token>。

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";
const TOKEN_KEY = "pa_access_token";

export type EntryType = "activity" | "expense" | "memo" | "wish";

export interface Entry {
  id: string;
  type: EntryType;
  raw: string;
  time: string;
  timeRange?: { start: string; end: string };
  description: string;
  category: string;
  amount?: number;
  currency?: string;
  priority?: "low" | "medium" | "high";
  done?: boolean;
  timestamp: string; // ISO 字符串（前端再转 Date）
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class UnauthorizedError extends Error {}

export interface DesktopPairingSession {
  id: string;
  desktopSecret: string;
  pairingUri: string;
  deviceLabel: string;
  expiresAt: string;
}

export interface DesktopPairingClaim {
  status: "waiting" | "complete";
  token?: string;
  user?: string;
  expiresAt?: string;
}

async function publicRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok && res.status !== 202) {
    throw new Error(value?.error || `请求失败 (${res.status})`);
  }
  return value as T;
}

export function createDesktopPairing(deviceLabel: string): Promise<DesktopPairingSession> {
  return publicRequest<DesktopPairingSession>("/auth/desktop-sessions", { deviceLabel });
}

export function claimDesktopPairing(
  id: string,
  desktopSecret: string,
): Promise<DesktopPairingClaim> {
  return publicRequest<DesktopPairingClaim>(
    `/auth/desktop-sessions/${encodeURIComponent(id)}/claim`,
    { desktopSecret },
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// 实时识别 WebSocket 地址（带访问令牌）。API_BASE 可能是相对 '/app/api' 或绝对 'http://host/api'。
export function asrWsUrl(): string {
  let base = API_BASE;
  if (base.startsWith("/")) base = window.location.origin + base;
  const u = new URL(base + "/asr");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", getToken());
  return u.toString();
}

export function getMe(): Promise<{ user: string }> {
  return request<{ user: string }>("/me");
}

export function getEntries(): Promise<Entry[]> {
  return request<Entry[]>("/entries");
}

export interface AgentTask {
  id: string;
  capability: string;
  standardVersion: string;
  stage: string;
  sourceType?: string;
  input: { title?: string; details?: string };
  failures: string[];
  nextAction?: string;
  updatedAt: string;
}
export const getAgentTasks = (): Promise<AgentTask[]> => request<AgentTask[]>("/agent/tasks");
export const confirmAgentTask = (id: string): Promise<AgentTask> => request<AgentTask>(`/agent/tasks/${encodeURIComponent(id)}/confirm`, { method: "POST" });
export const retryAgentTask = (id: string): Promise<AgentTask> => request<AgentTask>(`/agent/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });

export interface FinanceImportResult {
  importId: string;
  alreadyImported: boolean;
  source: "alipay";
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  duplicateCount: number;
  importedAt: string;
}

export interface FinanceOverview {
  rangeMonths: number;
  periodStart: string | null;
  periodEnd: string | null;
  summary: {
    netExpense: number;
    grossExpense: number;
    refunds: number;
    income: number;
    transfersOut: number;
    paymentCount: number;
    activeDays: number;
    averagePayment: number;
    averageActiveDay: number;
  };
  categories: Array<{ category: string; amount: number; share: number; count: number }>;
  monthlyTrend: Array<{ month: string; amount: number; count: number }>;
  topCounterparties: Array<{ name: string; amount: number; count: number }>;
  insights: string[];
  recentTransactions: Array<{
    id: string;
    createdAt: string;
    counterparty: string;
    itemName: string;
    amount: number;
    refundedAmount: number;
    category: string;
    status: string;
  }>;
  imports: FinanceImportResult[];
}

export function getFinanceOverview(months = 3): Promise<FinanceOverview> {
  return request<FinanceOverview>(`/finance/overview?months=${months}`);
}

export async function importFinanceFile(file: File): Promise<FinanceImportResult> {
  const res = await fetch(`${API_BASE}/finance/import?fileName=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${getToken()}`,
    },
    body: file,
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  const payload = await res.json().catch(() => ({})) as FinanceImportResult & { error?: string };
  if (!res.ok) throw new Error(payload.error || `账单导入失败 (${res.status})`);
  return payload;
}

// 知识库条目（与后端 KnowledgeItem 对应）。
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  timestamp: string;
  sourceType?: "knowledge" | "document";
  category?: string;
  mimeType?: string;
  fileName?: string;
  vaultPath?: string;
  sourceKind?: "uploaded" | "derived";
}

// 统一语音入口的判别式结果：记录 / 存知识 / 问知识。
export type IngestResult =
  | { kind: "record"; entries: Entry[]; via: string }
  | { kind: "save"; item: KnowledgeItem }
  | { kind: "ask"; answer: string; sources: KnowledgeItem[] };

interface PendingIngestResult {
  kind: "pending";
  jobId?: string;
}

interface AiJobResult {
  status: "QUEUED" | "PROCESSING" | "DEFERRED" | "COMPLETE" | "FAILED";
  result: IngestResult | null;
  error?: string | null;
}

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

export async function addEntry(raw: string): Promise<IngestResult> {
  const submitted = await request<IngestResult | PendingIngestResult>("/entries", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
  if (submitted.kind !== "pending") return submitted;
  if (!submitted.jobId) throw new Error("后台任务未正确创建");

  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await wait(1500);
    const job = await request<AiJobResult>(`/ai-jobs/${encodeURIComponent(submitted.jobId)}`);
    if (job.status === "COMPLETE") {
      if (!job.result) throw new Error("后台任务完成但没有返回结果");
      return job.result;
    }
    if (job.status === "FAILED") throw new Error(job.error || "后台处理失败");
  }
  throw new Error("后台处理时间较长，请稍后刷新查看结果");
}

export function listKnowledge(): Promise<KnowledgeItem[]> {
  return request<KnowledgeItem[]>("/knowledge");
}

export function deleteKnowledge(id: string): Promise<void> {
  return request<void>(`/knowledge/${id}`, { method: "DELETE" });
}

export type MistakeMastery = "learning" | "review" | "mastered";
export type ReviewResult = "again" | "hard" | "good";

export interface MistakeReview {
  id: string;
  result: ReviewResult;
  note: string;
  reviewedAt: string;
}

export interface Mistake {
  id: string;
  childName: string;
  subject: string;
  grade: string;
  knowledgePoint: string;
  problem: string;
  wrongAnswer: string;
  correctAnswer: string;
  explanation: string;
  errorType: string;
  mastery: MistakeMastery;
  documentId: string | null;
  reviewCount: number;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviews: MistakeReview[];
}

export interface MistakeInput {
  childName: string;
  subject: string;
  grade?: string;
  knowledgePoint?: string;
  problem: string;
  wrongAnswer?: string;
  correctAnswer?: string;
  explanation?: string;
  errorType: string;
  mastery?: MistakeMastery;
  documentId?: string | null;
}

export function listMistakes(): Promise<Mistake[]> {
  return request<Mistake[]>("/mistakes");
}

export function createMistake(input: MistakeInput): Promise<Mistake> {
  return request<Mistake>("/mistakes", { method: "POST", body: JSON.stringify(input) });
}

export function deleteMistake(id: string): Promise<void> {
  return request<void>(`/mistakes/${id}`, { method: "DELETE" });
}

export function reviewMistake(id: string, result: ReviewResult, note = ""): Promise<Mistake> {
  return request<Mistake>(`/mistakes/${id}/reviews`, {
    method: "POST",
    body: JSON.stringify({ result, note }),
  });
}

export async function uploadDocument(file: File, note = ""): Promise<{ documentId: string; jobId?: string }> {
  const encodedNote = note
    ? btoa(String.fromCharCode(...new TextEncoder().encode(note)))
    : "";
  const extension = file.name.split(".").pop()?.toLowerCase();
  const inferredType = extension === "heic" ? "image/heic"
    : extension === "heif" ? "image/heif"
    : extension === "png" ? "image/png"
    : "image/jpeg";
  const res = await fetch(`${API_BASE}/documents?fileName=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || inferredType,
      Authorization: `Bearer ${getToken()}`,
      ...(encodedNote ? { "x-document-note-b64": encodedNote } : {}),
    },
    body: file,
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  if (!res.ok) throw new Error(`原题图片上传失败 (${res.status})`);
  return (await res.json()) as { documentId: string; jobId?: string };
}

export function toggleDone(id: string, done: boolean): Promise<Entry> {
  return request<Entry>(`/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ done }),
  });
}

export function deleteEntry(id: string): Promise<void> {
  return request<void>(`/entries/${id}`, { method: "DELETE" });
}

// 语音口述修正：把一句修改要求应用到指定记录，返回修改后的记录。
export function correctEntry(id: string, correction: string): Promise<Entry> {
  return request<Entry>(`/entries/${id}/correct`, {
    method: "POST",
    body: JSON.stringify({ correction }),
  });
}

// AI 报告：传当天/当月记录，返回文字点评。后端未配置 LLM 时返回 null（前端回退本地文案）。
export interface Report {
  highlights: string[];
  improvements: string[];
  suggestions: string[];
  via?: string;
}
export interface ReportEntryInput {
  type: string;
  category: string;
  description: string;
  amount?: number;
  timeRange?: { start: string; end: string };
  done?: boolean;
}
export async function getSummary(
  scope: "day" | "month",
  dateLabel: string,
  entries: ReportEntryInput[],
): Promise<Report | null> {
  return request<Report | null>("/summary", {
    method: "POST",
    body: JSON.stringify({ scope, dateLabel, entries }),
  });
}

// 上传录音（WAV）做语音识别，返回识别文本。
export async function transcribe(audio: Blob): Promise<string> {
  const res = await fetch(`${API_BASE}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${getToken()}`,
    },
    body: audio,
  });
  if (res.status === 401) throw new UnauthorizedError("未授权");
  if (!res.ok) throw new Error(`语音识别失败 (${res.status})`);
  const data = (await res.json()) as { text: string };
  return data.text || "";
}
