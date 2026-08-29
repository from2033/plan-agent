import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    conversation_type TEXT NOT NULL,
    title TEXT NOT NULL,
    owner_user_id TEXT,
    family_space_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_direct_ai_owner
    ON conversations(conversation_type, owner_user_id)
    WHERE conversation_type='direct_ai';
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    member_role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_members_user
    ON conversation_members(user_id, conversation_id);
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_user_id TEXT,
    message_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    job_id TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_job_sender
    ON conversation_messages(job_id, sender_type)
    WHERE job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_conversation_messages_feed
    ON conversation_messages(conversation_id, created_at, id);
`);

export type ConversationType = "direct_ai" | "family_group" | "topic";
export type ConversationSenderType = "user" | "assistant" | "system";
export type ConversationMessageStatus = "pending" | "complete" | "failed";

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  title: string;
  memberCount: number;
  updatedAt: string;
  lastMessage: null | {
    senderType: ConversationSenderType;
    content: string;
    status: ConversationMessageStatus;
    createdAt: string;
  };
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderType: ConversationSenderType;
  senderUserId: string | null;
  kind: "text" | "answer" | "action" | "status";
  content: string;
  status: ConversationMessageStatus;
  jobId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  id: string;
  conversation_type: ConversationType;
  title: string;
  updated_at: string;
  member_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: ConversationSenderType;
  sender_user_id: string | null;
  message_kind: ConversationMessage["kind"];
  content: string;
  status: ConversationMessageStatus;
  job_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeUserId(value: string): string {
  const clean = value.trim();
  return clean.includes("@") ? clean.toLowerCase() : clean;
}

function messageFromRow(row: MessageRow): ConversationMessage {
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(decField(row.metadata_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    kind: row.message_kind,
    content: decField(row.content),
    status: row.status,
    jobId: row.job_id,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureDirectAiConversation(userId: string): string {
  const owner = normalizeUserId(userId);
  const existing = db.prepare(`SELECT id FROM conversations
    WHERE conversation_type='direct_ai' AND owner_user_id=? LIMIT 1`)
    .get(owner) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO conversations
      (id,conversation_type,title,owner_user_id,family_space_id,created_at,updated_at)
      VALUES (?, 'direct_ai', '我与 AI', ?, NULL, ?, ?)`)
      .run(id, owner, now, now);
    const conversation = db.prepare(`SELECT id FROM conversations
      WHERE conversation_type='direct_ai' AND owner_user_id=? LIMIT 1`)
      .get(owner) as { id: string };
    db.prepare(`INSERT OR IGNORE INTO conversation_members
      (conversation_id,user_id,member_role,joined_at) VALUES (?,?,'owner',?)`)
      .run(conversation.id, owner, now);
    db.exec("COMMIT");
    return conversation.id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function canViewConversation(conversationId: string, userId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM conversation_members
    WHERE conversation_id=? AND user_id=? LIMIT 1`)
    .get(conversationId, normalizeUserId(userId)));
}

function nextConversationTimestamp(conversationId: string, after = ""): string {
  const row = db.prepare("SELECT updated_at FROM conversations WHERE id=?")
    .get(conversationId) as { updated_at: string } | undefined;
  return new Date(Math.max(
    Date.now(),
    Date.parse(row?.updated_at || "") + 1 || 0,
    Date.parse(after) + 1 || 0,
  )).toISOString();
}

export function beginAiInteraction(
  userId: string,
  jobId: string,
  content: string,
  inputMode: "voice" | "text" = "voice",
): string {
  const owner = normalizeUserId(userId);
  const conversationId = ensureDirectAiConversation(owner);
  const now = nextConversationTimestamp(conversationId);
  const id = `user-${jobId}`;
  db.prepare(`INSERT OR IGNORE INTO conversation_messages
    (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
    VALUES (?,?,'user',?,'text',?,'pending',?,?,?,?)`)
    .run(id, conversationId, owner, encField(content), jobId,
      encField(JSON.stringify({ inputMode })), now, now);
  db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
  return conversationId;
}

function assistantMessage(result: unknown, jobKind: string): {
  content: string;
  kind: ConversationMessage["kind"];
  metadata: Record<string, unknown>;
} | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (jobKind === "document_question") {
    return {
      content: String(value.answer || "现有资料中没有找到足够信息。"),
      kind: "answer",
      metadata: { sources: summarizeSources(value.sources) },
    };
  }
  if (jobKind === "research") {
    return {
      content: `研究报告已完成：${String(value.title || "研究报告")}`,
      kind: "action",
      metadata: { resultKind: "research" },
    };
  }
  if (jobKind !== "ingest") return null;
  if (value.kind === "ask") {
    return {
      content: String(value.answer || "现有资料中没有找到足够信息。"),
      kind: "answer",
      metadata: { resultKind: "ask", sources: summarizeSources(value.sources) },
    };
  }
  if (value.kind === "save") {
    const item = value.item as Record<string, unknown> | undefined;
    return {
      content: `已存入资料库：${String(item?.title || "新资料")}`,
      kind: "action",
      metadata: { resultKind: "save", itemId: String(item?.id || "") },
    };
  }
  if (value.kind === "record") {
    const entries = Array.isArray(value.entries) ? value.entries as Array<Record<string, unknown>> : [];
    const descriptions = entries.map(entry => String(entry.description || "")).filter(Boolean);
    return {
      content: descriptions.length ? `已记录：${descriptions.join("；")}` : "已记录。",
      kind: "action",
      metadata: {
        resultKind: "record",
        entryIds: entries.map(entry => String(entry.id || "")).filter(Boolean),
      },
    };
  }
  return null;
}

function summarizeSources(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    return [{
      id: String(source.id || source.documentId || ""),
      title: String(source.title || "资料").slice(0, 200),
      category: String(source.category || "").slice(0, 60),
      sourceType: String(source.sourceType || "document").slice(0, 30),
    }];
  });
}

export function completeAiInteraction(
  userId: string,
  jobId: string,
  jobKind: string,
  result: unknown,
): boolean {
  const owner = normalizeUserId(userId);
  const userMessage = db.prepare(`SELECT id,conversation_id,created_at FROM conversation_messages
    WHERE job_id=? AND sender_type='user' AND sender_user_id=? LIMIT 1`)
    .get(jobId, owner) as { id: string; conversation_id: string; created_at: string } | undefined;
  if (!userMessage) return false;
  const response = assistantMessage(result, jobKind);
  if (!response) return false;
  const now = nextConversationTimestamp(userMessage.conversation_id, userMessage.created_at);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE conversation_messages SET status='complete',updated_at=? WHERE id=?`)
      .run(now, userMessage.id);
    db.prepare(`INSERT OR IGNORE INTO conversation_messages
      (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
      VALUES (?,?,'assistant',NULL,?,?,'complete',?,?,?,?)`)
      .run(`assistant-${jobId}`, userMessage.conversation_id, response.kind,
        encField(response.content), jobId, encField(JSON.stringify(response.metadata)), now, now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?")
      .run(now, userMessage.conversation_id);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function failAiInteraction(userId: string, jobId: string): boolean {
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE conversation_messages SET status='failed',updated_at=?
    WHERE job_id=? AND sender_type='user' AND sender_user_id=?`)
    .run(now, jobId, normalizeUserId(userId));
  return Number(result.changes) > 0;
}

function backfillRecentAiQuestions(userId: string): void {
  const owner = normalizeUserId(userId);
  const conversationId = ensureDirectAiConversation(owner);
  let rows: Array<{
    id: string; input_json: string; result_json: string; created_at: string; updated_at: string;
  }> = [];
  try {
    rows = db.prepare(`SELECT id,input_json,result_json,created_at,updated_at FROM ai_jobs
      WHERE user_id=? AND kind='ingest' AND status='COMPLETE' AND result_json IS NOT NULL
      ORDER BY created_at DESC LIMIT 100`).all(owner) as unknown as typeof rows;
  } catch {
    return;
  }
  let latest = "";
  for (const row of rows.reverse()) {
    try {
      const input = JSON.parse(decField(row.input_json)) as { raw?: unknown };
      const result = JSON.parse(decField(row.result_json)) as Record<string, unknown>;
      if (result.kind !== "ask" || typeof input.raw !== "string") continue;
      const response = assistantMessage(result, "ingest");
      if (!response) continue;
      db.prepare(`INSERT OR IGNORE INTO conversation_messages
        (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
        VALUES (?,?,'user',?,'text',?,'complete',?,?,?,?)`)
        .run(`user-${row.id}`, conversationId, owner, encField(input.raw), row.id,
          encField(JSON.stringify({ inputMode: "voice", backfilled: true })), row.created_at, row.updated_at);
      const answerAt = new Date(Math.max(Date.parse(row.updated_at), Date.parse(row.created_at) + 1)).toISOString();
      db.prepare(`INSERT OR IGNORE INTO conversation_messages
        (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
        VALUES (?,?,'assistant',NULL,?,?,'complete',?,?,?,?)`)
        .run(`assistant-${row.id}`, conversationId, response.kind, encField(response.content), row.id,
          encField(JSON.stringify(response.metadata)), answerAt, answerAt);
      if (answerAt > latest) latest = answerAt;
    } catch {
      // Ignore malformed legacy jobs; new interactions are written directly.
    }
  }
  if (latest) {
    db.prepare(`UPDATE conversations SET updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END
      WHERE id=?`).run(latest, latest, conversationId);
  }
}

export function listConversations(userId: string): ConversationSummary[] {
  const owner = normalizeUserId(userId);
  ensureDirectAiConversation(owner);
  backfillRecentAiQuestions(owner);
  const rows = db.prepare(`SELECT c.id,c.conversation_type,c.title,c.updated_at,
      (SELECT COUNT(*) FROM conversation_members cm2 WHERE cm2.conversation_id=c.id) AS member_count
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=? ORDER BY c.updated_at DESC`)
    .all(owner) as unknown as ConversationRow[];
  return rows.map(row => {
    const last = db.prepare(`SELECT * FROM conversation_messages
      WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(row.id) as unknown as MessageRow | undefined;
    const message = last ? messageFromRow(last) : null;
    return {
      id: row.id,
      type: row.conversation_type,
      title: row.title,
      memberCount: Number(row.member_count),
      updatedAt: row.updated_at,
      lastMessage: message ? {
        senderType: message.senderType,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
      } : null,
    };
  });
}

export function listConversationMessages(
  conversationId: string,
  userId: string,
  limit = 100,
): ConversationMessage[] | null {
  if (!canViewConversation(conversationId, userId)) return null;
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db.prepare(`SELECT * FROM conversation_messages
    WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(conversationId, safeLimit) as unknown as MessageRow[];
  return rows.reverse().map(messageFromRow);
}

export function deleteConversationAccountData(userId: string): void {
  const owner = normalizeUserId(userId);
  const owned = db.prepare("SELECT id FROM conversations WHERE owner_user_id=?")
    .all(owner) as unknown as Array<{ id: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const conversation of owned) {
      db.prepare("DELETE FROM conversation_messages WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversation_members WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversations WHERE id=?").run(conversation.id);
    }
    db.prepare("DELETE FROM conversation_members WHERE user_id=?").run(owner);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
