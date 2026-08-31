import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { encField, decField } from "./crypto-field.js";
import { insertEntry } from "./db.js";
import type { Entry } from "./types.js";
import { createPersistentAgentTask, transitionPersistentAgentTask, verifyPersistentAgentTask } from "./agent-runtime.js";

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
    agent_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_actions_user ON assistant_actions(user_id,status,created_at);
`);
const hasAgentTaskId = (db.prepare("PRAGMA table_info(assistant_actions)").all() as unknown as { name: string }[]).some((column) => column.name === "agent_task_id");
if (!hasAgentTaskId) db.exec("ALTER TABLE assistant_actions ADD COLUMN agent_task_id TEXT");

export type AssistantAction = { id: string; sourceDocumentId: string | null; agentTaskId: string | null; kind: string; title: string; details: string; status: string; createdAt: string; updatedAt: string };
type ActionRow = { id: string; source_document_id: string | null; agent_task_id: string | null; kind: string; title: string; details: string; payload_json: string; status: string; created_at: string; updated_at: string };
const toAction = (r: ActionRow): AssistantAction => ({ id: r.id, sourceDocumentId: r.source_document_id, agentTaskId: r.agent_task_id, kind: r.kind, title: decField(r.title), details: decField(r.details), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

export function listAssistantActions(userId: string): AssistantAction[] {
  return (db.prepare("SELECT * FROM assistant_actions WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(userId) as unknown as ActionRow[]).map(toAction);
}

type SuggestedAction = {
  kind?: unknown;
  title?: unknown;
  reason?: unknown;
  dueAt?: unknown;
  confidence?: unknown;
};

export function proposeDocumentActions(
  userId: string,
  documentId: string,
  note: string,
  title: string,
  suggestedActions?: unknown,
  rootTaskId?: string,
): void {
  const text = `${note} ${title}`;
  const suggested = Array.isArray(suggestedActions) ? suggestedActions as SuggestedAction[] : [];
  if (!suggested.length && !/(查|搜|找|上映|上线|提醒|待办|记录)/u.test(text)) return;
  const now = new Date().toISOString();
  const add = (kind: string, actionTitle: string, details: string, payload: unknown) => {
    const exists = db.prepare("SELECT id FROM assistant_actions WHERE user_id=? AND source_document_id=? AND kind=? AND status IN ('PENDING','CONFIRMED') LIMIT 1").get(userId, documentId, kind);
    if (exists) return;
    const capability = kind === "todo" ? "todo" : kind === "reminder" ? "reminder" : kind === "research" ? "research" : "document_action";
    const agentTask = createPersistentAgentTask(
      userId,
      capability,
      { title: actionTitle, details, payload, confirmationReason: "该动作会修改待办、提醒或启动新的处理" },
      "document",
      documentId,
      rootTaskId ? { rootTaskId } : undefined,
    );
    db.prepare("INSERT INTO assistant_actions (id,user_id,source_document_id,kind,title,details,payload_json,agent_task_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)").run(crypto.randomUUID(), userId, documentId, kind, encField(actionTitle), encField(details), encField(JSON.stringify(payload)), agentTask.id, now, now);
  };
  if (/(上映|上线|什么时候|何时|查|搜|找)/u.test(note)) add("research", `查询「${title}」上映/上线时间`, "我会查找官方或影院信息，并把结果反馈给你。", { query: `${title} 上映时间 官方` });
  if (/(提醒|待办|代办)/u.test(note)) add("todo", `加入待办：关注「${title}」`, "确认后会加入待办，并在有明确日期时补充提醒。", { description: `关注「${title}」的上映/上线时间`, category: "电影", priority: "medium" });
  for (const item of suggested.slice(0, 5)) {
    const kind = item.kind === "reminder" ? "reminder" : item.kind === "todo" ? "todo" : null;
    const actionTitle = String(item.title || "").trim().slice(0, 200);
    const reason = String(item.reason || "").trim().slice(0, 500);
    const confidence = Number(item.confidence || 0);
    if (!kind || !actionTitle || confidence < 0.7) continue;
    add(kind, actionTitle, reason || "Agent 从资料中识别出一项可能需要处理的后续动作。", {
      description: actionTitle,
      category: "资料后续",
      priority: "medium",
      ...(typeof item.dueAt === "string" && item.dueAt ? { reminderAt: item.dueAt } : {}),
    });
  }
}

export function confirmAssistantAction(userId: string, id: string): AssistantAction | null {
  const row = db.prepare("SELECT * FROM assistant_actions WHERE id=? AND user_id=? AND status='PENDING'").get(id, userId) as unknown as ActionRow | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  if (row.agent_task_id) transitionPersistentAgentTask(userId, row.agent_task_id, "executing", "action_confirmed");
  const payload = JSON.parse(decField(row.payload_json)) as { description?: string; category?: string; priority?: "low" | "medium" | "high"; reminderAt?: string };
  if (row.kind === "todo" || row.kind === "reminder") {
    const reminderAt = payload.reminderAt && !Number.isNaN(new Date(payload.reminderAt).getTime())
      ? payload.reminderAt
      : undefined;
    const entry: Entry = { id: crypto.randomUUID(), type: "memo", raw: decField(row.details), time: reminderAt || now, description: payload.description || decField(row.title), category: payload.category || "待办", priority: payload.priority || "medium", done: false, timestamp: reminderAt || now, ...(reminderAt ? { reminderAt } : {}) };
    insertEntry(entry, userId);
    if (row.agent_task_id) {
      transitionPersistentAgentTask(userId, row.agent_task_id, "verifying", "todo_created", entry);
      verifyPersistentAgentTask(userId, row.agent_task_id, entry);
    }
  }
  db.prepare("UPDATE assistant_actions SET status='CONFIRMED',updated_at=? WHERE id=? AND user_id=?").run(now, id, userId);
  return toAction(db.prepare("SELECT * FROM assistant_actions WHERE id=?").get(id) as unknown as ActionRow);
}

export function dismissAssistantAction(userId: string, id: string): boolean {
  const result = db.prepare("UPDATE assistant_actions SET status='DISMISSED',updated_at=? WHERE id=? AND user_id=? AND status='PENDING'").run(new Date().toISOString(), id, userId);
  return Number(result.changes) > 0;
}

export function confirmAssistantActionByAgentTaskId(userId: string, taskId: string): AssistantAction | null {
  const row = db.prepare("SELECT id FROM assistant_actions WHERE user_id=? AND agent_task_id=? AND status='PENDING'").get(userId, taskId) as { id?: string } | undefined;
  return row?.id ? confirmAssistantAction(userId, row.id) : null;
}
