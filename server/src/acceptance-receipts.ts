import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA busy_timeout = 5000");

function one(sql: string, ...params: Array<string | number | null>): Record<string, unknown> | null {
  try { return db.prepare(sql).get(...params) as Record<string, unknown> | undefined || null; } catch { return null; }
}

/**
 * Receipts are built by the server from persisted state, never accepted from a model result.
 * Existing _verifiedReceipts fields are deliberately overwritten.
 */
export function withVerifiedSideEffectReceipts(
  userId: string,
  capability: string,
  input: unknown,
  result: unknown,
  sourceId?: string | null,
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const value = result as Record<string, unknown>;
  const receipts: Record<string, unknown> = {};
  if (["todo", "reminder"].includes(capability) && typeof value.id === "string") {
    const row = one("SELECT id,type,done,reminder_at FROM entries WHERE id=? AND user_id=?", value.id, userId);
    if (row) receipts.entry = { id: row.id, type: row.type, done: row.done, reminderAt: row.reminder_at, persisted: true };
  }
  if (["document_ingest", "research"].includes(capability) && typeof value.documentId === "string") {
    const row = one("SELECT id,status,storage_kind FROM documents WHERE id=? AND user_id=?", value.documentId, userId);
    if (row) receipts.document = { id: row.id, status: row.status, storageKind: row.storage_kind, persisted: true };
  }
  if (capability === "feedback_ticket") {
    const ticketId = String((input as { ticketId?: unknown })?.ticketId || "");
    const row = ticketId ? one("SELECT id,status FROM feedback_tickets WHERE id=? AND user_id=?", ticketId, userId) : null;
    if (row) receipts.feedbackTicket = { id: row.id, status: row.status, persisted: true };
  }
  if (["document_action", "desktop_action"].includes(capability) && typeof value.actionId === "string") {
    const row = one("SELECT id,status FROM assistant_actions WHERE id=? AND user_id=?", value.actionId, userId);
    if (row) receipts.action = { id: row.id, status: row.status, persisted: true };
  }
  if (capability === "desktop_intake" && sourceId) {
    const row = one("SELECT id,stage FROM desktop_submissions WHERE id=? AND user_id=?", sourceId, userId);
    if (row) receipts.desktopSubmission = { id: row.id, status: row.stage, persisted: true };
  }
  if (capability === "input_processing" && value.kind === "record") {
    const ids = Array.isArray(value.entries) ? value.entries.map(item => String((item as { id?: unknown })?.id || "")).filter(Boolean) : [];
    if (ids.length) {
      const persisted = ids.filter(id => one("SELECT id FROM entries WHERE id=? AND user_id=?", id, userId)).length;
      receipts.entries = { expected: ids.length, persisted, complete: persisted === ids.length };
    }
  }
  if (capability === "input_processing" && value.kind === "save") {
    const id = String((value.item as { id?: unknown } | undefined)?.id || "");
    if (id && one("SELECT id FROM knowledge WHERE id=? AND user_id=?", id, userId)) receipts.knowledge = { id, persisted: true };
  }
  return { ...value, _verifiedReceipts: receipts };
}
