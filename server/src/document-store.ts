import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decField, decryptBuffer, encField, encryptBuffer } from "./crypto-field.js";
import { sharedResourceOwner, sharedResourcesForViewer } from "./family-sharing.js";
import { sharedConversationResourcesForViewer } from "./conversation-store.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const UPLOAD_DIR = process.env.DOCUMENT_UPLOAD_DIR
  || path.join(path.dirname(path.resolve(DB_PATH)), "document-uploads");
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    byte_size     INTEGER NOT NULL,
    content_hash  TEXT,
    status        TEXT NOT NULL,
    job_id        TEXT,
    result_json   TEXT,
    notes_json    TEXT,
    error         TEXT,
    storage_kind  TEXT NOT NULL DEFAULT 'uploaded',
    local_ref     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);
`);
const hasContentHash = (db.prepare("PRAGMA table_info(documents)").all() as unknown as { name: string }[])
  .some((column) => column.name === "content_hash");
if (!hasContentHash) db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT");
const hasNotesJson = (db.prepare("PRAGMA table_info(documents)").all() as unknown as { name: string }[])
  .some((column) => column.name === "notes_json");
if (!hasNotesJson) db.exec("ALTER TABLE documents ADD COLUMN notes_json TEXT");
const hasStorageKind = (db.prepare("PRAGMA table_info(documents)").all() as unknown as { name: string }[])
  .some((column) => column.name === "storage_kind");
if (!hasStorageKind) db.exec("ALTER TABLE documents ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'uploaded'");
const hasLocalRef = (db.prepare("PRAGMA table_info(documents)").all() as unknown as { name: string }[])
  .some((column) => column.name === "local_ref");
if (!hasLocalRef) db.exec("ALTER TABLE documents ADD COLUMN local_ref TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(user_id,content_hash) WHERE content_hash IS NOT NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_local_ref ON documents(user_id,local_ref) WHERE local_ref IS NOT NULL");

export interface StoredDocument {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: string;
  jobId: string | null;
  result: unknown | null;
  notes: string[];
  error: string | null;
  storageKind: "uploaded" | "local" | "research";
  createdAt: string;
  updatedAt: string;
  ownerUserId: string;
  sharedWithFamily: boolean;
  sharedInConversation: boolean;
  canEdit: boolean;
}

interface DocumentRow {
  user_id: string;
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  status: string;
  job_id: string | null;
  result_json: string | null;
  notes_json: string | null;
  error: string | null;
  storage_kind: string;
  created_at: string;
  updated_at: string;
}

function uploadPath(id: string): string {
  return path.join(UPLOAD_DIR, `${id}.paf`);
}

export function documentContentHash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function findDuplicateDocument(userId: string, content: Buffer): StoredDocument | null {
  const row = db.prepare("SELECT * FROM documents WHERE user_id=? AND content_hash=? LIMIT 1")
    .get(userId, documentContentHash(content)) as unknown as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

function rowToDocument(
  row: DocumentRow,
  metadata?: {
    sharedWithFamily?: boolean;
    sharedInConversation?: boolean;
    canEdit?: boolean;
  },
): StoredDocument {
  return {
    id: row.id,
    fileName: decField(row.file_name),
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    status: row.status,
    jobId: row.job_id,
    result: row.result_json ? JSON.parse(decField(row.result_json)) : null,
    notes: row.notes_json ? JSON.parse(decField(row.notes_json)) : [],
    error: row.error,
    storageKind: row.storage_kind === "local"
      ? "local"
      : row.storage_kind === "research"
        ? "research"
        : "uploaded",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerUserId: row.user_id,
    sharedWithFamily: metadata?.sharedWithFamily || false,
    sharedInConversation: metadata?.sharedInConversation || false,
    canEdit: metadata?.canEdit ?? true,
  };
}

export interface LocalDocumentRegistration {
  documentId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  vaultPath: string;
  result: Record<string, unknown>;
  notes?: string[];
}

export function registerLocalDocument(userId: string, value: LocalDocumentRegistration): StoredDocument {
  const localRef = crypto.createHash("sha256").update(value.vaultPath, "utf8").digest("hex");
  const existing = db.prepare("SELECT * FROM documents WHERE user_id=? AND local_ref=? LIMIT 1")
    .get(userId, localRef) as unknown as DocumentRow | undefined;
  const now = new Date().toISOString();
  if (existing) {
    if (existing.id !== value.documentId) throw new Error("local_document_id_mismatch");
    db.prepare(`UPDATE documents SET file_name=?,mime_type=?,byte_size=?,status='COMPLETE',
      result_json=?,notes_json=?,error=NULL,updated_at=? WHERE id=? AND user_id=?`)
      .run(
        encField(value.fileName),
        value.mimeType,
        value.byteSize,
        encField(JSON.stringify(value.result)),
        encField(JSON.stringify(value.notes || [])),
        now,
        existing.id,
        userId,
      );
    return getDocument(existing.id, userId)!;
  }
  db.prepare(`INSERT INTO documents
    (id,user_id,file_name,mime_type,byte_size,status,result_json,notes_json,storage_kind,local_ref,created_at,updated_at)
    VALUES (?,?,?,?,?,'COMPLETE',?,?, 'local',?,?,?)`)
    .run(
      value.documentId,
      userId,
      encField(value.fileName),
      value.mimeType,
      value.byteSize,
      encField(JSON.stringify(value.result)),
      encField(JSON.stringify(value.notes || [])),
      localRef,
      now,
      now,
    );
  return getDocument(value.documentId, userId)!;
}

export function storeDocumentUpload(
  userId: string,
  fileName: string,
  mimeType: string,
  content: Buffer,
  userNote = "",
): StoredDocument {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const contentHash = documentContentHash(content);
  const finalPath = uploadPath(id);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, encryptBuffer(content), { mode: 0o600 });
  fs.renameSync(temporaryPath, finalPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO documents
    (id,user_id,file_name,mime_type,byte_size,content_hash,status,notes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'QUEUED',?,?,?)`)
    .run(
      id,
      userId,
      encField(fileName),
      mimeType,
      content.length,
      contentHash,
      encField(JSON.stringify(userNote ? [userNote] : [])),
      now,
      now,
    );
  return getDocument(id, userId)!;
}

