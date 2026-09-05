import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decField, encField } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

export const CODEX_QUEUE_PROTOCOL_VERSION = 13;
export const CODEX_QUEUE_POLICY_VERSION = "2026-09-05.1";

export type AiJobKind = "ingest" | "correct" | "summary" | "document" | "document_question" | "document_note" | "world_pulse" | "world_discovery" | "research" | "feedback_triage" | "feedback_repair" | "standard_evolution";
export type AiJobStatus = "QUEUED" | "PROCESSING" | "DEFERRED" | "COMPLETE" | "FAILED";
export type AiJobLane = "interactive" | "user_background" | "maintenance";

export interface AiJob {
  id: string;
  userId: string;
  kind: AiJobKind;
  status: AiJobStatus;
  lane: AiJobLane;
  input: unknown;
  result: unknown | null;
  error: string | null;
  errorKind: string | null;
  availableAt: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_jobs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'QUEUED',
    input_json      TEXT NOT NULL,
    result_json     TEXT,
    error           TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    priority        INTEGER NOT NULL DEFAULT 50,
    lane            TEXT NOT NULL DEFAULT 'user_background',
    available_at    TEXT,
    error_kind      TEXT,
    worker_id       TEXT,
    lease_hash      TEXT,
    lease_until     TEXT,
    heartbeat_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_queue ON ai_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_user ON ai_jobs(user_id, created_at);
  CREATE TABLE IF NOT EXISTS codex_workers (
    worker_id TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_service_state (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    failure_count INTEGER NOT NULL DEFAULT 0,
    error_kind TEXT,
    open_until TEXT,
    updated_at TEXT NOT NULL
  );
`);
const hasPriority = (db.prepare("PRAGMA table_info(ai_jobs)").all() as unknown as { name: string }[])
  .some((column) => column.name === "priority");
if (!hasPriority) db.exec("ALTER TABLE ai_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50");
const jobColumns = new Set((db.prepare("PRAGMA table_info(ai_jobs)").all() as unknown as { name: string }[])
  .map(column => column.name));
if (!jobColumns.has("lane")) db.exec("ALTER TABLE ai_jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'user_background'");
if (!jobColumns.has("available_at")) db.exec("ALTER TABLE ai_jobs ADD COLUMN available_at TEXT");
if (!jobColumns.has("error_kind")) db.exec("ALTER TABLE ai_jobs ADD COLUMN error_kind TEXT");
db.exec(`
  UPDATE ai_jobs SET lane='interactive'
    WHERE kind IN ('ingest','correct','document_question','document_note')
      AND status IN ('QUEUED','PROCESSING','DEFERRED');
  UPDATE ai_jobs SET lane='maintenance'
    WHERE kind IN ('summary','world_pulse','world_discovery','standard_evolution')
      AND status IN ('QUEUED','PROCESSING','DEFERRED');
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_dispatch
    ON ai_jobs(status,lane,priority,available_at,created_at);
`);

const EntryFieldsSchema = z.object({
  type: z.enum(["activity", "expense", "memo", "wish"]),
  description: z.string().min(1).max(500),
  category: z.string().min(1).max(40),
  amount: z.number().finite().nonnegative().nullish().transform((value) => value ?? undefined),
  currency: z.string().max(10).nullish().transform((value) => value ?? undefined),
  timeRange: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).nullish().transform((value) => value ?? undefined),
  priority: z.enum(["low", "medium", "high"]).nullish().transform((value) => value ?? undefined),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform((value) => value ?? undefined),
  reminderTime: z.string().regex(/^\d{2}:\d{2}$/).nullish().transform((value) => value ?? undefined),
  dateEvidence: z.string().max(80).nullish().transform((value) => value?.trim() || undefined),
  timeEvidence: z.string().max(80).nullish().transform((value) => value?.trim() || undefined),
});

const DocumentEvidenceSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(60),
  vaultPath: z.string().min(1).max(1_000),
  excerpt: z.string().min(1).max(2_000),
  relatedDocumentIds: z.array(z.string().uuid()).max(20).default([]),
});

const IngestResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    fields: z.array(EntryFieldsSchema).min(1).max(8),
    conversationTitle: z.string().min(2).max(30),
  }),
  z.object({
    kind: z.literal("save"),
    title: z.string().min(1).max(100),
    content: z.string().min(1).max(10_000),
    conversationTitle: z.string().min(2).max(30),
  }),
  z.object({
    kind: z.literal("ask"),
    answer: z.string().min(1).max(10_000),
    sourceIds: z.array(z.string()).max(20).default([]),
    documentSources: z.array(DocumentEvidenceSchema).max(8).default([]),
    retrievalStatus: z.enum([
      "answered_with_sources",
      "sources_found_insufficient",
      "no_sources_found",
      "general_answer",
    ]).optional(),
    conversationTitle: z.string().min(2).max(30),
  }),
]);

const CorrectResultSchema = z.object({ fields: EntryFieldsSchema });
const SummaryResultSchema = z.object({
  overview: z.string().min(1).max(2_000).optional().default(""),
  checklist: z.array(z.string().min(1).max(300)).max(12).optional().default([]),
  preparations: z.array(z.string().min(1).max(300)).max(12).optional().default([]),
  highlights: z.array(z.string().min(1).max(300)).max(8),
  improvements: z.array(z.string().min(1).max(300)).max(8),
  suggestions: z.array(z.string().min(1).max(300)).max(8),
});

const DocumentResultSchema = z.object({
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
  suggestedActions: z.array(z.object({
    kind: z.enum(["todo", "reminder"]),
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(500),
    dueAt: z.string().max(40).optional().default(""),
    confidence: z.number().min(0).max(1),
  })).max(5).optional().default([]),
});

const DocumentQuestionResultSchema = z.object({
  answer: z.string().min(1).max(10_000),
  insufficientEvidence: z.boolean(),
  sources: z.array(DocumentEvidenceSchema).max(8),
});

const DocumentNoteResultSchema = z.object({
  documentId: z.string().uuid(),
  note: z.string().min(1).max(2_000),
  appended: z.boolean(),
  vaultPath: z.string().min(1).max(1_000),
});

const WorldPulseResultSchema = z.object({
  overview: z.string().min(1).max(600),
  sections: z.array(z.object({
    id: z.string().min(1).max(60),
    summary: z.string().min(1).max(600),
    impact: z.string().min(1).max(600),
    outlook: z.string().min(1).max(600),
    action: z.string().min(1).max(300),
  })).min(1).max(8),
});

const WorldDiscoveryResultSchema = z.object({
  overview: z.string().min(1).max(600),
  radar: z.array(z.object({
    id: z.enum(["gold", "housing", "ai", "programmer", "policy", "international"]),
    hasReliableSignal: z.boolean(),
    summary: z.string().min(1).max(160),
  })).max(6).default([]),
  events: z.array(z.object({
    sectionId: z.enum([
      "gold_impact", "china_housing", "nanjing_housing", "china_programmer_jobs",
      "ai_development", "international", "china_policy", "china_policy_preview",
    ]),
    title: z.string().min(1).max(240),
    summary: z.string().min(1).max(800),
    whyItMatters: z.string().min(1).max(600),
    watchNext: z.string().min(1).max(500),
    verification: z.enum(["official", "multi_source", "single_source", "unverified"]),
    sourceIndexes: z.array(z.number().int().nonnegative()).min(1).max(3),
  })).max(8),
  discoveredAt: z.string().min(1).max(40),
});

const ResearchResultSchema = z.object({
  title: z.string().min(1).max(200),
  topicType: z.enum(["medical", "finance", "legal", "policy", "technology", "general"]),
  executiveSummary: z.string().min(1).max(2_000),
  keyTakeaways: z.array(z.string().min(1).max(500)).min(1).max(10),
  sections: z.array(z.object({
    heading: z.string().min(1).max(100),
    content: z.string().min(1).max(4_000),
  })).min(2).max(10),
  practicalActions: z.array(z.string().min(1).max(500)).max(10),
  cautions: z.array(z.string().min(1).max(500)).max(10),
  sources: z.array(z.object({
    title: z.string().min(1).max(300),
    publisher: z.string().min(1).max(120),
    url: z.string().url().max(2_000),
    publishedAt: z.string().max(40),
  })).min(2).max(20),
  researchedAt: z.string().min(1).max(40),
});

const FeedbackTriageResultSchema = z.object({
  category: z.enum(["bug", "missing_feature", "wrong_result", "usability", "performance", "other"]),
  summary: z.string().min(5).max(1_000),
  diagnosis: z.string().min(5).max(4_000),
  proposedPlan: z.array(z.string().min(2).max(500)).min(1).max(12),
  acceptanceChecks: z.array(z.string().min(2).max(500)).min(1).max(12),
  riskLevel: z.enum(["low", "medium", "high"]),
  canAutoRepair: z.boolean(),
  needsConfirmation: z.boolean(),
  confirmationQuestion: z.string().max(1_000),
});

const FeedbackRepairResultSchema = z.object({
  outcome: z.enum(["resolved", "needs_confirmation", "deferred", "failed"]),
  summary: z.string().min(5).max(2_000),
  changes: z.array(z.string().min(1).max(500)).max(30),
  tests: z.array(z.string().min(1).max(500)).max(30),
  commitHash: z.string().max(80).default(""),
  needsConfirmation: z.boolean(),
  confirmationQuestion: z.string().max(1_000),
  retryAfterMinutes: z.number().int().min(0).max(10_080),
  errorKind: z.enum(["none", "quota", "worker_offline", "temporary", "blocked", "validation"]),
});

const DeclarativeRuleSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().min(2).max(500),
  type: z.enum(["required", "min_items", "equals", "regex", "contains_all", "count_equals", "https_sources", "time_range", "receipt", "unique", "semantic_advisory"]),
  path: z.string().min(1).max(200),
  expectedPath: z.string().max(200).optional().default(""),
  value: z.array(z.string().max(500)).max(30).optional().default([]),
  minimum: z.number().int().min(0).max(100).optional().default(0),
  pattern: z.string().max(300).optional().default(""),
  fields: z.array(z.string().min(1).max(100)).max(20).optional().default([]),
});
const StandardEvolutionResultSchema = z.object({
  capability: z.string().min(1).max(100),
  baseVersion: z.string().min(1).max(80),
  rationale: z.string().min(5).max(4_000),
  riskLevel: z.enum(["low", "medium", "high"]),
  rules: z.array(DeclarativeRuleSchema).min(1).max(20),
  cases: z.array(z.object({
    name: z.string().min(1).max(120),
    input: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
    expectedPass: z.boolean(),
  })).min(2).max(20),
});

export function validateAiResult(kind: AiJobKind, value: unknown): unknown {
  if (kind === "ingest") return IngestResultSchema.parse(value);
  if (kind === "correct") return CorrectResultSchema.parse(value);
  if (kind === "document") return DocumentResultSchema.parse(value);
  if (kind === "document_question") return DocumentQuestionResultSchema.parse(value);
  if (kind === "document_note") return DocumentNoteResultSchema.parse(value);
  if (kind === "world_pulse") return WorldPulseResultSchema.parse(value);
  if (kind === "world_discovery") return WorldDiscoveryResultSchema.parse(value);
  if (kind === "research") return ResearchResultSchema.parse(value);
  if (kind === "feedback_triage") return FeedbackTriageResultSchema.parse(value);
  if (kind === "feedback_repair") return FeedbackRepairResultSchema.parse(value);
  if (kind === "standard_evolution") return StandardEvolutionResultSchema.parse(value);
  return SummaryResultSchema.parse(value);
}

export function codexQueueEnabled(): boolean {
  return /^[a-f0-9]{64}$/i.test(process.env.CODEX_WORKER_TOKEN_HASH || "");
}

export function codexWorkerOnline(maxAgeSeconds = 15): boolean {
  if (!codexQueueEnabled()) return false;
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  return Boolean(db.prepare("SELECT worker_id FROM codex_workers WHERE last_seen_at>=? LIMIT 1").get(cutoff));
}

export function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameHash(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function validWorkerToken(token: string): boolean {
  const expected = process.env.CODEX_WORKER_TOKEN_HASH || "";
  return Boolean(token && expected && sameHash(hashSecret(token), expected));
}

export function validLease(storedHash: string | null, token: string): boolean {
  return Boolean(storedHash && token && sameHash(hashSecret(token), storedHash));
}

interface JobRow {
  id: string;
  user_id: string;
  kind: AiJobKind;
  status: AiJobStatus;
  lane: AiJobLane;
  input_json: string;
  result_json: string | null;
  error: string | null;
  error_kind?: string | null;
  available_at?: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  worker_id?: string | null;
  lease_hash?: string | null;
  lease_until?: string | null;
}

function rowToJob(row: JobRow): AiJob {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    lane: row.lane || laneForKind(row.kind),
    input: JSON.parse(decField(row.input_json)),
    result: row.result_json ? JSON.parse(decField(row.result_json)) : null,
    error: row.error,
    errorKind: row.error_kind || null,
    availableAt: row.available_at || null,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function laneForKind(kind: AiJobKind): AiJobLane {
  if (["ingest", "correct", "document_question", "document_note"].includes(kind)) return "interactive";
  if (["summary", "world_pulse", "world_discovery", "standard_evolution"].includes(kind)) return "maintenance";
  return "user_background";
}

export function enqueueAiJob(
  userId: string,
  kind: AiJobKind,
  input: unknown,
  priority = kind === "summary" ? 10 : 100,
): AiJob {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const lane = laneForKind(kind);
  db.prepare(`INSERT INTO ai_jobs
    (id,user_id,kind,status,input_json,priority,lane,created_at,updated_at)
    VALUES (?,?,?,'QUEUED',?,?,?,?,?)`).run(
      id,
      userId,
      kind,
      kind === "document" || kind === "document_question" || kind === "document_note" || kind === "world_pulse" || kind === "world_discovery" || kind === "research" || kind === "feedback_triage" || kind === "feedback_repair"
        ? encField(JSON.stringify(input))
        : JSON.stringify(input),
      priority,
      lane,
      now,
      now,
    );
  return getAiJob(id, userId)!;
}

export function getAiJob(id: string, userId: string): AiJob | null {
  const row = db.prepare("SELECT * FROM ai_jobs WHERE id=? AND user_id=?").get(id, userId) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getLatestAiJob(userId: string, kind: AiJobKind): AiJob | null {
  const row = db.prepare("SELECT * FROM ai_jobs WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT 1")
    .get(userId, kind) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getLatestCompletedAiJob(userId: string, kind: AiJobKind): AiJob | null {
  const row = db.prepare("SELECT * FROM ai_jobs WHERE user_id=? AND kind=? AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1")
    .get(userId, kind) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export interface AgentRetryContext {
  conversationId: string | null;
  conversationHistory: Array<Record<string, unknown>>;
  interactionMode: string | null;
}

/**
 * Recover the richest original conversation context for an Agent task.
 *
 * Older Agent tasks did not persist conversationId/history in agent_tasks. Their
 * first AI job still contains that context, while later blind retries often do
 * not. Prefer the candidate with the most history instead of the newest job so
 * retry can repair the missing-context failure rather than repeat it.
 */
export function findBestAiJobContextForAgentTask(userId: string, agentTaskId: string): AgentRetryContext | null {
  const rows = db.prepare(`SELECT * FROM ai_jobs
    WHERE user_id=? AND kind='ingest' ORDER BY created_at DESC LIMIT 200`)
    .all(userId) as unknown as JobRow[];
  const candidates = rows.map(rowToJob).map((job) => {
    const input = job.input as {
      agentTaskId?: unknown;
      conversationId?: unknown;
      conversationHistory?: unknown;
      interactionMode?: unknown;
    };
    if (input.agentTaskId !== agentTaskId) return null;
    const conversationHistory = Array.isArray(input.conversationHistory)
      ? input.conversationHistory.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      : [];
    return {
      conversationId: typeof input.conversationId === "string" && input.conversationId ? input.conversationId : null,
      conversationHistory,
      interactionMode: typeof input.interactionMode === "string" ? input.interactionMode : null,
      updatedAt: job.updatedAt,
    };
  }).filter((item): item is AgentRetryContext & { updatedAt: string } => item !== null);
  candidates.sort((left, right) => right.conversationHistory.length - left.conversationHistory.length
    || Number(Boolean(right.conversationId)) - Number(Boolean(left.conversationId))
    || right.updatedAt.localeCompare(left.updatedAt));
  const best = candidates[0];
  return best ? {
    conversationId: best.conversationId,
    conversationHistory: best.conversationHistory,
    interactionMode: best.interactionMode,
  } : null;
}

export function findActiveSummaryJob(
  userId: string,
  scope: string,
  periodKey: string,
  inputHash: string,
): AiJob | null {
  const row = db.prepare(`SELECT * FROM ai_jobs
    WHERE user_id=? AND kind='summary' AND status IN ('QUEUED','PROCESSING','DEFERRED')
      AND json_extract(input_json,'$.reportCache.periodKey')=?
      AND json_extract(input_json,'$.reportCache.scope')=?
      AND json_extract(input_json,'$.reportCache.inputHash')=?
    ORDER BY created_at DESC LIMIT 1`).get(userId, periodKey, scope, inputHash) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function claimAiJob(workerId: string, now = new Date()): { job: AiJob; leaseToken: string; leaseSeconds: number } | null {
  const nowIso = now.toISOString();
  db.prepare(`INSERT INTO codex_workers (worker_id,last_seen_at) VALUES (?,?)
    ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(workerId, nowIso);
  const leaseSeconds = Math.max(30, Number(process.env.CODEX_WORKER_LEASE_SECONDS || 180));
  const service = db.prepare("SELECT open_until FROM codex_service_state WHERE singleton_id=1")
    .get() as { open_until: string | null } | undefined;
  if (service?.open_until && service.open_until > nowIso) return null;
  const active = db.prepare(`SELECT id FROM ai_jobs WHERE status='PROCESSING' AND lease_until>? LIMIT 1`)
    .get(nowIso);
  if (active) return null;

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT * FROM ai_jobs
      WHERE status='QUEUED'
        OR (status='DEFERRED' AND available_at<=?)
        OR (status='PROCESSING' AND lease_until<=?)
      ORDER BY CASE lane WHEN 'interactive' THEN 3 WHEN 'user_background' THEN 2 ELSE 1 END DESC,
        priority DESC, created_at ASC LIMIT 1`).get(nowIso, nowIso) as unknown as JobRow | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    db.prepare(`UPDATE ai_jobs SET status='PROCESSING',worker_id=?,lease_hash=?,lease_until=?,heartbeat_at=?,
      attempts=attempts+1,error=NULL,error_kind=NULL,available_at=NULL,updated_at=? WHERE id=?`)
      .run(workerId, hashSecret(leaseToken), leaseUntil, nowIso, nowIso, row.id);
    db.exec("COMMIT");
    const claimed = db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(row.id) as unknown as JobRow;
    return { job: rowToJob(claimed), leaseToken, leaseSeconds };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function leasedRow(id: string, leaseToken: string): JobRow | null {
  const row = db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
  if (!row || row.status !== "PROCESSING" || !row.lease_hash || !row.lease_until) return null;
  if (row.lease_until <= new Date().toISOString() || !validLease(row.lease_hash, leaseToken)) return null;
  return row;
}

export function heartbeatAiJob(id: string, leaseToken: string): number | null {
  const row = leasedRow(id, leaseToken);
  if (!row) return null;
  const leaseSeconds = Math.max(30, Number(process.env.CODEX_WORKER_LEASE_SECONDS || 180));
  const now = new Date();
  db.prepare("UPDATE ai_jobs SET lease_until=?,heartbeat_at=?,updated_at=? WHERE id=?")
    .run(new Date(now.getTime() + leaseSeconds * 1000).toISOString(), now.toISOString(), now.toISOString(), id);
  return leaseSeconds;
}

export function getLeasedAiJob(id: string, leaseToken: string): AiJob | null {
  const row = leasedRow(id, leaseToken);
  return row ? rowToJob(row) : null;
}

export function completeAiJob(
  id: string,
  leaseToken: string,
  rawResult: unknown,
  finalize?: (job: AiJob, validatedResult: unknown) => unknown,
): AiJob | null {
  const row = leasedRow(id, leaseToken);
  if (!row) return null;
  const validated = validateAiResult(row.kind, rawResult);
  const currentJob = rowToJob(row);
  const result = finalize ? finalize(currentJob, validated) : validated;
  const now = new Date().toISOString();
  const storedResult = row.kind === "document" || row.kind === "document_question" || row.kind === "document_note" || row.kind === "world_pulse" || row.kind === "world_discovery" || row.kind === "research" || row.kind === "feedback_triage" || row.kind === "feedback_repair"
    ? encField(JSON.stringify(result))
    : JSON.stringify(result);
  db.prepare(`UPDATE ai_jobs SET status='COMPLETE',result_json=?,lease_hash=NULL,lease_until=NULL,
    heartbeat_at=NULL,error=NULL,error_kind=NULL,available_at=NULL,updated_at=? WHERE id=?`).run(storedResult, now, id);
  db.prepare(`INSERT INTO codex_service_state(singleton_id,failure_count,error_kind,open_until,updated_at)
    VALUES(1,0,NULL,NULL,?) ON CONFLICT(singleton_id) DO UPDATE SET
    failure_count=0,error_kind=NULL,open_until=NULL,updated_at=excluded.updated_at`).run(now);
  return rowToJob(db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(id) as unknown as JobRow);
}

export function failAiJob(id: string, leaseToken: string, reason: string, retryable: boolean): boolean {
  const row = leasedRow(id, leaseToken);
  if (!row) return false;
  const errorKind = classifyCodexFailure(reason);
  const availabilityFailure = ["quota", "authentication", "network", "service_unavailable"].includes(errorKind);
  const maxAttempts = Math.max(1, Number(process.env.CODEX_WORKER_MAX_ATTEMPTS || 2));
  const shouldDefer = availabilityFailure || (retryable && row.attempts < maxAttempts);
  const status: AiJobStatus = shouldDefer ? "DEFERRED" : "FAILED";
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const delayMinutes = retryDelayMinutes(row.attempts);
  const availableAt = shouldDefer
    ? new Date(nowDate.getTime() + delayMinutes * 60_000).toISOString()
    : null;
  db.prepare(`UPDATE ai_jobs SET status=?,error=?,error_kind=?,available_at=?,worker_id=NULL,
    lease_hash=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?`)
    .run(status, reason.slice(0, 500), errorKind, availableAt, now, id);
  if (availabilityFailure) {
    db.prepare(`INSERT INTO codex_service_state(singleton_id,failure_count,error_kind,open_until,updated_at)
      VALUES(1,1,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
      failure_count=failure_count+1,error_kind=excluded.error_kind,open_until=excluded.open_until,
      updated_at=excluded.updated_at`).run(errorKind, availableAt, now);
  }
  return true;
}

export function retryDelayMinutes(attempts: number): number {
  return [1, 5, 15, 60][Math.min(3, Math.max(0, attempts - 1))];
}

export function classifyCodexFailure(reason: string): string {
  if (/usage|limit|quota|credit|429/i.test(reason)) return "quota";
  if (/auth|login|unauthorized|401|forbidden|403/i.test(reason)) return "authentication";
  if (/network|socket|ECONN|ENOTFOUND|fetch failed|timed?\s*out/i.test(reason)) return "network";
  if (/unavailable|overloaded|502|503|504/i.test(reason)) return "service_unavailable";
  if (/invalid|schema|validation|parse|json/i.test(reason)) return "validation";
  return "worker_error";
}
