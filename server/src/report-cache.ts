import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Report } from "./summary.js";
import type { ReportEntry, ReportScope } from "./summary.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS report_cache (
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    period_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    report_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, scope, period_key)
  )
`);

export interface CachedReport {
  inputHash: string;
  report: Report;
  updatedAt: string;
}

export function reportFingerprint(entries: ReportEntry[]): string {
  const normalized = entries.map((entry) => ({
    type: entry.type,
    category: entry.category,
    description: entry.description,
    amount: entry.amount ?? null,
    timeRange: entry.timeRange ?? null,
    done: entry.done ?? null,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function getCachedReport(
  userId: string,
  scope: ReportScope,
  periodKey: string,
): CachedReport | null {
  const row = db.prepare(`SELECT input_hash,report_json,updated_at FROM report_cache
    WHERE user_id=? AND scope=? AND period_key=?`).get(userId, scope, periodKey) as
    | { input_hash: string; report_json: string; updated_at: string }
    | undefined;
  return row
    ? { inputHash: row.input_hash, report: JSON.parse(row.report_json) as Report, updatedAt: row.updated_at }
    : null;
}

export function saveCachedReport(
  userId: string,
  scope: ReportScope,
  periodKey: string,
  inputHash: string,
  report: Report,
): void {
  db.prepare(`INSERT INTO report_cache
    (user_id,scope,period_key,input_hash,report_json,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id,scope,period_key) DO UPDATE SET
      input_hash=excluded.input_hash,report_json=excluded.report_json,updated_at=excluded.updated_at`)
    .run(userId, scope, periodKey, inputHash, JSON.stringify(report), new Date().toISOString());
}
