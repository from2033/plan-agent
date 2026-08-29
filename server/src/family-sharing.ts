import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS family_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS family_members (
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (space_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id);
  CREATE TABLE IF NOT EXISTS family_invitations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    responded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_family_invitations_recipient
    ON family_invitations(recipient_user_id, status);
  CREATE TABLE IF NOT EXISTS family_resources (
    space_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    shared_at TEXT NOT NULL,
    PRIMARY KEY (resource_type, resource_id)
  );
  CREATE INDEX IF NOT EXISTS idx_family_resources_space
    ON family_resources(space_id, resource_type, shared_at DESC);
`);

const DEFAULT_SPACE_ID = "default-family";

function normalizeUserId(value: string): string {
  const clean = value.trim();
  return clean.includes("@") ? clean.toLowerCase() : clean;
}

export interface FamilyInvitation {
  id: string;
  familyName: string;
  invitedBy: string;
  createdAt: string;
}

export interface FamilyState {
  family: null | {
    id: string;
    name: string;
    role: "owner" | "member";
    members: Array<{ userId: string; role: "owner" | "member" }>;
  };
  invitations: FamilyInvitation[];
}

export function ensureDefaultFamily(primaryUser: string): void {
  const owner = normalizeUserId(primaryUser);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO family_spaces (id,name,owner_user_id,created_at)
    VALUES (?,?,?,?)`).run(DEFAULT_SPACE_ID, "我的家庭", owner, now);
  db.prepare(`INSERT OR IGNORE INTO family_members (space_id,user_id,role,joined_at)
    VALUES (?,?,?,?)`).run(DEFAULT_SPACE_ID, owner, "owner", now);
}

function membership(userId: string): { space_id: string; role: "owner" | "member" } | null {
  return db.prepare("SELECT space_id,role FROM family_members WHERE user_id=? LIMIT 1")
    .get(normalizeUserId(userId)) as { space_id: string; role: "owner" | "member" } | undefined || null;
}

export function areFamilyMembers(firstUserId: string, secondUserId: string): boolean {
  const first = membership(firstUserId);
  const second = membership(secondUserId);
  return Boolean(first && second && first.space_id === second.space_id);
}

export function getFamilyState(userId: string, primaryUser: string): FamilyState {
  ensureDefaultFamily(primaryUser);
  const normalized = normalizeUserId(userId);
  const member = membership(normalized);
  const invitations = db.prepare(`SELECT i.id,s.name AS family_name,i.invited_by,i.created_at
    FROM family_invitations i JOIN family_spaces s ON s.id=i.space_id
    WHERE i.recipient_user_id=? AND i.status='pending' ORDER BY i.created_at DESC`)
    .all(normalized) as unknown as Array<{
      id: string;
      family_name: string;
      invited_by: string;
      created_at: string;
    }>;
  if (!member) {
    return {
      family: null,
      invitations: invitations.map((row) => ({
        id: row.id,
        familyName: row.family_name,
        invitedBy: row.invited_by,
        createdAt: row.created_at,
      })),
    };
  }
  const space = db.prepare("SELECT name FROM family_spaces WHERE id=?").get(member.space_id) as
    | { name: string }
    | undefined;
  const members = db.prepare(`SELECT user_id,role FROM family_members
    WHERE space_id=? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at`)
    .all(member.space_id) as unknown as Array<{ user_id: string; role: "owner" | "member" }>;
  return {
    family: {
      id: member.space_id,
      name: space?.name || "我的家庭",
      role: member.role,
      members: members.map((row) => ({ userId: row.user_id, role: row.role })),
    },
    invitations: invitations.map((row) => ({
      id: row.id,
      familyName: row.family_name,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
    })),
  };
}

