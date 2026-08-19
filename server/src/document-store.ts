import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decField, decryptBuffer, encField, encryptBuffer } from "./crypto-field.js";

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
    status        TEXT NOT NULL,
    job_id        TEXT,
    result_json   TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);
`);

export interface StoredDocument {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: string;
  jobId: string | null;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  status: string;
  job_id: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function uploadPath(id: string): string {
  return path.join(UPLOAD_DIR, `${id}.paf`);
}

function rowToDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    fileName: decField(row.file_name),
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    status: row.status,
    jobId: row.job_id,
    result: row.result_json ? JSON.parse(decField(row.result_json)) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function storeDocumentUpload(
  userId: string,
  fileName: string,
  mimeType: string,
  content: Buffer,
): StoredDocument {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const finalPath = uploadPath(id);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, encryptBuffer(content), { mode: 0o600 });
  fs.renameSync(temporaryPath, finalPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO documents
    (id,user_id,file_name,mime_type,byte_size,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'QUEUED',?,?)`)
    .run(id, userId, encField(fileName), mimeType, content.length, now, now);
  return getDocument(id, userId)!;
}

export function bindDocumentJob(id: string, userId: string, jobId: string): void {
  db.prepare("UPDATE documents SET job_id=?,updated_at=? WHERE id=? AND user_id=?")
    .run(jobId, new Date().toISOString(), id, userId);
}

export function getDocument(id: string, userId: string): StoredDocument | null {
  const row = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?")
    .get(id, userId) as unknown as DocumentRow | undefined;
  return row ? rowToDocument(row) : null;
}

export function listDocuments(userId: string): StoredDocument[] {
  return (db.prepare("SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 200")
    .all(userId) as unknown as DocumentRow[]).map(rowToDocument);
}

export function readDocumentUpload(id: string, userId: string): { document: StoredDocument; content: Buffer } | null {
  const document = getDocument(id, userId);
  if (!document) return null;
  const stored = fs.readFileSync(uploadPath(id));
  return { document, content: decryptBuffer(stored) };
}

export function completeDocument(id: string, userId: string, result: unknown): void {
  db.prepare("UPDATE documents SET status='COMPLETE',result_json=?,error=NULL,updated_at=? WHERE id=? AND user_id=?")
    .run(encField(JSON.stringify(result)), new Date().toISOString(), id, userId);
  fs.rmSync(uploadPath(id), { force: true });
}

export function failDocument(id: string, userId: string, error: string): void {
  db.prepare("UPDATE documents SET status='FAILED',error=?,updated_at=? WHERE id=? AND user_id=?")
    .run(error.slice(0, 500), new Date().toISOString(), id, userId);
}

export function discardDocument(id: string, userId: string): void {
  db.prepare("DELETE FROM documents WHERE id=? AND user_id=?").run(id, userId);
  fs.rmSync(uploadPath(id), { force: true });
}

export function deleteUserDocuments(userId: string): void {
  const ids = db.prepare("SELECT id FROM documents WHERE user_id=?").all(userId) as unknown as { id: string }[];
  for (const { id } of ids) fs.rmSync(uploadPath(id), { force: true });
  db.prepare("DELETE FROM documents WHERE user_id=?").run(userId);
}