export function createResearchDocument(userId: string, topic: string): StoredDocument {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = topic.length > 80 ? `${topic.slice(0, 80)}…` : topic;
  db.prepare(`INSERT INTO documents
    (id,user_id,file_name,mime_type,byte_size,status,notes_json,storage_kind,created_at,updated_at)
    VALUES (?,?,?,?,0,'QUEUED',?,'research',?,?)`)
    .run(
      id,
      userId,
      encField(`研究报告：${title}`),
      "application/vnd.daynote.research+json",
      encField("[]"),
      now,
      now,
    );
  return getDocument(id, userId)!;
}

export function bindDocumentJob(id: string, userId: string, jobId: string): void {
  db.prepare("UPDATE documents SET job_id=?,updated_at=? WHERE id=? AND user_id=?")
    .run(jobId, new Date().toISOString(), id, userId);
}

export function restartDocumentProcessing(id: string, userId: string, jobId: string): boolean {
  const result = db.prepare(`UPDATE documents SET status='PROCESSING',job_id=?,error=NULL,updated_at=?
    WHERE id=? AND user_id=? AND status='FAILED'`).run(jobId, new Date().toISOString(), id, userId);
  return Number(result.changes) === 1;
}

export function getDocument(id: string, userId: string): StoredDocument | null {
  const row = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?")
    .get(id, userId) as unknown as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

export function getDocumentForViewer(id: string, userId: string): StoredDocument | null {
  const familyOwner = sharedResourceOwner(userId, "document", id);
  const conversationOwner = sharedConversationResourcesForViewer(userId, "document")
    .find(item => item.resourceId === id)?.ownerUserId || null;
  const own = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?")
    .get(id, userId) as unknown as DocumentRow | undefined;
  if (own) {
    return rowToDocument(own, {
      sharedWithFamily: familyOwner === userId,
      sharedInConversation: conversationOwner === userId,
      canEdit: true,
    });
  }
  const owner = familyOwner || conversationOwner;
  if (!owner) return null;
  const row = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?")
    .get(id, owner) as unknown as DocumentRow | undefined;
  return row ? rowToDocument(row, {
    sharedWithFamily: familyOwner === owner,
    sharedInConversation: conversationOwner === owner,
    canEdit: false,
  }) : null;
}

export function resolveDocumentEvidence(
  userId: string,
  documentId: string,
  relatedDocumentIds: string[],
): { document: StoredDocument; sourceKind: "uploaded" | "derived" } | null {
  const direct = getDocumentForViewer(documentId, userId);
  if (direct) return { document: direct, sourceKind: "uploaded" };
  if (!relatedDocumentIds.length) return null;
  const related = [...new Set(relatedDocumentIds)].map(id => getDocumentForViewer(id, userId));
  if (related.some(document => !document)) return null;
  return { document: related[0]!, sourceKind: "derived" };
}

export function listDocuments(userId: string): StoredDocument[] {
  return (db.prepare("SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 200")
    .all(userId) as unknown as DocumentRow[]).map((row) => rowToDocument(row));
}

export function listDocumentsForViewer(userId: string): StoredDocument[] {
  const familyShared = sharedResourcesForViewer(userId, "document");
  const conversationShared = sharedConversationResourcesForViewer(userId, "document");
  const sharedById = new Map<string, {
    ownerUserId: string;
    family: boolean;
    conversation: boolean;
  }>();
  for (const item of familyShared) {
    sharedById.set(item.resourceId, {
      ownerUserId: item.ownerUserId,
      family: true,
      conversation: false,
    });
  }
  for (const item of conversationShared) {
    const existing = sharedById.get(item.resourceId);
    sharedById.set(item.resourceId, {
      ownerUserId: item.ownerUserId,
      family: existing?.family || false,
      conversation: true,
    });
  }
  const own = (db.prepare("SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 200")
    .all(userId) as unknown as DocumentRow[])
    .map((row) => rowToDocument(row, {
      sharedWithFamily: sharedById.get(row.id)?.family || false,
      sharedInConversation: sharedById.get(row.id)?.conversation || false,
      canEdit: true,
    }));
  const visibleShared = [...sharedById.entries()]
    .filter(([, item]) => item.ownerUserId !== userId)
    .flatMap(([resourceId, item]) => {
      const row = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?")
        .get(resourceId, item.ownerUserId) as unknown as DocumentRow | undefined;
      return row ? [rowToDocument(row, {
        sharedWithFamily: item.family,
        sharedInConversation: item.conversation,
        canEdit: false,
      })] : [];
    });
  return [...own, ...visibleShared]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
}

export function readDocumentUpload(id: string, userId: string): { document: StoredDocument; content: Buffer } | null {
  const document = getDocument(id, userId);
  if (!document) return null;
  const path = uploadPath(id);
  if (!fs.existsSync(path)) return null;
  const stored = fs.readFileSync(path);
  return { document, content: decryptBuffer(stored) };
}

export function readDocumentUploadForViewer(
  id: string,
  userId: string,
): { document: StoredDocument; content: Buffer } | null {
  const document = getDocumentForViewer(id, userId);
  if (!document) return null;
  const storedPath = uploadPath(id);
  if (!fs.existsSync(storedPath)) return null;
  return { document, content: decryptBuffer(fs.readFileSync(storedPath)) };
}

export function completeDocument(id: string, userId: string, result: unknown): void {
  const document = getDocument(id, userId);
  db.prepare("UPDATE documents SET status='COMPLETE',result_json=?,error=NULL,updated_at=? WHERE id=? AND user_id=?")
    .run(encField(JSON.stringify(result)), new Date().toISOString(), id, userId);
  if (!document?.mimeType.startsWith("audio/")) {
    fs.rmSync(uploadPath(id), { force: true });
  }
}

export function failDocument(id: string, userId: string, error: string): void {
  db.prepare("UPDATE documents SET status='FAILED',error=?,updated_at=? WHERE id=? AND user_id=?")
    .run(error.slice(0, 500), new Date().toISOString(), id, userId);
}

export function appendDocumentNote(id: string, userId: string, note: string): StoredDocument | null {
  const document = getDocument(id, userId);
  if (!document) return null;
  const clean = note.trim().slice(0, 2_000);
  if (!clean) return document;
  const notes = document.notes.includes(clean) ? document.notes : [...document.notes, clean];
  db.prepare("UPDATE documents SET notes_json=?,updated_at=? WHERE id=? AND user_id=?")
    .run(encField(JSON.stringify(notes)), new Date().toISOString(), id, userId);
  return getDocument(id, userId);
}

export function discardDocument(id: string, userId: string): void {
  const result = db.prepare("DELETE FROM documents WHERE id=? AND user_id=?").run(id, userId);
  if (result.changes > 0) fs.rmSync(uploadPath(id), { force: true });
}

export function deleteUserDocuments(userId: string): void {
  const ids = db.prepare("SELECT id FROM documents WHERE user_id=?").all(userId) as unknown as { id: string }[];
  for (const { id } of ids) fs.rmSync(uploadPath(id), { force: true });
  db.prepare("DELETE FROM documents WHERE user_id=?").run(userId);
}
