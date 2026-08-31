import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { encField, decField } from "./crypto-field.js";
import { insertEntry } from "./db.js";
import type { Entry } from "./types.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_document_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_actions_user ON assistant_actions(user_id,status,created_at);
`);

export type AssistantAction = { id: string; sourceDocumentId: string | null; kind: string; title: string; details: string; status: string; createdAt: string; updatedAt: string };
type ActionRow = { id: string; source_document_id: string | null; kind: string; title: string; details: string; payload_json: string; status: string; created_at: string; updated_at: string };
const toAction = (r: ActionRow): AssistantAction => ({ id: r.id, sourceDocumentId: r.source_document_id, kind: r.kind, title: decField(r.title), details: decField(r.details), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

export function listAssistantActions(userId: string): AssistantAction[] {
  return (db.prepare("SELECT * FROM assistant_actions WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(userId) as unknown as ActionRow[]).map(toAction);
}

export function proposeDocumentActions(userId: string, documentId: string, note: string, title: string): void {
  const text = `${note} ${title}`;
  if (!/(查|搜|找|上映|上线|提醒|待办|记录)/u.test(text)) return;
  const now = new Date().toISOString();
  const add = (kind: string, actionTitle: string, details: string, payload: unknown) => {
    const exists = db.prepare("SELECT id FROM assistant_actions WHERE user_id=? AND source_document_id=? AND kind=? AND status IN ('PENDING','CONFIRMED') LIMIT 1").get(userId, documentId, kind);
    if (exists) return;
    db.prepare("INSERT INTO assistant_actions (id,user_id,source_document_id,kind,title,details,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PENDING',?,?)").run(crypto.randomUUID(), userId, documentId, kind, encField(actionTitle), encField(details), encField(JSON.stringify(payload)), now, now);
  };
  if (/(上映|上线|什么时候|何时|查|搜|找)/u.test(note)) add("research", `查询「${title}」上映/上线时间`, "我会查找官方或影院信息，并把结果反馈给你。", { query: `${title} 上映时间 官方` });
  if (/(提醒|待办|代办)/u.test(note)) add("todo", `加入待办：关注「${title}」`, "确认后会加入待办，并在有明确日期时补充提醒。", { description: `关注「${title}」的上映/上线时间`, category: "电影", priority: "medium" });
}

export function confirmAssistantAction(userId: string, id: string): AssistantAction | null {
  const row = db.prepare("SELECT * FROM assistant_actions WHERE id=? AND user_id=? AND status='PENDING'").get(id, userId) as unknown as ActionRow | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  const payload = JSON.parse(decField(row.payload_json)) as { description?: string; category?: string; priority?: "low" | "medium" | "high" };
  if (row.kind === "todo") {
    const entry: Entry = { id: crypto.randomUUID(), type: "memo", raw: decField(row.details), time: now, description: payload.description || decField(row.title), category: payload.category || "待办", priority: payload.priority || "medium", done: false, timestamp: now };
    insertEntry(entry, userId);
  }
  db.prepare("UPDATE assistant_actions SET status='CONFIRMED',updated_at=? WHERE id=? AND user_id=?").run(now, id, userId);
  return toAction(db.prepare("SELECT * FROM assistant_actions WHERE id=?").get(id) as unknown as ActionRow);
}

export function dismissAssistantAction(userId: string, id: string): boolean {
  const result = db.prepare("UPDATE assistant_actions SET status='DISMISSED',updated_at=? WHERE id=? AND user_id=? AND status='PENDING'").run(new Date().toISOString(), id, userId);
  return Number(result.changes) > 0;
}
