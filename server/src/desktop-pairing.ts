import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createAuthSessionForUser } from "./email-auth.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS desktop_pairing_sessions (
    id TEXT PRIMARY KEY,
    desktop_secret_hash TEXT NOT NULL,
    scan_secret_hash TEXT NOT NULL,
    device_label TEXT NOT NULL,
    user_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT,
    consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_pairing_expiry
    ON desktop_pairing_sessions(expires_at);
`);

const PAIRING_LIFETIME_MS = 90_000;
const DESKTOP_SESSION_LIFETIME_MS = 2 * 60 * 60_000;

type PairingRow = {
  id: string;
  desktop_secret_hash: string;
  scan_secret_hash: string;
  device_label: string;
  user_id: string | null;
  expires_at: string;
  approved_at: string | null;
  consumed_at: string | null;
};

function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function secretMatches(value: string, expectedHash: string): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function pairing(id: string): PairingRow | undefined {
  return db.prepare(`SELECT id,desktop_secret_hash,scan_secret_hash,device_label,user_id,
    expires_at,approved_at,consumed_at FROM desktop_pairing_sessions WHERE id=?`)
    .get(id) as PairingRow | undefined;
}

export function createDesktopPairing(deviceLabel: string): {
  id: string;
  desktopSecret: string;
  scanSecret: string;
  deviceLabel: string;
  expiresAt: string;
} {
  const now = new Date();
  db.prepare("DELETE FROM desktop_pairing_sessions WHERE expires_at<=?").run(now.toISOString());
  const id = crypto.randomUUID();
  const desktopSecret = crypto.randomBytes(32).toString("base64url");
  const scanSecret = crypto.randomBytes(32).toString("base64url");
  const safeLabel = deviceLabel.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80)
    || "电脑浏览器";
  const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS).toISOString();
  db.prepare(`INSERT INTO desktop_pairing_sessions
    (id,desktop_secret_hash,scan_secret_hash,device_label,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`)
    .run(id, hashSecret(desktopSecret), hashSecret(scanSecret), safeLabel, now.toISOString(), expiresAt);
  return { id, desktopSecret, scanSecret, deviceLabel: safeLabel, expiresAt };
}

export function inspectDesktopPairing(
  id: string,
  scanSecret: string,
): { status: "waiting" | "approved"; deviceLabel: string; expiresAt: string } | null {
  const row = pairing(id);
  if (!row || !secretMatches(scanSecret, row.scan_secret_hash)) return null;
  if (row.expires_at <= new Date().toISOString() || row.consumed_at) return null;
  return {
    status: row.approved_at ? "approved" : "waiting",
    deviceLabel: row.device_label,
    expiresAt: row.expires_at,
  };
}

export function approveDesktopPairing(
  id: string,
  scanSecret: string,
  userId: string,
): { status: "approved"; deviceLabel: string } | null {
  const row = pairing(id);
  if (!row || !secretMatches(scanSecret, row.scan_secret_hash)) return null;
  const now = new Date().toISOString();
  if (row.expires_at <= now || row.consumed_at) return null;
  if (row.user_id && row.user_id !== userId) return null;
  const approved = db.prepare(`UPDATE desktop_pairing_sessions
    SET user_id=?,approved_at=COALESCE(approved_at,?)
    WHERE id=? AND consumed_at IS NULL AND expires_at>? AND (user_id IS NULL OR user_id=?)`)
    .run(userId, now, id, now, userId);
  if (approved.changes !== 1) return null;
  return { status: "approved", deviceLabel: row.device_label };
}

export type DesktopPairingClaim =
  | { status: "waiting" }
  | { status: "expired" | "consumed" | "invalid" }
  | { status: "complete"; token: string; user: string; expiresAt: string };

export function claimDesktopPairing(id: string, desktopSecret: string): DesktopPairingClaim {
  const row = pairing(id);
  if (!row || !secretMatches(desktopSecret, row.desktop_secret_hash)) {
    return { status: "invalid" };
  }
  const now = new Date().toISOString();
  if (row.expires_at <= now) return { status: "expired" };
  if (row.consumed_at) return { status: "consumed" };
  if (!row.approved_at || !row.user_id) return { status: "waiting" };

  const consumed = db.prepare(`UPDATE desktop_pairing_sessions SET consumed_at=?
    WHERE id=? AND consumed_at IS NULL`).run(now, id);
  if (consumed.changes !== 1) return { status: "consumed" };
  const session = createAuthSessionForUser(
    row.user_id,
    `desktop-pairing:${row.device_label}`,
    DESKTOP_SESSION_LIFETIME_MS,
  );
  return { status: "complete", token: session.token, user: row.user_id, expiresAt: session.expiresAt };
}
