import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

export const CODEX_QUEUE_PROTOCOL_VERSION = 1;
export const CODEX_QUEUE_POLICY_VERSION = "2026-07-19.3";

export type AiJobKind = "ingest" | "correct" | "summary";
export type AiJobStatus = "QUEUED" | "PROCESSING" | "COMPLETE" | "FAILED";

export interface AiJob {
  id: string;
  userId: string;
  kind: AiJobKind;
  status: AiJobStatus;
  input: unknown;
  result: unknown | null;
  error: string | null;
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
`);
const hasPriority = (db.prepare("PRAGMA table_info(ai_jobs)").all() as unknown as { name: string }[])
  .some((column) => column.name === "priority");
if (!hasPriority) db.exec("ALTER TABLE ai_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50");

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
});

const IngestResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), fields: z.array(EntryFieldsSchema).min(1).max(8) }),
  z.object({
    kind: z.literal("save"),
    title: z.string().min(1).max(100),
    content: z.string().min(1).max(10_000),
  }),
  z.object({
    kind: z.literal("ask"),
    answer: z.string().min(1).max(10_000),
    sourceIds: z.array(z.string()).max(20).default([]),
  }),
]);

const CorrectResultSchema = z.object({ fields: EntryFieldsSchema });
const SummaryResultSchema = z.object({
  highlights: z.array(z.string().min(1).max(300)).max(8),
  improvements: z.array(z.string().min(1).max(300)).max(8),
  suggestions: z.array(z.string().min(1).max(300)).max(8),
});

export function validateAiResult(kind: AiJobKind, value: unknown): unknown {
  if (kind === "ingest") return IngestResultSchema.parse(value);
  if (kind === "correct") return CorrectResultSchema.parse(value);
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
  input_json: string;
  result_json: string | null;
  error: string | null;
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
    input: JSON.parse(row.input_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function enqueueAiJob(
  userId: string,
  kind: AiJobKind,
  input: unknown,
  priority = kind === "summary" ? 10 : 100,
): AiJob {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ai_jobs
    (id,user_id,kind,status,input_json,priority,created_at,updated_at)
    VALUES (?,?,?,'QUEUED',?,?,?,?)`).run(id, userId, kind, JSON.stringify(input), priority, now, now);
  return getAiJob(id, userId)!;
}

export function getAiJob(id: string, userId: string): AiJob | null {
  const row = db.prepare("SELECT * FROM ai_jobs WHERE id=? AND user_id=?").get(id, userId) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function findActiveSummaryJob(
  userId: string,
  scope: string,
  periodKey: string,
  inputHash: string,
): AiJob | null {
  const row = db.prepare(`SELECT * FROM ai_jobs
    WHERE user_id=? AND kind='summary' AND status IN ('QUEUED','PROCESSING')
      AND json_extract(input_json,'$.reportCache.periodKey')=?
      AND json_extract(input_json,'$.reportCache.scope')=?
      AND json_extract(input_json,'$.reportCache.inputHash')=?
    ORDER BY created_at DESC LIMIT 1`).get(userId, periodKey, scope, inputHash) as unknown as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function claimAiJob(workerId: string): { job: AiJob; leaseToken: string; leaseSeconds: number } | null {
  const now = new Date();
  const nowIso = now.toISOString();
  db.prepare(`INSERT INTO codex_workers (worker_id,last_seen_at) VALUES (?,?)
    ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(workerId, nowIso);
  const leaseSeconds = Math.max(30, Number(process.env.CODEX_WORKER_LEASE_SECONDS || 180));
  const maxAttempts = Math.max(1, Number(process.env.CODEX_WORKER_MAX_ATTEMPTS || 3));
  const active = db.prepare(`SELECT id FROM ai_jobs WHERE worker_id=? AND status='PROCESSING' AND lease_until>? LIMIT 1`)
    .get(workerId, nowIso);
  if (active) return null;

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT * FROM ai_jobs
      WHERE attempts < ? AND (status='QUEUED' OR (status='PROCESSING' AND lease_until<=?))
      ORDER BY priority DESC, created_at ASC LIMIT 1`).get(maxAttempts, nowIso) as unknown as JobRow | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    db.prepare(`UPDATE ai_jobs SET status='PROCESSING',worker_id=?,lease_hash=?,lease_until=?,heartbeat_at=?,
      attempts=attempts+1,error=NULL,updated_at=? WHERE id=?`)
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
  db.prepare(`UPDATE ai_jobs SET status='COMPLETE',result_json=?,lease_hash=NULL,lease_until=NULL,
    heartbeat_at=NULL,error=NULL,updated_at=? WHERE id=?`).run(JSON.stringify(result), now, id);
  return rowToJob(db.prepare("SELECT * FROM ai_jobs WHERE id=?").get(id) as unknown as JobRow);
}

export function failAiJob(id: string, leaseToken: string, reason: string, retryable: boolean): boolean {
  const row = leasedRow(id, leaseToken);
  if (!row) return false;
  const maxAttempts = Math.max(1, Number(process.env.CODEX_WORKER_MAX_ATTEMPTS || 3));
  const status: AiJobStatus = retryable && row.attempts < maxAttempts ? "QUEUED" : "FAILED";
  const now = new Date().toISOString();
  db.prepare(`UPDATE ai_jobs SET status=?,error=?,worker_id=NULL,lease_hash=NULL,lease_until=NULL,
    heartbeat_at=NULL,updated_at=? WHERE id=?`).run(status, reason.slice(0, 500), now, id);
  return true;
}
