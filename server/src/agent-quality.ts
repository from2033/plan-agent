import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { decField, encField } from "./crypto-field.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA busy_timeout = 5000");
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
  const firstPass = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN first_terminal='verified' THEN 1 ELSE 0 END) passed FROM (
      SELECT t.id,(SELECT e.to_stage FROM agent_task_events e WHERE e.task_id=t.id
        AND e.to_stage IN ('verified','failed') ORDER BY e.created_at ASC LIMIT 1) first_terminal
      FROM agent_tasks t WHERE t.user_id=? AND t.created_at>=?
    ) WHERE first_terminal IS NOT NULL`).get(userId, since) as { total:number; passed:number|null };
  const corrected = db.prepare(`SELECT COUNT(DISTINCT f.task_id) count FROM agent_failure_samples f
    JOIN agent_tasks t ON t.id=f.task_id WHERE f.user_id=? AND f.kind='user_correction'
      AND t.stage='verified' AND f.created_at>=?`).get(userId, since) as { count:number };
  const retried = db.prepare(`SELECT COUNT(DISTINCT task_id) count FROM agent_task_events
    WHERE user_id=? AND to_stage='retrying' AND created_at>=?`).get(userId, since) as { count:number };
  const retryRecovered = db.prepare(`SELECT COUNT(DISTINCT e.task_id) count FROM agent_task_events e
    JOIN agent_tasks t ON t.id=e.task_id WHERE e.user_id=? AND e.to_stage='retrying'
      AND e.created_at>=? AND t.stage='verified'`).get(userId, since) as { count:number };
  const stuck = db.prepare(`SELECT COUNT(*) count FROM agent_tasks WHERE user_id=? AND created_at>=?
    AND stage IN ('received','classified','extracted','executing','verifying','retrying','follow_up','awaiting_user')
    AND updated_at<=?`).get(userId, since, new Date(Date.now() - 2 * 60 * 60_000).toISOString()) as { count:number };
  const byVersion = db.prepare(`SELECT capability,standard_version AS version,COUNT(*) total,
    SUM(CASE WHEN stage='verified' THEN 1 ELSE 0 END) verified,
    SUM(CASE WHEN stage='failed' THEN 1 ELSE 0 END) failed
    FROM agent_tasks WHERE user_id=? AND created_at>=?
    GROUP BY capability,standard_version ORDER BY total DESC`).all(userId, since) as unknown as Array<{
      capability:string; version:string; total:number; verified:number|null; failed:number|null;
    }>;
  return {
    days: safeDays,
    totalTasks: Number(totals.total || 0),
    verifiedTasks: Number(totals.verified || 0),
    failedTasks: Number(totals.failed || 0),
    acceptancePassRate: terminal ? Number((Number(totals.verified || 0) / terminal).toFixed(4)) : null,
    firstPassRate: firstPass.total ? Number((Number(firstPass.passed || 0) / firstPass.total).toFixed(4)) : null,
    postPassCorrectionRate: Number(totals.verified || 0) ? Number((corrected.count / Number(totals.verified || 0)).toFixed(4)) : null,
    retryCount: Number(retries.count || 0),
    retryRecoveryRate: retried.count ? Number((retryRecovered.count / retried.count).toFixed(4)) : null,
    stuckTaskCount: stuck.count,
    repeatedExecutionCount: Number(repeated.count || 0),
    repeatedSideEffectRate: terminal ? Number((Number(repeated.count || 0) / terminal).toFixed(4)) : null,
    versions: byVersion.map(item => ({ ...item,
      passRate: Number(item.verified || 0) + Number(item.failed || 0)
        ? Number((Number(item.verified || 0) / (Number(item.verified || 0) + Number(item.failed || 0))).toFixed(4)) : null,
    })),
    failureTypes: samples,
  };
}

export function unresolvedFailureSamples(userId: string, capability: string, limit = 20): unknown[] {
  const rows = db.prepare(`SELECT id,task_id,standard_version,kind,description,input_json,result_json,created_at
    FROM agent_failure_samples WHERE user_id=? AND capability=? AND resolved_at IS NULL
    ORDER BY created_at DESC LIMIT ?`).all(userId, capability, Math.min(50, Math.max(1, limit))) as unknown as Array<{
      id:string; task_id:string; standard_version:string; kind:string; description:string;
      input_json:string|null; result_json:string|null; created_at:string;
    }>;
  const decodeJson = (value: string | null) => { if (!value) return null; try { return JSON.parse(decField(value)); } catch { return null; } };
  return rows.map(row => ({ id: row.id, taskId: row.task_id, standardVersion: row.standard_version,
    kind: row.kind, description: decField(row.description), input: decodeJson(row.input_json),
    result: decodeJson(row.result_json), createdAt: row.created_at }));
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
