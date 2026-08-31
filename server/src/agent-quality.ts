import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { decField, encField } from "./crypto-field.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_failure_samples (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    standard_version TEXT NOT NULL,
    kind TEXT NOT NULL,
    description_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    input_json TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_failure_sample_unique
    ON agent_failure_samples(task_id,kind,description_hash);
  CREATE INDEX IF NOT EXISTS idx_agent_failure_samples_user
    ON agent_failure_samples(user_id,created_at DESC);
`);

type FailureTask = {
  id: string;
  userId: string;
  capability: string;
  standardVersion: string;
  input: unknown;
};

export function recordAgentFailureSample(
  task: FailureTask,
  kind: "acceptance" | "execution" | "user_correction",
  description: string,
  result?: unknown,
): void {
  const clean = description.trim().slice(0, 1_000);
  if (!clean) return;
  const descriptionHash = crypto.createHash("sha256").update(clean).digest("hex");
  db.prepare(`INSERT OR IGNORE INTO agent_failure_samples
    (id,user_id,task_id,capability,standard_version,kind,description_hash,description,input_json,result_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(),
      task.userId,
      task.id,
      task.capability,
      task.standardVersion,
      kind,
      descriptionHash,
      encField(clean),
      encField(JSON.stringify(task.input)),
      result == null ? null : encField(JSON.stringify(result)),
      new Date().toISOString(),
    );
}

export function agentQualityAudit(userId: string, days = 30): unknown {
  const safeDays = Math.min(365, Math.max(1, Math.trunc(days)));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60_000).toISOString();
  const totals = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN stage='verified' THEN 1 ELSE 0 END) AS verified,
    SUM(CASE WHEN stage='failed' THEN 1 ELSE 0 END) AS failed
    FROM agent_tasks WHERE user_id=? AND created_at>=?`).get(userId, since) as {
      total: number; verified: number | null; failed: number | null;
    };
  const terminal = Number(totals.verified || 0) + Number(totals.failed || 0);
  const samples = db.prepare(`SELECT capability,kind,COUNT(*) AS count
    FROM agent_failure_samples WHERE user_id=? AND created_at>=?
    GROUP BY capability,kind ORDER BY count DESC`).all(userId, since) as unknown as Array<{
      capability: string; kind: string; count: number;
    }>;
  const retries = db.prepare(`SELECT COUNT(*) AS count FROM agent_task_events
    WHERE user_id=? AND to_stage='retrying' AND created_at>=?`).get(userId, since) as { count: number };
  const repeated = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT task_id FROM agent_task_events WHERE user_id=? AND created_at>=?
      AND reason IN ('user_confirmed','action_confirmed') GROUP BY task_id HAVING COUNT(*)>1
    )`).get(userId, since) as { count: number };
  return {
    days: safeDays,
    totalTasks: Number(totals.total || 0),
    verifiedTasks: Number(totals.verified || 0),
    failedTasks: Number(totals.failed || 0),
    acceptancePassRate: terminal ? Number((Number(totals.verified || 0) / terminal).toFixed(4)) : null,
    retryCount: Number(retries.count || 0),
    repeatedExecutionCount: Number(repeated.count || 0),
    failureTypes: samples,
  };
}

export function listAgentFailureSamples(userId: string, limit = 50): unknown[] {
  const rows = db.prepare(`SELECT id,task_id,capability,standard_version,kind,description,created_at,resolved_at
    FROM agent_failure_samples WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(
      userId, Math.min(200, Math.max(1, limit)),
    ) as unknown as Array<Record<string, unknown> & { description: string }>;
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    capability: row.capability,
    standardVersion: row.standard_version,
    kind: row.kind,
    description: decField(row.description),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }));
}
