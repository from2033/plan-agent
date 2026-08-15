import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS guest_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guest_sessions_expiry ON guest_sessions(expires_at);
`);

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createGuestSession(): { token: string; user: "访客"; expiresAt: string } {
  const now = new Date();
  db.prepare("DELETE FROM guest_sessions WHERE expires_at<=?").run(now.toISOString());
  const token = crypto.randomBytes(32).toString("base64url");
  const userId = `guest:${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  db.prepare(
    "INSERT INTO guest_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
  ).run(hashToken(token), userId, expiresAt, now.toISOString());
  return { token, user: "访客", expiresAt };
}

export function resolveGuestSession(token: string): string | null {
  if (!token) return null;
  const row = db.prepare(
    "SELECT user_id,expires_at FROM guest_sessions WHERE token_hash=?",
  ).get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;
  return row && row.expires_at > new Date().toISOString() ? row.user_id : null;
}

export function isGuestUser(userId: string | undefined): boolean {
  return Boolean(userId?.startsWith("guest:"));
}
