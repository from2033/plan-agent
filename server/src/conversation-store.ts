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
  CREATE TABLE IF NOT EXISTS conversation_invitations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    responded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_invitations_recipient
    ON conversation_invitations(recipient_user_id, status, created_at);
  CREATE TABLE IF NOT EXISTS conversation_resources (
    conversation_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, resource_type, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_resources_conversation
    ON conversation_resources(conversation_id, resource_type, added_at);
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

export interface ConversationInvitation {
  id: string;
  conversationId: string;
  conversationTitle: string;
  invitedBy: string;
  createdAt: string;
}

export interface ConversationMember {
  userId: string;
  role: "owner" | "member";
  joinedAt: string;
}

export interface ConversationResourceGrant {
  conversationId: string;
  resourceType: "knowledge" | "document";
  resourceId: string;
  ownerUserId: string;
  addedBy: string;
  addedAt: string;
}

export interface ConversationContextMessage {
  role: "user" | "assistant";
  senderUserId: string | null;
  content: string;
  kind: ConversationMessage["kind"];
  metadata: Record<string, unknown>;
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

function conversationRole(conversationId: string, userId: string): "owner" | "member" | null {
  const row = db.prepare(`SELECT member_role FROM conversation_members
    WHERE conversation_id=? AND user_id=? LIMIT 1`)
    .get(conversationId, normalizeUserId(userId)) as { member_role: "owner" | "member" } | undefined;
  return row?.member_role || null;
}

export function createConversation(userId: string, title = "新对话"): string {
  const owner = normalizeUserId(userId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const safeTitle = title.trim().slice(0, 80) || "新对话";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO conversations
      (id,conversation_type,title,owner_user_id,family_space_id,created_at,updated_at)
      VALUES (?,'topic',?,?,NULL,?,?)`).run(id, safeTitle, owner, now, now);
    db.prepare(`INSERT INTO conversation_members
      (conversation_id,user_id,member_role,joined_at) VALUES (?,?,'owner',?)`)
      .run(id, owner, now);
    db.exec("COMMIT");
    return id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteConversation(conversationId: string, userId: string): boolean {
  const member = normalizeUserId(userId);
  const role = conversationRole(conversationId, member);
  if (!role) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (role === "owner") {
      db.prepare("DELETE FROM conversation_invitations WHERE conversation_id=?").run(conversationId);
      db.prepare("DELETE FROM conversation_resources WHERE conversation_id=?").run(conversationId);
      db.prepare("DELETE FROM conversation_messages WHERE conversation_id=?").run(conversationId);
      db.prepare("DELETE FROM conversation_members WHERE conversation_id=?").run(conversationId);
      db.prepare("DELETE FROM conversations WHERE id=?").run(conversationId);
    } else {
      db.prepare("DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?")
        .run(conversationId, member);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listConversationMembers(
  conversationId: string,
  userId: string,
): ConversationMember[] | null {
  if (!canViewConversation(conversationId, userId)) return null;
  const rows = db.prepare(`SELECT user_id,member_role,joined_at FROM conversation_members
    WHERE conversation_id=? ORDER BY CASE member_role WHEN 'owner' THEN 0 ELSE 1 END,joined_at`)
    .all(conversationId) as unknown as Array<{
      user_id: string; member_role: "owner" | "member"; joined_at: string;
    }>;
  return rows.map(row => ({ userId: row.user_id, role: row.member_role, joinedAt: row.joined_at }));
}

export function listConversationContacts(userId: string): string[] {
  const owner = normalizeUserId(userId);
  const contacts = new Set<string>();
  const members = db.prepare(`SELECT DISTINCT other.user_id
    FROM conversation_members mine
    JOIN conversation_members other ON other.conversation_id=mine.conversation_id
    WHERE mine.user_id=? AND other.user_id<>?`)
    .all(owner, owner) as unknown as Array<{ user_id: string }>;
  for (const member of members) contacts.add(member.user_id);
  const invitations = db.prepare(`SELECT invited_by,recipient_user_id FROM conversation_invitations
    WHERE invited_by=? OR recipient_user_id=?`)
    .all(owner, owner) as unknown as Array<{ invited_by: string; recipient_user_id: string }>;
  for (const invitation of invitations) {
    const contact = invitation.invited_by === owner
      ? invitation.recipient_user_id
      : invitation.invited_by;
    if (contact && contact !== owner) contacts.add(contact);
  }
  return [...contacts].sort((first, second) => first.localeCompare(second));
}

export function inviteConversationMember(
  conversationId: string,
  inviterUserId: string,
  recipientUserId: string,
): ConversationInvitation | null {
  const inviter = normalizeUserId(inviterUserId);
  const recipient = normalizeUserId(recipientUserId);
  if (conversationRole(conversationId, inviter) !== "owner" || !recipient || recipient === inviter) return null;
  const conversation = db.prepare(`SELECT title,conversation_type FROM conversations WHERE id=?`)
    .get(conversationId) as { title: string; conversation_type: ConversationType } | undefined;
  if (!conversation) return null;
  if (canViewConversation(conversationId, recipient)) return null;
  const existing = db.prepare(`SELECT id,created_at FROM conversation_invitations
    WHERE conversation_id=? AND recipient_user_id=? AND status='pending' LIMIT 1`)
    .get(conversationId, recipient) as { id: string; created_at: string } | undefined;
  const id = existing?.id || crypto.randomUUID();
  const now = existing?.created_at || new Date().toISOString();
  if (!existing) {
    db.prepare(`INSERT INTO conversation_invitations
      (id,conversation_id,recipient_user_id,invited_by,status,created_at)
      VALUES (?,?,?,?, 'pending',?)`).run(id, conversationId, recipient, inviter, now);
  }
  return { id, conversationId, conversationTitle: conversation.title, invitedBy: inviter, createdAt: now };
}

export function listConversationInvitations(userId: string): ConversationInvitation[] {
  const rows = db.prepare(`SELECT i.id,i.conversation_id,c.title,i.invited_by,i.created_at
    FROM conversation_invitations i JOIN conversations c ON c.id=i.conversation_id
    WHERE i.recipient_user_id=? AND i.status='pending' ORDER BY i.created_at DESC`)
    .all(normalizeUserId(userId)) as unknown as Array<{
      id: string; conversation_id: string; title: string; invited_by: string; created_at: string;
    }>;
  return rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    conversationTitle: row.title,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  }));
}

export function respondToConversationInvitation(
  invitationId: string,
  userId: string,
  accept: boolean,
): string | null {
  const recipient = normalizeUserId(userId);
  const invitation = db.prepare(`SELECT conversation_id FROM conversation_invitations
    WHERE id=? AND recipient_user_id=? AND status='pending'`)
    .get(invitationId, recipient) as { conversation_id: string } | undefined;
  if (!invitation) return null;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE conversation_invitations SET status=?,responded_at=? WHERE id=?`)
      .run(accept ? "accepted" : "declined", now, invitationId);
    if (accept) {
      db.prepare(`INSERT OR IGNORE INTO conversation_members
        (conversation_id,user_id,member_role,joined_at) VALUES (?,?,'member',?)`)
        .run(invitation.conversation_id, recipient, now);
      db.prepare(`UPDATE conversations SET conversation_type='family_group',updated_at=? WHERE id=?`)
        .run(now, invitation.conversation_id);
      db.prepare(`INSERT INTO conversation_messages
        (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
        VALUES (?,?,'system',NULL,'status',?,'complete',NULL,?,?,?)`)
        .run(crypto.randomUUID(), invitation.conversation_id, encField(`${recipient} 已加入对话`),
          encField("{}"), now, now);
    }
    db.exec("COMMIT");
    return invitation.conversation_id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function addConversationResource(
  conversationId: string,
  userId: string,
  resourceType: "knowledge" | "document",
  resourceId: string,
  ownerUserId: string,
  resourceTitle = "资料",
): boolean {
  const member = normalizeUserId(userId);
  if (!canViewConversation(conversationId, member)) return false;
  const result = db.prepare(`INSERT OR IGNORE INTO conversation_resources
    (conversation_id,resource_type,resource_id,owner_user_id,added_by,added_at)
    VALUES (?,?,?,?,?,?)`).run(conversationId, resourceType, resourceId,
      normalizeUserId(ownerUserId), member, new Date().toISOString());
  if (Number(result.changes) > 0) {
    const now = nextConversationTimestamp(conversationId);
    db.prepare(`INSERT INTO conversation_messages
      (id,conversation_id,sender_type,sender_user_id,message_kind,content,status,job_id,metadata_json,created_at,updated_at)
      VALUES (?,?,'user',?,'action',?,'complete',NULL,?,?,?)`)
      .run(crypto.randomUUID(), conversationId, member,
        encField(`分享了资料：${resourceTitle.trim().slice(0, 200) || "资料"}`),
        encField(JSON.stringify({ resourceType, resourceId })), now, now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
  }
  return true;
}

export function listConversationResources(
  conversationId: string,
  userId: string,
): ConversationResourceGrant[] | null {
  if (!canViewConversation(conversationId, userId)) return null;
  const rows = db.prepare(`SELECT * FROM conversation_resources
    WHERE conversation_id=? ORDER BY added_at DESC`).all(conversationId) as unknown as Array<{
      conversation_id: string; resource_type: "knowledge" | "document"; resource_id: string;
      owner_user_id: string; added_by: string; added_at: string;
    }>;
  return rows.map(row => ({
    conversationId: row.conversation_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ownerUserId: row.owner_user_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

export function sharedConversationResourcesForViewer(
  userId: string,
  resourceType: "knowledge" | "document",
): Array<{ resourceId: string; ownerUserId: string }> {
  const rows = db.prepare(`SELECT DISTINCT r.resource_id,r.owner_user_id
    FROM conversation_resources r JOIN conversation_members m ON m.conversation_id=r.conversation_id
    WHERE m.user_id=? AND r.resource_type=?`)
    .all(normalizeUserId(userId), resourceType) as unknown as Array<{
      resource_id: string; owner_user_id: string;
    }>;
  return rows.map(row => ({ resourceId: row.resource_id, ownerUserId: row.owner_user_id }));
}

export function conversationDocumentGrants(
  conversationId: string,
  userId: string,
): Array<{ resourceId: string; ownerUserId: string }> | null {
  const members = listConversationMembers(conversationId, userId);
  if (!members) return null;
  const conversation = db.prepare("SELECT conversation_type,owner_user_id FROM conversations WHERE id=?")
    .get(conversationId) as {
      conversation_type: ConversationType;
      owner_user_id: string | null;
    } | undefined;
  // The permanent “我与 AI” thread keeps account-wide private retrieval.
  // A private topic owned by its sole member is equally private, so it may search
  // the owner's complete vault. As soon as another member joins, retrieval is
  // narrowed to resources explicitly shared into the conversation.
  if (!conversation || conversation.conversation_type === "direct_ai") return null;
  if (conversation.conversation_type === "topic"
    && members.length === 1
    && conversation.owner_user_id === normalizeUserId(userId)
    && members[0]?.role === "owner") return null;
  return (listConversationResources(conversationId, userId) || [])
    .filter(resource => resource.resourceType === "document")
    .map(resource => ({ resourceId: resource.resourceId, ownerUserId: resource.ownerUserId }));
}

export function conversationContextForAi(
  conversationId: string,
  userId: string,
  limit = 16,
): ConversationContextMessage[] | null {
  if (!canViewConversation(conversationId, userId)) return null;
  const safeLimit = Math.max(1, Math.min(30, Math.floor(limit)));
  const rows = db.prepare(`SELECT * FROM conversation_messages
    WHERE conversation_id=? AND status='complete' AND sender_type IN ('user','assistant')
    ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(conversationId, safeLimit) as unknown as MessageRow[];
  return rows.reverse().map(messageFromRow).map(message => ({
    role: message.senderType as "user" | "assistant",
    senderUserId: message.senderUserId,
    content: message.content.slice(0, 4_000),
    kind: message.kind,
    metadata: message.metadata,
  }));
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
  requestedConversationId?: string,
): string {
  const owner = normalizeUserId(userId);
  const conversationId = requestedConversationId || ensureDirectAiConversation(owner);
  if (!canViewConversation(conversationId, owner)) throw new Error("conversation_forbidden");
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
      metadata: {
        resultKind: "ask",
        sources: summarizeSources(value.sources),
        retrievalStatus: String(value.retrievalStatus || "general_answer"),
      },
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
      excerpt: String(source.content || source.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 240),
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
  const userMessage = db.prepare(`SELECT id,conversation_id,content,created_at FROM conversation_messages
    WHERE job_id=? AND sender_type='user' AND sender_user_id=? LIMIT 1`)
    .get(jobId, owner) as { id: string; conversation_id: string; content: string; created_at: string } | undefined;
  if (!userMessage) return false;
  const response = assistantMessage(result, jobKind);
  if (!response) return false;
  const now = nextConversationTimestamp(userMessage.conversation_id, userMessage.created_at);
  const modelTitle = result && typeof result === "object"
    ? String((result as Record<string, unknown>).conversationTitle || "").trim().slice(0, 30)
    : "";
  const suggestedTitle = modelTitle || decField(userMessage.content)
    .replace(/[？?！!。,.，：:\n].*$/u, "").trim().slice(0, 18);
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
    if (suggestedTitle.length >= 2) {
      db.prepare(`UPDATE conversations SET title=?
        WHERE id=? AND (
          title IN ('新对话','新聊天') OR
          (SELECT COUNT(*) FROM conversation_messages
            WHERE conversation_id=? AND sender_type='assistant') <= 2
        )`)
        .run(suggestedTitle, userMessage.conversation_id, userMessage.conversation_id);
    }
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

export function listConversations(userId: string, query = ""): ConversationSummary[] {
  const owner = normalizeUserId(userId);
  ensureDirectAiConversation(owner);
  backfillRecentAiQuestions(owner);
  const rows = db.prepare(`SELECT c.id,c.conversation_type,c.title,c.updated_at,
      (SELECT COUNT(*) FROM conversation_members cm2 WHERE cm2.conversation_id=c.id) AS member_count
    FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=? ORDER BY c.updated_at DESC`)
    .all(owner) as unknown as ConversationRow[];
  const summaries = rows.map(row => {
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
  const needle = query.trim().toLocaleLowerCase().slice(0, 100);
  if (!needle) return summaries;
  return summaries.filter(summary => {
    if (`${summary.title} ${summary.lastMessage?.content || ""}`
      .toLocaleLowerCase().includes(needle)) return true;
    return (listConversationMessages(summary.id, owner, 200) || [])
      .some(message => message.content.toLocaleLowerCase().includes(needle));
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
      db.prepare("DELETE FROM conversation_invitations WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversation_resources WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversation_messages WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversation_members WHERE conversation_id=?").run(conversation.id);
      db.prepare("DELETE FROM conversations WHERE id=?").run(conversation.id);
    }
    db.prepare("DELETE FROM conversation_invitations WHERE recipient_user_id=? OR invited_by=?")
      .run(owner, owner);
    db.prepare("DELETE FROM conversation_resources WHERE owner_user_id=? OR added_by=?")
      .run(owner, owner);
    db.prepare("DELETE FROM conversation_members WHERE user_id=?").run(owner);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
