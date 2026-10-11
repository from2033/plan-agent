import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS request_rate_limits (
    bucket_key TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL
  );
`);

const consumeBucket = db.prepare(`
  INSERT INTO request_rate_limits (bucket_key, window_started_at, request_count)
  VALUES (?, ?, 1)
  ON CONFLICT(bucket_key) DO UPDATE SET
    request_count = CASE
      WHEN request_rate_limits.window_started_at <= ? THEN 1
      ELSE request_rate_limits.request_count + 1
    END,
    window_started_at = CASE
      WHEN request_rate_limits.window_started_at <= ? THEN excluded.window_started_at
      ELSE request_rate_limits.window_started_at
    END
  RETURNING window_started_at, request_count
`);

let cleanupCounter = 0;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function bucketKey(scope: string, identifier: string): string {
  return `${scope}:${crypto.createHash("sha256").update(identifier || "unknown").digest("hex")}`;
}

export function consumeRequestLimit(
  scope: string,
  identifier: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("invalid_rate_limit_policy");
  }
  const resetBefore = now - windowMs;
  const row = consumeBucket.get(
    bucketKey(scope, identifier),
    now,
    resetBefore,
    resetBefore,
  ) as { window_started_at: number; request_count: number };
  cleanupCounter += 1;
  if (cleanupCounter % 1_000 === 0) {
    db.prepare("DELETE FROM request_rate_limits WHERE window_started_at <= ?").run(now - 7 * 24 * 60 * 60_000);
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((row.window_started_at + windowMs - now) / 1_000));
  return {
    allowed: row.request_count <= limit,
    remaining: Math.max(0, limit - row.request_count),
    retryAfterSeconds,
  };
}

export function corsOriginPolicy(
  configuredOrigins: string | undefined,
  nodeEnvironment: string | undefined,
): boolean | string[] {
  const value = configuredOrigins?.trim() || "";
  if (!value) return nodeEnvironment === "production" ? false : true;
  if (value === "*") return nodeEnvironment === "production" ? false : true;
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}
