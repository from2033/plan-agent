import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { decField, encField } from "./crypto-field.js";
import { chunkedUploadStore } from "./chunked-upload.js";
import { getDocument } from "./document-store.js";
import {
  createPersistentAgentTask,
  getPersistentAgentTask,
  listChildAgentTasks,
  transitionPersistentAgentTask,
  verifyPersistentAgentTask,
} from "./agent-runtime.js";

const db = new DatabaseSync(process.env.DB_PATH || "./data.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS desktop_intake_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    device_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_intake_sessions_expiry
    ON desktop_intake_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS desktop_submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    instruction TEXT NOT NULL,
    pasted_text TEXT NOT NULL,
    expected_item_count INTEGER NOT NULL,
    stage TEXT NOT NULL,
    agent_task_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT,
    UNIQUE(user_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_submissions_user
    ON desktop_submissions(user_id,created_at DESC);
  CREATE TABLE IF NOT EXISTS desktop_submission_files (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    upload_id TEXT,
    document_id TEXT,
    agent_task_id TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_submission_upload
    ON desktop_submission_files(upload_id) WHERE upload_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_desktop_submission_files_parent
    ON desktop_submission_files(submission_id,created_at);
`);
const hasContentHash = (db.prepare("PRAGMA table_info(desktop_submission_files)").all() as unknown as { name: string }[])
  .some((column) => column.name === "content_hash");
if (!hasContentHash) db.exec("ALTER TABLE desktop_submission_files ADD COLUMN content_hash TEXT");

const SESSION_LIFETIME_MS = 30 * 60_000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sameHash(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export interface DesktopIntakeSession {
  id: string;
  userId: string;
  deviceLabel: string;
  expiresAt: string;
}

export function createDesktopIntakeSession(userId: string, deviceLabel: string): DesktopIntakeSession & { token: string } {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  db.prepare(`INSERT INTO desktop_intake_sessions
    (id,token_hash,user_id,device_label,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`).run(
      id,
      hashToken(token),
      userId,
      encField(deviceLabel.slice(0, 80)),
      now.toISOString(),
      expiresAt,
    );
  return { id, token, userId, deviceLabel, expiresAt };
}

export function resolveDesktopIntakeSession(token: string): DesktopIntakeSession | null {
  if (!token) return null;
  const row = db.prepare(`SELECT id,token_hash,user_id,device_label,expires_at,revoked_at
    FROM desktop_intake_sessions WHERE token_hash=? LIMIT 1`).get(hashToken(token)) as {
      id: string; token_hash: string; user_id: string; device_label: string;
      expires_at: string; revoked_at: string | null;
    } | undefined;
  if (!row || row.revoked_at || row.expires_at <= new Date().toISOString()) return null;
  if (!sameHash(hashToken(token), row.token_hash)) return null;
  return { id: row.id, userId: row.user_id, deviceLabel: decField(row.device_label), expiresAt: row.expires_at };
}

export function revokeDesktopIntakeSession(id: string, userId: string): void {
  db.prepare("UPDATE desktop_intake_sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id, userId);
}

export interface DesktopSubmissionFile {
  id: string;
  kind: "file" | "text";
  uploadId: string | null;
  documentId: string | null;
  agentTaskId: string | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentHash: string | null;
  status: "PENDING" | "UPLOADING" | "UPLOADED" | "PROCESSING" | "COMPLETE" | "FAILED";
  error: string | null;
}

export interface DesktopSubmission {
  id: string;
  userId: string;
  sessionId: string;
  instruction: string;
  pastedText: string;
  expectedItemCount: number;
  stage: "DRAFT" | "PROCESSING" | "COMPLETE" | "FAILED";
  agentTaskId: string;
  files: DesktopSubmissionFile[];
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

type SubmissionRow = {
  id: string; user_id: string; session_id: string; instruction: string; pasted_text: string;
  expected_item_count: number; stage: DesktopSubmission["stage"]; agent_task_id: string;
  created_at: string; updated_at: string; committed_at: string | null;
};
type FileRow = {
  id: string; kind: "file" | "text"; upload_id: string | null; document_id: string | null;
  agent_task_id: string | null; file_name: string; mime_type: string; byte_size: number;
  status: DesktopSubmissionFile["status"]; error: string | null; content_hash: string | null;
};

function filesForSubmission(id: string, userId: string): DesktopSubmissionFile[] {
  return (db.prepare("SELECT * FROM desktop_submission_files WHERE submission_id=? AND user_id=? ORDER BY created_at")
    .all(id, userId) as unknown as FileRow[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      uploadId: row.upload_id,
      documentId: row.document_id,
      agentTaskId: row.agent_task_id,
      fileName: decField(row.file_name),
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      contentHash: row.content_hash,
      status: row.status,
      error: row.error ? decField(row.error) : null,
    }));
}

function decodeSubmission(row: SubmissionRow): DesktopSubmission {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    instruction: decField(row.instruction),
    pastedText: decField(row.pasted_text),
    expectedItemCount: row.expected_item_count,
    stage: row.stage,
    agentTaskId: row.agent_task_id,
    files: filesForSubmission(row.id, row.user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
  };
}

export function getDesktopSubmission(id: string, userId: string, sessionId?: string): DesktopSubmission | null {
  const row = db.prepare(`SELECT * FROM desktop_submissions
    WHERE id=? AND user_id=?${sessionId ? " AND session_id=?" : ""}`)
    .get(...(sessionId ? [id, userId, sessionId] : [id, userId])) as unknown as SubmissionRow | undefined;
  return row ? decodeSubmission(row) : null;
}

export function createDesktopSubmission(
  session: DesktopIntakeSession,
  input: { instruction: string; pastedText: string; expectedFileCount: number; idempotencyKey: string },
): DesktopSubmission {
  const textCount = input.pastedText.trim() ? 1 : 0;
  const expectedItemCount = input.expectedFileCount + textCount;
  if (expectedItemCount < 1) throw new Error("desktop_submission_empty");
  const existing = db.prepare("SELECT * FROM desktop_submissions WHERE user_id=? AND idempotency_key=?")
    .get(session.userId, input.idempotencyKey) as unknown as SubmissionRow | undefined;
  if (existing) return decodeSubmission(existing);
  const id = crypto.randomUUID();
  const task = createPersistentAgentTask(
    session.userId,
    "desktop_intake",
    {
      title: input.instruction.trim() || `电脑投递 ${expectedItemCount} 项资料`,
      instruction: input.instruction.trim(),
      expectedItemCount,
      inferenceMode: input.instruction.trim() ? "explicit" : "automatic",
    },
    "desktop",
    id,
  );
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO desktop_submissions
    (id,user_id,session_id,instruction,pasted_text,expected_item_count,stage,agent_task_id,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?)`).run(
      id,
      session.userId,
      session.id,
      encField(input.instruction.trim()),
      encField(input.pastedText.trim()),
      expectedItemCount,
      task.id,
      input.idempotencyKey,
      now,
      now,
    );
  if (textCount) {
    const bytes = Buffer.byteLength(input.pastedText.trim(), "utf8");
    db.prepare(`INSERT INTO desktop_submission_files
      (id,submission_id,user_id,kind,file_name,mime_type,byte_size,status,created_at,updated_at)
      VALUES (?,?,?,'text',?,'text/plain',?,'PENDING',?,?)`).run(
        crypto.randomUUID(), id, session.userId, encField("电脑粘贴文字.txt"), bytes, now, now,
      );
  }
  return getDesktopSubmission(id, session.userId, session.id)!;
}

export function createDesktopSubmissionUpload(
  session: DesktopIntakeSession,
  submissionId: string,
  input: { fileName: string; mimeType: string; totalBytes: number },
): { fileId: string; uploadId: string; chunkSize: number; chunkCount: number } {
  const submission = getDesktopSubmission(submissionId, session.userId, session.id);
  if (!submission || submission.stage !== "DRAFT") throw new Error("desktop_submission_not_found");
  const currentFileCount = submission.files.filter((item) => item.kind === "file").length;
  const expectedFileCount = submission.expectedItemCount - (submission.pastedText ? 1 : 0);
  const retrying = submission.files.find((item) => item.kind === "file"
    && !item.documentId && item.fileName === input.fileName && item.byteSize === input.totalBytes);
  if (!retrying && currentFileCount >= expectedFileCount) throw new Error("desktop_submission_file_limit");
  const upload = chunkedUploadStore.create(session.userId, {
    fileName: input.fileName,
    mimeType: input.mimeType,
    totalBytes: input.totalBytes,
    userNote: submission.instruction,
  });
  if (retrying) {
    if (retrying.uploadId) {
      try { chunkedUploadStore.remove(session.userId, retrying.uploadId); } catch { /* expired upload */ }
    }
    db.prepare(`UPDATE desktop_submission_files
      SET upload_id=?,mime_type=?,status='UPLOADING',error=NULL,updated_at=? WHERE id=? AND user_id=?`).run(
        upload.id, input.mimeType, new Date().toISOString(), retrying.id, session.userId,
      );
    return { fileId: retrying.id, uploadId: upload.id, chunkSize: upload.chunkSize, chunkCount: upload.chunkCount };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO desktop_submission_files
    (id,submission_id,user_id,kind,upload_id,file_name,mime_type,byte_size,status,created_at,updated_at)
    VALUES (?,?,?,'file',?,?,?,?, 'UPLOADING',?,?)`).run(
      id, submission.id, session.userId, upload.id, encField(input.fileName), input.mimeType,
      input.totalBytes, now, now,
    );
  return { fileId: id, uploadId: upload.id, chunkSize: upload.chunkSize, chunkCount: upload.chunkCount };
}

export function ownedDesktopUpload(session: DesktopIntakeSession, submissionId: string, uploadId: string): DesktopSubmissionFile | null {
  const submission = getDesktopSubmission(submissionId, session.userId, session.id);
  return submission?.files.find((item) => item.uploadId === uploadId) || null;
}

export function markDesktopUploadAccepted(
  session: DesktopIntakeSession,
  submissionId: string,
  uploadId: string | null,
  documentId: string,
  kind: "file" | "text" = "file",
  contentHash: string | null = null,
): DesktopSubmissionFile {
  return markDesktopDocumentAccepted(session.userId, submissionId, uploadId, documentId, kind, session.id, contentHash);
}

export function markDesktopDocumentAccepted(
  userId: string,
  submissionId: string,
  uploadId: string | null,
  documentId: string,
  kind: "file" | "text" = "file",
  sessionId?: string,
  contentHash: string | null = null,
): DesktopSubmissionFile {
  const submission = getDesktopSubmission(submissionId, userId, sessionId);
  if (!submission || submission.stage !== "DRAFT") throw new Error("desktop_submission_not_found");
  const file = kind === "text"
    ? submission.files.find((item) => item.kind === "text")
    : submission.files.find((item) => item.uploadId === uploadId);
  if (!file) throw new Error("desktop_upload_not_found");
  if (file.documentId) return file;
  const child = createPersistentAgentTask(
    userId,
    "document_ingest",
    { title: file.fileName, documentId },
    "desktop",
    documentId,
    { parentTaskId: submission.agentTaskId },
  );
  transitionPersistentAgentTask(userId, child.id, "classified", "document_type_identified");
  transitionPersistentAgentTask(userId, child.id, "extracted", "document_goal_extracted");
  transitionPersistentAgentTask(userId, child.id, "executing", "document_processing_started");
  db.prepare(`UPDATE desktop_submission_files SET document_id=?,agent_task_id=?,content_hash=?,status='PROCESSING',updated_at=?
    WHERE id=? AND user_id=?`).run(documentId, child.id, contentHash, new Date().toISOString(), file.id, userId);
  return getDesktopSubmission(submissionId, userId, sessionId)!.files.find((item) => item.id === file.id)!;
}

export function markDesktopUploadFailed(userId: string, submissionId: string, uploadId: string | null, reason: string): void {
  db.prepare(`UPDATE desktop_submission_files SET status='FAILED',error=?,updated_at=?
    WHERE submission_id=? AND user_id=? AND ${uploadId ? "upload_id=?" : "kind='text'"}`)
    .run(...(uploadId
      ? [encField(reason.slice(0, 500)), new Date().toISOString(), submissionId, userId, uploadId]
      : [encField(reason.slice(0, 500)), new Date().toISOString(), submissionId, userId]));
}

export function commitDesktopSubmission(session: DesktopIntakeSession, submissionId: string): DesktopSubmission {
  const submission = getDesktopSubmission(submissionId, session.userId, session.id);
  if (!submission) throw new Error("desktop_submission_not_found");
  if (submission.stage !== "DRAFT") return submission;
  if (submission.files.length !== submission.expectedItemCount
    || submission.files.some((item) => !item.documentId || item.status === "FAILED")) {
    throw new Error("desktop_submission_incomplete");
  }
  transitionPersistentAgentTask(session.userId, submission.agentTaskId, "classified", "submission_classified");
  transitionPersistentAgentTask(session.userId, submission.agentTaskId, "extracted", "actions_inferred");
  transitionPersistentAgentTask(session.userId, submission.agentTaskId, "executing", "child_tasks_processing");
  const now = new Date().toISOString();
  db.prepare("UPDATE desktop_submissions SET stage='PROCESSING',committed_at=?,updated_at=? WHERE id=? AND user_id=?")
    .run(now, now, submission.id, session.userId);
  revokeDesktopIntakeSession(session.id, session.userId);
  refreshDesktopSubmission(session.userId, submission.id);
  return getDesktopSubmission(submission.id, session.userId)!;
}

export function refreshDesktopSubmission(userId: string, submissionId: string): DesktopSubmission | null {
  const submission = getDesktopSubmission(submissionId, userId);
  if (!submission || submission.stage === "DRAFT" || submission.stage === "COMPLETE" || submission.stage === "FAILED") return submission;
  const task = getPersistentAgentTask(submission.agentTaskId, userId);
  if (!task) return submission;
  const files = submission.files.map((file) => ({ ...file, document: file.documentId ? getDocument(file.documentId, userId) : null }));
  for (const file of files) {
    if (!file.agentTaskId || !file.document) continue;
    const child = getPersistentAgentTask(file.agentTaskId, userId);
    if (file.document.status === "COMPLETE" && child?.stage === "executing") {
      const result = file.document.result as { title?: string; summary?: string } | null;
      transitionPersistentAgentTask(userId, child.id, "verifying", "document_archived", result);
      verifyPersistentAgentTask(userId, child.id, {
        documentId: file.document.id,
        title: result?.title || file.document.fileName,
        summary: result?.summary || "资料已完成归档。",
      });
      db.prepare("UPDATE desktop_submission_files SET status='COMPLETE',updated_at=? WHERE id=? AND user_id=?")
        .run(new Date().toISOString(), file.id, userId);
    } else if (file.document.status === "FAILED") {
      if (child && child.stage !== "failed") transitionPersistentAgentTask(userId, child.id, "failed", file.document.error || "document_processing_failed");
      db.prepare("UPDATE desktop_submission_files SET status='FAILED',error=?,updated_at=? WHERE id=? AND user_id=?")
        .run(encField(file.document.error || "资料处理失败"), new Date().toISOString(), file.id, userId);
    }
  }
  const refreshed = getDesktopSubmission(submissionId, userId)!;
  const children = listChildAgentTasks(userId, refreshed.agentTaskId);
  if (refreshed.files.some((file) => file.status === "FAILED") || children.some((child) => child.stage === "failed")) {
    if (task.stage === "executing") transitionPersistentAgentTask(userId, task.id, "failed", "child_task_failed", ["部分资料处理失败，请在手机端查看并重试"]);
    db.prepare("UPDATE desktop_submissions SET stage='FAILED',updated_at=? WHERE id=? AND user_id=?")
      .run(new Date().toISOString(), refreshed.id, userId);
  } else if (refreshed.files.every((file) => file.status === "COMPLETE")
    && children.length === refreshed.expectedItemCount
    && children.every((child) => child.stage === "verified")) {
    const documents = refreshed.files.map((file) => getDocument(file.documentId!, userId)!);
    const result = {
      submissionId: refreshed.id,
      processedCount: documents.length,
      failedCount: 0,
      summary: documents.length === 1
        ? `已完成「${documents[0].fileName}」的归档和分析。`
        : `已完成 ${documents.length} 项资料的归档和联合整理。`,
      documentIds: documents.map((document) => document.id),
    };
    if (task.stage === "executing") transitionPersistentAgentTask(userId, task.id, "verifying", "all_child_tasks_verified", result);
    verifyPersistentAgentTask(userId, task.id, result);
    db.prepare("UPDATE desktop_submissions SET stage='COMPLETE',updated_at=? WHERE id=? AND user_id=?")
      .run(new Date().toISOString(), refreshed.id, userId);
  }
  return getDesktopSubmission(submissionId, userId);
}

export function refreshActiveDesktopSubmissions(userId: string): void {
  const rows = db.prepare("SELECT id FROM desktop_submissions WHERE user_id=? AND stage='PROCESSING' ORDER BY updated_at DESC LIMIT 20")
    .all(userId) as unknown as Array<{ id: string }>;
  for (const row of rows) refreshDesktopSubmission(userId, row.id);
}