export function inviteFamilyMember(
  inviterUserId: string,
  recipientUserId: string,
  primaryUser: string,
): FamilyInvitation | null {
  ensureDefaultFamily(primaryUser);
  const inviter = normalizeUserId(inviterUserId);
  const recipient = normalizeUserId(recipientUserId);
  const member = membership(inviter);
  if (!member || !recipient || recipient === inviter || membership(recipient)) return null;
  const existing = db.prepare(`SELECT id FROM family_invitations
    WHERE space_id=? AND recipient_user_id=? AND status='pending' LIMIT 1`)
    .get(member.space_id, recipient) as { id: string } | undefined;
  const id = existing?.id || crypto.randomUUID();
  const now = new Date().toISOString();
  if (!existing) {
    db.prepare(`INSERT INTO family_invitations
      (id,space_id,recipient_user_id,invited_by,status,created_at)
      VALUES (?,?,?,?, 'pending',?)`).run(id, member.space_id, recipient, inviter, now);
  }
  const space = db.prepare("SELECT name FROM family_spaces WHERE id=?").get(member.space_id) as { name: string };
  return { id, familyName: space.name, invitedBy: inviter, createdAt: now };
}

export function respondToFamilyInvitation(
  invitationId: string,
  userId: string,
  accept: boolean,
): boolean {
  const normalized = normalizeUserId(userId);
  const invitation = db.prepare(`SELECT space_id FROM family_invitations
    WHERE id=? AND recipient_user_id=? AND status='pending'`)
    .get(invitationId, normalized) as { space_id: string } | undefined;
  if (!invitation || (accept && membership(normalized))) return false;
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE family_invitations SET status=?,responded_at=? WHERE id=?")
      .run(accept ? "accepted" : "declined", now, invitationId);
    if (accept) {
      db.prepare(`INSERT INTO family_members (space_id,user_id,role,joined_at)
        VALUES (?,?, 'member',?)`).run(invitation.space_id, normalized, now);
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function shareResourceWithFamily(
  userId: string,
  resourceType: "knowledge" | "document",
  resourceId: string,
): boolean {
  const owner = normalizeUserId(userId);
  const member = membership(owner);
  if (!member) return false;
  db.prepare(`INSERT OR IGNORE INTO family_resources
    (space_id,resource_type,resource_id,owner_user_id,shared_at) VALUES (?,?,?,?,?)`)
    .run(member.space_id, resourceType, resourceId, owner, new Date().toISOString());
  return true;
}

export function unshareResourceFromFamily(
  userId: string,
  resourceType: "knowledge" | "document",
  resourceId: string,
): boolean {
  const result = db.prepare(`DELETE FROM family_resources
    WHERE resource_type=? AND resource_id=? AND owner_user_id=?`)
    .run(resourceType, resourceId, normalizeUserId(userId));
  return Number(result.changes) > 0;
}

export function sharedResourcesForViewer(
  userId: string,
  resourceType: "knowledge" | "document",
): Array<{ resourceId: string; ownerUserId: string }> {
  const member = membership(userId);
  if (!member) return [];
  return (db.prepare(`SELECT resource_id,owner_user_id FROM family_resources
    WHERE space_id=? AND resource_type=?`)
    .all(member.space_id, resourceType) as unknown as Array<{
      resource_id: string;
      owner_user_id: string;
    }>).map((row) => ({ resourceId: row.resource_id, ownerUserId: row.owner_user_id }));
}

export function sharedResourceOwner(
  userId: string,
  resourceType: "knowledge" | "document",
  resourceId: string,
): string | null {
  const member = membership(userId);
  if (!member) return null;
  const row = db.prepare(`SELECT owner_user_id FROM family_resources
    WHERE space_id=? AND resource_type=? AND resource_id=?`)
    .get(member.space_id, resourceType, resourceId) as { owner_user_id: string } | undefined;
  return row?.owner_user_id || null;
}

export function deleteFamilyAccountData(userId: string): void {
  const normalized = normalizeUserId(userId);
  db.prepare("DELETE FROM family_invitations WHERE recipient_user_id=? OR invited_by=?")
    .run(normalized, normalized);
  db.prepare("DELETE FROM family_resources WHERE owner_user_id=?").run(normalized);
  db.prepare("DELETE FROM family_members WHERE user_id=?").run(normalized);
}
