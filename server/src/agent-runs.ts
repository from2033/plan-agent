import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

export type AgentRunStatus =
  | "received"
  | "queued"
  | "processing"
  | "awaiting_confirmation"
  | "deferred"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: string;
  userId: string;
  clientRequestId: string | null;
  conversationId: string | null;
  rootTaskId: string | null;
  jobId: string | null;
  inputMode: "text" | "voice" | "image" | "mixed";
  raw: string;
  status: AgentRunStatus;
  statusText: string;
  result: unknown | null;
  errorKind: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AgentMessage {
  id: string;
  runId: string;
  kind: "input" | "status" | "result" | "error";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface RunRow {
  id: string;
  user_id: string;
  client_request_id: string | null;
  conversation_id: string | null;
  root_task_id: string | null;
  job_id: string | null;
  input_mode: AgentRun["inputMode"];
  raw_input: string;
  status: AgentRunStatus;
  status_text: string;
  result_json: string | null;
  error_kind: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface MessageRow {
  id: string;
  run_id: string;
  message_kind: AgentMessage["kind"];
  content: string;
  metadata_json: string;
  created_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_request_id TEXT,
    conversation_id TEXT,
    root_task_id TEXT,
    job_id TEXT,
    input_mode TEXT NOT NULL,
    raw_input TEXT NOT NULL,
    status TEXT NOT NULL,
    status_text TEXT NOT NULL,
    result_json TEXT,
    error_kind TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_client_request
    ON agent_runs(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_job
    ON agent_runs(job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_runs_user_timeline
    ON agent_runs(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    message_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_run
    ON agent_messages(run_id, created_at, id);
`);

function normalizeUserId(value: string): string {
  const clean = value.trim();
  return clean.includes("@") ? clean.toLowerCase() : clean;
}

function parseResult(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(decField(value));
  } catch {
    return null;
  }
}

function fromRow(row: RunRow): AgentRun {
  return {
    id: row.id,
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    conversationId: row.conversation_id,
    rootTaskId: row.root_task_id,
    jobId: row.job_id,
    inputMode: row.input_mode,
    raw: decField(row.raw_input),
    status: row.status,
    statusText: row.status_text,
    result: parseResult(row.result_json),
    errorKind: row.error_kind,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function appendMessage(
  runId: string,
  kind: AgentMessage["kind"],
  content: string,
  metadata: Record<string, unknown> = {},
  createdAt = new Date().toISOString(),
): void {
  db.prepare(`INSERT INTO agent_messages
    (id,run_id,message_kind,content,metadata_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(crypto.randomUUID(), runId, kind, encField(content), encField(JSON.stringify(metadata)), createdAt);
}

export function createAgentRun(
  userId: string,
  raw: string,
  options: {
    clientRequestId?: string;
    conversationId?: string;
    inputMode?: AgentRun["inputMode"];
  } = {},
): AgentRun {
  const owner = normalizeUserId(userId);
  const clientRequestId = options.clientRequestId?.trim().slice(0, 120) || null;
  if (clientRequestId) {
    const existing = db.prepare(`SELECT * FROM agent_runs WHERE user_id=? AND client_request_id=?`)
      .get(owner, clientRequestId) as unknown as RunRow | undefined;
    if (existing) return fromRow(existing);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO agent_runs
      (id,user_id,client_request_id,conversation_id,input_mode,raw_input,status,status_text,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'received','已交给总管Agent',?,?)`)
      .run(id, owner, clientRequestId, options.conversationId || null,
        options.inputMode || "text", encField(raw), now, now);
    appendMessage(id, "input", raw, { inputMode: options.inputMode || "text" }, now);
    appendMessage(id, "status", "已交给总管Agent", {}, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (clientRequestId) {
      const existing = db.prepare(`SELECT * FROM agent_runs WHERE user_id=? AND client_request_id=?`)
        .get(owner, clientRequestId) as unknown as RunRow | undefined;
      if (existing) return fromRow(existing);
    }
    throw error;
  }
  return getAgentRun(id, owner)!;
}

export function getAgentRun(id: string, userId: string): AgentRun | null {
  const row = db.prepare("SELECT * FROM agent_runs WHERE id=? AND user_id=?")
    .get(id, normalizeUserId(userId)) as unknown as RunRow | undefined;
  return row ? fromRow(row) : null;
}

export function getAgentRunByJob(jobId: string, userId: string): AgentRun | null {
  const row = db.prepare("SELECT * FROM agent_runs WHERE job_id=? AND user_id=?")
    .get(jobId, normalizeUserId(userId)) as unknown as RunRow | undefined;
  return row ? fromRow(row) : null;
}

export function listAgentRuns(userId: string, limit = 50): AgentRun[] {
  const rows = db.prepare(`SELECT * FROM agent_runs WHERE user_id=?
    ORDER BY created_at DESC LIMIT ?`).all(normalizeUserId(userId), Math.min(200, Math.max(1, limit))) as unknown as RunRow[];
  return rows.map(fromRow);
}

export function listAgentMessages(runId: string, userId: string): AgentMessage[] | null {
  if (!getAgentRun(runId, userId)) return null;
  const rows = db.prepare(`SELECT * FROM agent_messages WHERE run_id=? ORDER BY created_at,rowid`)
    .all(runId) as unknown as MessageRow[];
  return rows.map(row => ({
    id: row.id,
    runId: row.run_id,
    kind: row.message_kind,
    content: decField(row.content),
    metadata: JSON.parse(decField(row.metadata_json)) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}

export function bindAgentRun(
  userId: string,
  runId: string,
  values: { jobId?: string; rootTaskId?: string; status?: AgentRunStatus; statusText?: string },
): AgentRun | null {
  const current = getAgentRun(runId, userId);
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return current;
  const now = new Date().toISOString();
  const status = values.status || (values.jobId ? "queued" : current.status);
  const statusText = values.statusText || (values.jobId ? "等待Codex处理" : current.statusText);
  db.prepare(`UPDATE agent_runs SET job_id=COALESCE(?,job_id),root_task_id=COALESCE(?,root_task_id),
    status=?,status_text=?,updated_at=? WHERE id=? AND user_id=?`)
    .run(values.jobId || null, values.rootTaskId || null, status, statusText, now, runId, normalizeUserId(userId));
  if (status !== current.status || statusText !== current.statusText) appendMessage(runId, "status", statusText, {}, now);
  return getAgentRun(runId, userId);
}

export function completeAgentRunByJob(userId: string, jobId: string, result: unknown): AgentRun | null {
  const current = getAgentRunByJob(jobId, userId);
  return current ? completeAgentRun(userId, current.id, result) : null;
}

export function completeAgentRun(userId: string, runId: string, result: unknown): AgentRun | null {
  const current = getAgentRun(runId, userId);
  if (!current || current.status === "cancelled") return current;
  const now = new Date().toISOString();
  db.prepare(`UPDATE agent_runs SET status='completed',status_text='处理完成',result_json=?,error_kind=NULL,
    next_attempt_at=NULL,updated_at=?,completed_at=? WHERE id=? AND user_id=?`)
    .run(encField(JSON.stringify(result)), now, now, runId, normalizeUserId(userId));
  if (current.status !== "completed") appendMessage(runId, "result", "处理完成", { result }, now);
  return getAgentRun(runId, userId);
}

export function failAgentRunByJob(userId: string, jobId: string, errorKind: string): AgentRun | null {
  const current = getAgentRunByJob(jobId, userId);
  return current ? failAgentRun(userId, current.id, errorKind) : null;
}

export function deferAgentRunByJob(
  userId: string,
  jobId: string,
  errorKind: string,
  nextAttemptAt: string | null,
): AgentRun | null {
  const current = getAgentRunByJob(jobId, userId);
  if (!current || ["completed", "cancelled"].includes(current.status)) return current;
  const now = new Date().toISOString();
  const statusText = errorKind === "quota"
    ? "Codex额度暂不可用，任务已保存"
    : "Codex服务暂不可用，任务已保存";
  db.prepare(`UPDATE agent_runs SET status='deferred',status_text=?,error_kind=?,next_attempt_at=?,
    updated_at=? WHERE id=? AND user_id=?`)
    .run(statusText, errorKind.slice(0, 120), nextAttemptAt, now, current.id, normalizeUserId(userId));
  appendMessage(current.id, "status", statusText, { errorKind, nextAttemptAt }, now);
  return getAgentRun(current.id, userId);
}

export function failAgentRun(userId: string, runId: string, errorKind: string): AgentRun | null {
  const current = getAgentRun(runId, userId);
  if (!current || current.status === "cancelled") return current;
  const now = new Date().toISOString();
  db.prepare(`UPDATE agent_runs SET status='failed',status_text='处理失败',error_kind=?,updated_at=?
    WHERE id=? AND user_id=?`).run(errorKind.slice(0, 120), now, current.id, normalizeUserId(userId));
  if (current.status !== "failed") appendMessage(current.id, "error", "处理失败", { errorKind }, now);
  return getAgentRun(current.id, userId);
}
