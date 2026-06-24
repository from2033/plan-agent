import { DatabaseSync } from "node:sqlite";
import type { Entry, ParsedFields } from "./types.js";

const DB_PATH = process.env.DB_PATH || "./data.db";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    raw         TEXT NOT NULL,
    time        TEXT NOT NULL,
    time_start  TEXT,
    time_end    TEXT,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    amount      REAL,
    currency    TEXT,
    priority    TEXT,
    done        INTEGER,
    timestamp   TEXT NOT NULL,
    user_id     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(timestamp);
`);

// 迁移：老库没有 user_id 列时补上，并把历史数据归到主用户（你）。
const hasUserId = (db.prepare("PRAGMA table_info(entries)").all() as unknown as { name: string }[])
  .some((c) => c.name === "user_id");
if (!hasUserId) {
  db.exec("ALTER TABLE entries ADD COLUMN user_id TEXT");
}
const PRIMARY_USER = process.env.PRIMARY_USER || "我";
db.prepare("UPDATE entries SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(PRIMARY_USER);
db.exec("CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id)");

interface Row {
  id: string;
  type: string;
  raw: string;
  time: string;
  time_start: string | null;
  time_end: string | null;
  description: string;
  category: string;
  amount: number | null;
  currency: string | null;
  priority: string | null;
  done: number | null;
  timestamp: string;
}

function rowToEntry(r: Row): Entry {
  const entry: Entry = {
    id: r.id,
    type: r.type as Entry["type"],
    raw: r.raw,
    time: r.time,
    description: r.description,
    category: r.category,
    timestamp: r.timestamp,
  };
  if (r.time_start && r.time_end) entry.timeRange = { start: r.time_start, end: r.time_end };
  if (r.amount != null) entry.amount = r.amount;
  if (r.currency) entry.currency = r.currency;
  if (r.priority) entry.priority = r.priority as Entry["priority"];
  if (r.done != null) entry.done = r.done === 1;
  return entry;
}

// 所有读写都按 user_id 过滤，保证用户之间数据隔离。
const stmtAll = db.prepare("SELECT * FROM entries WHERE user_id = ? ORDER BY timestamp ASC");
const stmtInsert = db.prepare(`
  INSERT INTO entries
    (id, type, raw, time, time_start, time_end, description, category, amount, currency, priority, done, timestamp, user_id)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtSetDone = db.prepare("UPDATE entries SET done = ? WHERE id = ? AND user_id = ?");
const stmtDelete = db.prepare("DELETE FROM entries WHERE id = ? AND user_id = ?");
const stmtGet = db.prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?");
// 语音修正：更新一条记录的可解析字段（type/分类/时间段/金额/优先级等）。
const stmtUpdate = db.prepare(`
  UPDATE entries SET
    type = ?, time_start = ?, time_end = ?, description = ?,
    category = ?, amount = ?, currency = ?, priority = ?
  WHERE id = ? AND user_id = ?
`);

export function listEntries(userId: string): Entry[] {
  return (stmtAll.all(userId) as unknown as Row[]).map(rowToEntry);
}

export function insertEntry(entry: Entry, userId: string): Entry {
  stmtInsert.run(
    entry.id,
    entry.type,
    entry.raw,
    entry.time,
    entry.timeRange?.start ?? null,
    entry.timeRange?.end ?? null,
    entry.description,
    entry.category,
    entry.amount ?? null,
    entry.currency ?? null,
    entry.priority ?? null,
    entry.done == null ? null : entry.done ? 1 : 0,
    entry.timestamp,
    userId,
  );
  return entry;
}

export function setDone(id: string, done: boolean, userId: string): Entry | null {
  const res = stmtSetDone.run(done ? 1 : 0, id, userId);
  if (Number(res.changes) === 0) return null;
  const row = stmtGet.get(id, userId) as unknown as Row | undefined;
  return row ? rowToEntry(row) : null;
}

export function deleteEntry(id: string, userId: string): boolean {
  return Number(stmtDelete.run(id, userId).changes) > 0;
}

export function getEntry(id: string, userId: string): Entry | null {
  const row = stmtGet.get(id, userId) as unknown as Row | undefined;
  return row ? rowToEntry(row) : null;
}

// 用修正后的字段更新一条记录（保留 id/raw/time/timestamp/done 不变）。
export function updateEntry(id: string, userId: string, fields: ParsedFields): Entry | null {
  const res = stmtUpdate.run(
    fields.type,
    fields.timeRange?.start ?? null,
    fields.timeRange?.end ?? null,
    fields.description,
    fields.category,
    fields.amount ?? null,
    fields.currency ?? null,
    fields.priority ?? null,
    id,
    userId,
  );
  if (Number(res.changes) === 0) return null;
  const row = stmtGet.get(id, userId) as unknown as Row | undefined;
  return row ? rowToEntry(row) : null;
}
