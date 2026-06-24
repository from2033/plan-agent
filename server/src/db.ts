import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { Entry, ParsedFields, KnowledgeItem } from "./types.js";
import { encField, encOpt, decField, decOpt } from "./crypto-field.js";

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

// 知识库表（title/content 加密存储）。
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    user_id   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user_id);
`);

interface Row {
  id: string;
  type: string;
  raw: string;
  time: string;
  time_start: string | null;
  time_end: string | null;
  description: string;
  category: string;
  amount: string | number | null; // 加密后存的是字符串密文
  currency: string | null;
  priority: string | null;
  done: number | null;
  timestamp: string;
}

function rowToEntry(r: Row): Entry {
  // 敏感字段读取时解密：raw / description / category / 金额 / 时间段。
  const entry: Entry = {
    id: r.id,
    type: r.type as Entry["type"],
    raw: decField(r.raw),
    time: r.time,
    description: decField(r.description),
    category: decField(r.category),
    timestamp: r.timestamp,
  };
  const ts = decOpt(r.time_start);
  const te = decOpt(r.time_end);
  if (ts && te) entry.timeRange = { start: ts, end: te };
  if (r.amount != null) entry.amount = Number(decField(String(r.amount)));
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
    encField(entry.raw),
    entry.time,
    encOpt(entry.timeRange?.start),
    encOpt(entry.timeRange?.end),
    encField(entry.description),
    encField(entry.category),
    entry.amount == null ? null : encField(String(entry.amount)),
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
    encOpt(fields.timeRange?.start),
    encOpt(fields.timeRange?.end),
    encField(fields.description),
    encField(fields.category),
    fields.amount == null ? null : encField(String(fields.amount)),
    fields.currency ?? null,
    fields.priority ?? null,
    id,
    userId,
  );
  if (Number(res.changes) === 0) return null;
  const row = stmtGet.get(id, userId) as unknown as Row | undefined;
  return row ? rowToEntry(row) : null;
}

// ─── 知识库 ────────────────────────────────────────────────────────────────────

interface KnowledgeRow {
  id: string;
  title: string;
  content: string;
  timestamp: string;
}

function rowToKnowledge(r: KnowledgeRow): KnowledgeItem {
  return {
    id: r.id,
    title: decField(r.title),
    content: decField(r.content),
    timestamp: r.timestamp,
  };
}

const stmtKnAll = db.prepare(
  "SELECT id, title, content, timestamp FROM knowledge WHERE user_id = ? ORDER BY timestamp DESC",
);
const stmtKnInsert = db.prepare(
  "INSERT INTO knowledge (id, title, content, timestamp, user_id) VALUES (?, ?, ?, ?, ?)",
);
const stmtKnDelete = db.prepare("DELETE FROM knowledge WHERE id = ? AND user_id = ?");

export function listKnowledge(userId: string): KnowledgeItem[] {
  return (stmtKnAll.all(userId) as unknown as KnowledgeRow[]).map(rowToKnowledge);
}

export function insertKnowledge(userId: string, title: string, content: string): KnowledgeItem {
  const item: KnowledgeItem = {
    id: crypto.randomUUID(),
    title,
    content,
    timestamp: new Date().toISOString(),
  };
  stmtKnInsert.run(item.id, encField(title), encField(content), item.timestamp, userId);
  return item;
}

export function deleteKnowledge(id: string, userId: string): boolean {
  return Number(stmtKnDelete.run(id, userId).changes) > 0;
}
