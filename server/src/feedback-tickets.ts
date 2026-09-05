import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decField, decryptBuffer, encField, encryptBuffer } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const ATTACHMENT_DIR = process.env.FEEDBACK_ATTACHMENT_DIR
  || path.join(path.dirname(path.resolve(DB_PATH)), "feedback-attachments");
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    context_json TEXT,
    source_task_id TEXT,
    agent_task_id TEXT,
    job_id TEXT,
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    plan_json TEXT,
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    resolution_json TEXT,
    confirmation_question TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_tickets_user
    ON feedback_tickets(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_feedback_tickets_due
    ON feedback_tickets(status, next_attempt_at);
  CREATE TABLE IF NOT EXISTS feedback_attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_attachments_ticket
    ON feedback_attachments(ticket_id, created_at);
  CREATE TABLE IF NOT EXISTS feedback_ticket_events (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_ticket_events_ticket
    ON feedback_ticket_events(ticket_id, created_at);
`);
const ticketColumns = new Set((db.prepare("PRAGMA table_info(feedback_tickets)").all() as unknown as { name: string }[])
  .map(column => column.name));
if (!ticketColumns.has("context_json")) db.exec("ALTER TABLE feedback_tickets ADD COLUMN context_json TEXT");

export type FeedbackTicketStatus =
  | "draft"
  | "submitted"
  | "triaging"
  | "processing"
  | "awaiting_confirmation"
  | "deferred"
  | "verifying"
  | "resolved"
  | "closed"
  | "failed";

export interface FeedbackAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export interface FeedbackTicket {
  id: string;
  userId: string;
  title: string;
  description: string;
  context: Record<string, unknown>;
  sourceTaskId: string | null;
  agentTaskId: string | null;
  jobId: string | null;
  status: FeedbackTicketStatus;
  priority: "low" | "normal" | "high";
  plan: unknown | null;
  acceptanceChecks: string[];
  resolution: unknown | null;
  confirmationQuestion: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  attachments: FeedbackAttachment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

type TicketRow = {
  id: string; user_id: string; title: string; description: string;
  context_json: string | null;
  source_task_id: string | null; agent_task_id: string | null; job_id: string | null;
  status: FeedbackTicketStatus; priority: "low" | "normal" | "high";
  plan_json: string | null; acceptance_json: string; resolution_json: string | null;
  confirmation_question: string | null; attempts: number; next_attempt_at: string | null;
  created_at: string; updated_at: string; closed_at: string | null;
};

type AttachmentRow = {
  id: string; file_name: string; mime_type: string; byte_size: number; created_at: string;
};

function attachmentPath(id: string): string {
  return path.join(ATTACHMENT_DIR, `${id}.paf`);
}

function attachments(ticketId: string): FeedbackAttachment[] {
  return (db.prepare(`SELECT id,file_name,mime_type,byte_size,created_at
    FROM feedback_attachments WHERE ticket_id=? ORDER BY created_at`).all(ticketId) as unknown as AttachmentRow[])
    .map(row => ({
      id: row.id,
      fileName: decField(row.file_name),
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    }));
}

function decode(row: TicketRow): FeedbackTicket {
  return {
    id: row.id,
    userId: row.user_id,
    title: decField(row.title),
    description: decField(row.description),
    context: row.context_json ? JSON.parse(decField(row.context_json)) : {},
    sourceTaskId: row.source_task_id,
    agentTaskId: row.agent_task_id,
    jobId: row.job_id,
    status: row.status,
    priority: row.priority,
    plan: row.plan_json ? JSON.parse(decField(row.plan_json)) : null,
    acceptanceChecks: JSON.parse(decField(row.acceptance_json)),
    resolution: row.resolution_json ? JSON.parse(decField(row.resolution_json)) : null,
    confirmationQuestion: row.confirmation_question ? decField(row.confirmation_question) : null,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    attachments: attachments(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function rawTicket(id: string): TicketRow | null {
  return db.prepare("SELECT * FROM feedback_tickets WHERE id=?").get(id) as unknown as TicketRow | undefined || null;
}

function visible(row: TicketRow | null, userId: string, primaryUser: string): boolean {
  return Boolean(row && (row.user_id === userId || userId === primaryUser));
}

function addEvent(
  ticket: TicketRow,
  eventType: string,
  fromStatus: FeedbackTicketStatus | null,
  toStatus: FeedbackTicketStatus,
  message: string,
  payload?: unknown,
): void {
  db.prepare(`INSERT INTO feedback_ticket_events
    (id,ticket_id,user_id,event_type,from_status,to_status,message,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), ticket.id, ticket.user_id, eventType, fromStatus, toStatus,
      encField(message.slice(0, 2_000)), payload == null ? null : encField(JSON.stringify(payload)),
      new Date().toISOString(),
    );
}

