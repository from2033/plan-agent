import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS email_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
`);

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function authSecret(): string {
  const value = process.env.AUTH_SECRET || "";
  if (value.length < 32) throw new Error("AUTH_SECRET 必须至少 32 个字符");
  return value;
}

function hashCode(email: string, code: string): string {
  return crypto.createHmac("sha256", authSecret()).update(`${email}:${code}`).digest("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function reviewEmail(): string {
  return normalizeEmail(process.env.APP_REVIEW_EMAIL || "");
}

function reviewCodeHash(): string {
  const value = (process.env.APP_REVIEW_CODE_HASH || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}

function isReviewEmail(email: string): boolean {
  return Boolean(reviewEmail() && reviewCodeHash() && email === reviewEmail());
}

function equalHash(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function allowedUserId(email: string): string | null {
  if (isReviewEmail(email)) return `app-review:${email}`;
  const primaryEmail = normalizeEmail(process.env.PRIMARY_EMAIL || "");
  if (primaryEmail && email === primaryEmail) return process.env.PRIMARY_USER || "我";
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  return allowed.includes(email) ? email : null;
}

function configured(): boolean {
  return Boolean(
    process.env.AUTH_SECRET &&
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      (process.env.PRIMARY_EMAIL || process.env.ALLOWED_EMAILS),
  );
}

export async function requestEmailCode(rawEmail: string): Promise<"sent" | "unavailable"> {
  const email = normalizeEmail(rawEmail);
  if (isReviewEmail(email)) {
    const now = new Date();
    const previous = db.prepare("SELECT requested_at FROM email_codes WHERE email=?").get(email) as
      | { requested_at: string }
      | undefined;
    if (previous && now.getTime() - new Date(previous.requested_at).getTime() < 60_000) {
      return "sent";
    }
    // App Review receives this fixed code in App Store Connect. No mailbox is
    // involved, and only its SHA-256 hash is stored in the protected runtime env.
    db.prepare(`INSERT INTO email_codes (email,code_hash,expires_at,requested_at,attempts)
      VALUES (?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,
      expires_at=excluded.expires_at,requested_at=excluded.requested_at,attempts=0`)
      .run(
        email,
        reviewCodeHash(),
        new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
        now.toISOString(),
      );
    return "sent";
  }
  if (!configured()) return "unavailable";
  // 不泄露邮箱是否在白名单；未授权地址也返回 sent，但不发送邮件。
  if (!allowedUserId(email)) return "sent";

  const now = new Date();
  const previous = db.prepare("SELECT requested_at FROM email_codes WHERE email=?").get(email) as
    | { requested_at: string }
    | undefined;
  if (previous && now.getTime() - new Date(previous.requested_at).getTime() < 60_000) return "sent";

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  db.prepare(`INSERT INTO email_codes (email,code_hash,expires_at,requested_at,attempts)
    VALUES (?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,
    expires_at=excluded.expires_at,requested_at=excluded.requested_at,attempts=0`)
    .run(email, hashCode(email, code), expiresAt, now.toISOString());

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || `5656AI <${process.env.SMTP_USER}>`,
    to: email,
    subject: `${code} 是你的登录验证码`,
    text: `你的 Personal Assistant 登录验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略。`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:28px;color:#1e1d1a"><p style="font-size:13px;color:#77736c">PERSONAL ASSISTANT</p><h1 style="font-size:24px">登录验证码</h1><p style="font-size:36px;letter-spacing:8px;font-weight:700;margin:28px 0">${code}</p><p style="color:#77736c">10 分钟内有效。若非本人操作，请忽略此邮件。</p></div>`,
  });
  return "sent";
}

export function verifyEmailCode(rawEmail: string, code: string): { token: string; user: string } | null {
  const email = normalizeEmail(rawEmail);
  if (!isReviewEmail(email) && !configured()) return null;
  const userId = allowedUserId(email);
  if (!userId) return null;
  const row = db.prepare("SELECT code_hash,expires_at,attempts FROM email_codes WHERE email=?").get(email) as
    | { code_hash: string; expires_at: string; attempts: number }
    | undefined;
  if (!row || row.expires_at <= new Date().toISOString() || row.attempts >= 5) return null;
  db.prepare("UPDATE email_codes SET attempts=attempts+1 WHERE email=?").run(email);
  const candidateHash = isReviewEmail(email) ? hashToken(code) : hashCode(email, code);
  if (!equalHash(row.code_hash, candidateHash)) return null;

  db.prepare("DELETE FROM email_codes WHERE email=?").run(email);
  db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").run(new Date().toISOString());
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  db.prepare("INSERT INTO auth_sessions (token_hash,user_id,email,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(hashToken(token), userId, email, new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(), now.toISOString());
  return { token, user: userId };
}

export function resolveEmailSession(token: string): string | null {
  if (!token) return null;
  const row = db.prepare("SELECT user_id,expires_at FROM auth_sessions WHERE token_hash=?").get(hashToken(token)) as
    | { user_id: string; expires_at: string }
    | undefined;
  return row && row.expires_at > new Date().toISOString() ? row.user_id : null;
}
