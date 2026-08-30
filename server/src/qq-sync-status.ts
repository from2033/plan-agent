import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS qq_sync_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    connected INTEGER,
    account_label TEXT,
    last_checked_at TEXT,
    last_successful_sync_at TEXT,
    last_message_at TEXT,
    status_detail TEXT
  )
`);

export interface QqSyncStatus {
  configured: boolean;
  state: "online" | "offline" | "stale" | "unknown";
  connected: boolean | null;
  accountLabel: string;
  lastCheckedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastMessageAt: string | null;
  detail: string;
}

export function recordQqCollectorStatus(input: {
  connected: boolean;
  accountLabel?: string;
  checkedAt?: string;
  detail?: string;
}): void {
  const checkedAt = input.checkedAt || new Date().toISOString();
  db.prepare(`INSERT INTO qq_sync_status
    (id,connected,account_label,last_checked_at,status_detail)
    VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      connected=excluded.connected,
      account_label=excluded.account_label,
      last_checked_at=excluded.last_checked_at,
      status_detail=excluded.status_detail`).run(
    input.connected ? 1 : 0,
    (input.accountLabel || "").slice(0, 100),
    checkedAt,
    (input.detail || "").slice(0, 300),
  );
}

export function recordQqMessageSync(messageAt: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO qq_sync_status
    (id,last_successful_sync_at,last_message_at)
    VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_successful_sync_at=excluded.last_successful_sync_at,
      last_message_at=excluded.last_message_at`).run(now, messageAt);
}

export function getQqSyncStatus(configured: boolean, now = new Date()): QqSyncStatus {
  const row = db.prepare(`SELECT connected,account_label,last_checked_at,
    last_successful_sync_at,last_message_at,status_detail FROM qq_sync_status WHERE id=1`).get() as {
      connected: number | null;
      account_label: string | null;
      last_checked_at: string | null;
      last_successful_sync_at: string | null;
      last_message_at: string | null;
      status_detail: string | null;
    } | undefined;
  const connected = row?.connected == null ? null : row.connected === 1;
  const checkedTime = Date.parse(row?.last_checked_at || "");
  const heartbeatFresh = Number.isFinite(checkedTime) && now.getTime() - checkedTime <= 3 * 60_000;
  const state = !configured || connected == null
    ? "unknown"
    : !heartbeatFresh
      ? "stale"
      : connected ? "online" : "offline";
  return {
    configured,
    state,
    connected,
    accountLabel: row?.account_label || "",
    lastCheckedAt: row?.last_checked_at || null,
    lastSuccessfulSyncAt: row?.last_successful_sync_at || null,
    lastMessageAt: row?.last_message_at || null,
    detail: row?.status_detail || "",
  };
}
