import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decField, encField } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS push_devices (
    token_hash TEXT PRIMARY KEY,
    token_encrypted TEXT NOT NULL,
    user_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);
`);

type ServiceAccount = {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
};

type PushDeviceRow = {
  token_hash: string;
  token_encrypted: string;
  platform: string;
};

export type PushSendResult = {
  configured: boolean;
  attempted: number;
  sent: number;
  failed: number;
};

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function registerPushDevice(userId: string, token: string, platform: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO push_devices
      (token_hash, token_encrypted, user_id, platform, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      token_encrypted=excluded.token_encrypted,
      user_id=excluded.user_id,
      platform=excluded.platform,
      updated_at=excluded.updated_at
  `).run(tokenHash(token), encField(token), userId, platform, now, now);
}

export function unregisterPushDevice(userId: string, token: string): boolean {
  return Number(db.prepare(
    "DELETE FROM push_devices WHERE token_hash=? AND user_id=?",
  ).run(tokenHash(token), userId).changes) > 0;
}

export function pushDeviceCount(userId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM push_devices WHERE user_id=?",
  ).get(userId) as { count: number };
  return Number(row.count);
}

function serviceAccount(): ServiceAccount | null {
  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  const encoded = process.env.FCM_SERVICE_ACCOUNT_BASE64?.trim();
  const filePath = process.env.FCM_SERVICE_ACCOUNT_PATH?.trim();
  if (!inline && !encoded && !filePath) return null;
  const source = inline
    || (encoded ? Buffer.from(encoded, "base64").toString("utf8") : readFileSync(filePath!, "utf8"));
  const parsed = JSON.parse(source) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error("FCM service account is incomplete");
  }
  return parsed as ServiceAccount;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function googleAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const value = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !value.access_token) {
    throw new Error(value.error_description || `Google OAuth failed (${response.status})`);
  }
  return value.access_token;
}

function permanentlyInvalid(status: number, body: string): boolean {
  return status === 404 || (status === 400 && /UNREGISTERED|INVALID_ARGUMENT/i.test(body));
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
): Promise<PushSendResult> {
  const account = serviceAccount();
  if (!account) return { configured: false, attempted: 0, sent: 0, failed: 0 };
  const rows = db.prepare(
    "SELECT token_hash,token_encrypted,platform FROM push_devices WHERE user_id=?",
  ).all(userId) as unknown as PushDeviceRow[];
  if (!rows.length) return { configured: true, attempted: 0, sent: 0, failed: 0 };

  const accessToken = await googleAccessToken(account);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: decField(row.token_encrypted),
            notification: { title, body },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      },
    );
    if (response.ok) {
      sent += 1;
      continue;
    }
    failed += 1;
    const responseBody = await response.text();
    let reason = "unknown";
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      };
      reason = parsed.error?.details?.find(detail => detail.errorCode)?.errorCode
        || parsed.error?.status
        || reason;
    } catch { /* keep a non-sensitive generic reason */ }
    console.error(`[push] FCM rejected message: status=${response.status} reason=${reason}`);
    if (permanentlyInvalid(response.status, responseBody)) {
      db.prepare("DELETE FROM push_devices WHERE token_hash=?").run(row.token_hash);
    }
  }
  return { configured: true, attempted: rows.length, sent, failed };
}
