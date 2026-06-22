import { DatabaseSync } from "node:sqlite";
import type { Entry } from "./types.js";

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
    timestamp   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(timestamp);
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

const stmtAll = db.prepare("SELECT * FROM entries ORDER BY timestamp ASC");
const stmtInsert = db.prepare(`
  INSERT INTO entries
    (id, type, raw, time, time_start, time_end, description, category, amount, currency, priority, done, timestamp)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtSetDone = db.prepare("UPDATE entries SET done = ? WHERE id = ?");
const stmtDelete = db.prepare("DELETE FROM entries WHERE id = ?");
const stmtGet = db.prepare("SELECT * FROM entries WHERE id = ?");

export function listEntries(): Entry[] {
  return (stmtAll.all() as unknown as Row[]).map(rowToEntry);
}

export function insertEntry(entry: Entry): Entry {
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
  );
  return entry;
}

export function setDone(id: string, done: boolean): Entry | null {
  const res = stmtSetDone.run(done ? 1 : 0, id);
  if (Number(res.changes) === 0) return null;
  const row = stmtGet.get(id) as unknown as Row | undefined;
  return row ? rowToEntry(row) : null;
}

export function deleteEntry(id: string): boolean {
  return Number(stmtDelete.run(id).changes) > 0;
}