export function createFeedbackTicket(
  userId: string,
  value: {
    title?: string;
    description?: string;
    transcript?: string;
    context?: Record<string, unknown>;
    sourceTaskId?: string;
    priority?: "low" | "normal" | "high";
  },
): FeedbackTicket {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const description = (value.transcript || value.description || "").trim().slice(0, 10_000);
  const title = value.title?.trim().slice(0, 160)
    || (description ? description.replace(/[。！？!?\n].*$/u, "").slice(0, 40) : `图片反馈 ${now.slice(0, 10)}`);
  db.prepare(`INSERT INTO feedback_tickets
    (id,user_id,title,description,context_json,source_task_id,status,priority,acceptance_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`).run(
      id, userId, encField(title), encField(description), encField(JSON.stringify(value.context || {})),
      value.sourceTaskId || null, value.priority || "normal", encField("[]"), now, now,
    );
  const row = rawTicket(id)!;
  addEvent(row, "created", null, "draft", "反馈工单已创建");
  return decode(rawTicket(id)!);
}

export function addFeedbackAttachment(
  userId: string,
  ticketId: string,
  fileName: string,
  mimeType: string,
  content: Buffer,
): FeedbackAttachment | null {
  const ticket = rawTicket(ticketId);
  if (!ticket || ticket.user_id !== userId || ticket.status !== "draft") return null;
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM feedback_attachments WHERE ticket_id=?")
    .get(ticketId) as { count: number }).count);
  if (count >= 9) throw new Error("feedback_attachment_limit");
  const id = crypto.randomUUID();
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 });
  const finalPath = attachmentPath(id);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, encryptBuffer(content), { mode: 0o600 });
  fs.renameSync(temporaryPath, finalPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO feedback_attachments
    (id,ticket_id,user_id,file_name,mime_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, ticketId, userId, encField(fileName.slice(0, 240)), mimeType, content.length, now);
  addEvent(ticket, "attachment_added", ticket.status, ticket.status, `已添加图片：${fileName}`, { attachmentId: id });
  return attachments(ticketId).find(item => item.id === id) || null;
}

export function readFeedbackAttachment(
  attachmentId: string,
  viewerId: string,
  primaryUser: string,
): { attachment: FeedbackAttachment; content: Buffer } | null {
  const row = db.prepare(`SELECT a.id,a.ticket_id,a.user_id,a.file_name,a.mime_type,a.byte_size,a.created_at
    FROM feedback_attachments a WHERE a.id=?`).get(attachmentId) as unknown as AttachmentRow & { ticket_id: string; user_id: string } | undefined;
  const ticket = row ? rawTicket(row.ticket_id) : null;
  if (!row || !visible(ticket, viewerId, primaryUser) || !fs.existsSync(attachmentPath(row.id))) return null;
  return {
    attachment: {
      id: row.id,
      fileName: decField(row.file_name),
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    },
    content: decryptBuffer(fs.readFileSync(attachmentPath(row.id))),
  };
}

const allowed: Record<FeedbackTicketStatus, FeedbackTicketStatus[]> = {
  draft: ["submitted", "resolved", "closed"],
  submitted: ["triaging", "processing", "deferred", "failed", "closed"],
  triaging: ["processing", "awaiting_confirmation", "deferred", "failed", "closed"],
  processing: ["awaiting_confirmation", "deferred", "verifying", "failed", "closed"],
  awaiting_confirmation: ["processing", "deferred", "closed"],
  deferred: ["triaging", "processing", "closed"],
  verifying: ["resolved", "awaiting_confirmation", "deferred", "failed", "closed"],
  resolved: ["closed", "processing"],
  closed: [],
  failed: ["triaging", "processing", "deferred", "closed"],
};

export function transitionFeedbackTicket(
  id: string,
  toStatus: FeedbackTicketStatus,
  eventType: string,
  message: string,
  changes: {
    agentTaskId?: string | null; jobId?: string | null; plan?: unknown;
    acceptanceChecks?: string[]; resolution?: unknown; confirmationQuestion?: string | null;
    nextAttemptAt?: string | null; incrementAttempts?: boolean;
  } = {},
): FeedbackTicket | null {
  const ticket = rawTicket(id);
  if (!ticket) return null;
  if (ticket.status !== toStatus && !allowed[ticket.status].includes(toStatus)) {
    throw new Error(`feedback_invalid_transition:${ticket.status}->${toStatus}`);
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE feedback_tickets SET status=?,agent_task_id=?,job_id=?,plan_json=?,acceptance_json=?,
    resolution_json=?,confirmation_question=?,next_attempt_at=?,attempts=attempts+?,updated_at=?,closed_at=? WHERE id=?`)
    .run(
      toStatus,
      changes.agentTaskId === undefined ? ticket.agent_task_id : changes.agentTaskId,
      changes.jobId === undefined ? ticket.job_id : changes.jobId,
      changes.plan === undefined ? ticket.plan_json : encField(JSON.stringify(changes.plan)),
      changes.acceptanceChecks === undefined ? ticket.acceptance_json : encField(JSON.stringify(changes.acceptanceChecks)),
      changes.resolution === undefined ? ticket.resolution_json : encField(JSON.stringify(changes.resolution)),
      changes.confirmationQuestion === undefined
        ? ticket.confirmation_question
        : changes.confirmationQuestion ? encField(changes.confirmationQuestion) : null,
      changes.nextAttemptAt === undefined ? ticket.next_attempt_at : changes.nextAttemptAt,
      changes.incrementAttempts ? 1 : 0,
      now,
      toStatus === "closed" ? now : ticket.closed_at,
      id,
    );
  addEvent(ticket, eventType, ticket.status, toStatus, message, changes);
  return decode(rawTicket(id)!);
}

export function updateFeedbackAnalysis(
  id: string,
  analysis: {
    ticketTitle: string;
    issueSummary: string;
    reproductionClues: string[];
    proposedPlan: string[];
    acceptanceChecks: string[];
  },
): FeedbackTicket | null {
  const ticket = rawTicket(id);
  if (!ticket) return null;
  const now = new Date().toISOString();
  const plan = {
    diagnosis: analysis.issueSummary,
    reproductionClues: analysis.reproductionClues,
    proposedPlan: analysis.proposedPlan,
  };
  db.prepare(`UPDATE feedback_tickets SET title=?,description=?,plan_json=?,acceptance_json=?,updated_at=? WHERE id=?`)
    .run(
      encField(analysis.ticketTitle.trim().slice(0, 160)),
      encField(analysis.issueSummary.trim().slice(0, 2_000)),
      encField(JSON.stringify(plan)),
      encField(JSON.stringify(analysis.acceptanceChecks.slice(0, 20))),
      now,
      id,
    );
  addEvent(ticket, "analysis_ready", ticket.status, ticket.status, "Agent 已自动生成标题、问题摘要、复现线索和验收标准", plan);
  return decode(rawTicket(id)!);
}

export function getFeedbackTicket(id: string, userId: string, primaryUser: string): FeedbackTicket | null {
  const row = rawTicket(id);
  return visible(row, userId, primaryUser) ? decode(row!) : null;
}

export function listFeedbackTickets(userId: string, primaryUser: string): FeedbackTicket[] {
  const rows = (userId === primaryUser
    ? db.prepare("SELECT * FROM feedback_tickets ORDER BY updated_at DESC LIMIT 200").all()
    : db.prepare("SELECT * FROM feedback_tickets WHERE user_id=? ORDER BY updated_at DESC LIMIT 200").all(userId)) as unknown as TicketRow[];
  return rows.map(decode);
}

export function listFeedbackTicketEvents(id: string, userId: string, primaryUser: string): unknown[] {
  const ticket = rawTicket(id);
  if (!visible(ticket, userId, primaryUser)) return [];
  const rows = db.prepare(`SELECT id,event_type,from_status,to_status,message,payload_json,created_at
    FROM feedback_ticket_events WHERE ticket_id=? ORDER BY created_at`).all(id) as unknown as Array<{
      id: string; event_type: string; from_status: string | null; to_status: string;
      message: string; payload_json: string | null; created_at: string;
    }>;
  return rows.map(row => ({
    id: row.id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    message: decField(row.message),
    payload: row.payload_json ? JSON.parse(decField(row.payload_json)) : null,
    createdAt: row.created_at,
  }));
}

export function dueFeedbackTickets(now = new Date()): FeedbackTicket[] {
  return (db.prepare(`SELECT * FROM feedback_tickets
    WHERE status='deferred' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?
    ORDER BY next_attempt_at LIMIT 50`).all(now.toISOString()) as unknown as TicketRow[]).map(decode);
}

export function auditStaleFeedbackTickets(now = new Date(), staleMinutes = 15): FeedbackTicket[] {
  const cutoff = new Date(now.getTime() - Math.max(5, staleMinutes) * 60_000).toISOString();
  const stale = db.prepare(`SELECT * FROM feedback_tickets
    WHERE status IN ('triaging','processing','verifying') AND updated_at<=?
    ORDER BY updated_at LIMIT 50`).all(cutoff) as unknown as TicketRow[];
  return stale.map(row => transitionFeedbackTicket(
    row.id,
    "deferred",
    "stale_watchdog",
    "处理心跳已超时，工单已保留并安排自动续办",
    { nextAttemptAt: now.toISOString(), jobId: null },
  )!);
}

export function deleteFeedbackAccountData(userId: string): void {
  const ids = (db.prepare("SELECT id FROM feedback_attachments WHERE user_id=?").all(userId) as unknown as Array<{ id: string }>);
  for (const item of ids) fs.rmSync(attachmentPath(item.id), { force: true });
  db.prepare("DELETE FROM feedback_ticket_events WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM feedback_attachments WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM feedback_tickets WHERE user_id=?").run(userId);
}
