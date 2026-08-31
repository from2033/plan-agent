import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "daynote-desktop-intake-"));
process.env.DB_PATH = path.join(temporaryDir, "data.db");
process.env.DOCUMENT_UPLOAD_DIR = path.join(temporaryDir, "documents");
process.env.DOCUMENT_CHUNK_UPLOAD_DIR = path.join(temporaryDir, "chunks");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const intake = await import("../src/desktop-intake.js");
const { chunkedUploadStore } = await import("../src/chunked-upload.js");
const { completeDocument, storeDocumentUpload } = await import("../src/document-store.js");
const { getPersistentAgentTask, listChildAgentTasks } = await import("../src/agent-runtime.js");

function completedResult(documentId: string, title: string) {
  return {
    documentId,
    title,
    category: "其他",
    summary: `${title}摘要`,
    people: [],
    keywords: [],
    documentDate: "",
    vaultPath: `资料/${title}.md`,
    attachmentPath: `附件/${title}.txt`,
    textLength: 10,
    warnings: [],
    suggestedActions: [],
  };
}

test("多文件与粘贴文字形成父子任务，全部验收通过后父任务才完成", () => {
  const session = intake.createDesktopIntakeSession("owner", "Mac · Safari");
  const submission = intake.createDesktopSubmission(session, {
    instruction: "整理这些资料并判断后续动作",
    pastedText: "这是一段补充文字",
    expectedFileCount: 1,
    idempotencyKey: "desktop-batch-001",
  });
  assert.equal(submission.expectedItemCount, 2);
  assert.equal(getPersistentAgentTask(submission.agentTaskId, "owner")?.stage, "received");

  const content = Buffer.from("first document", "utf8");
  const upload = intake.createDesktopSubmissionUpload(session, submission.id, {
    fileName: "资料.txt",
    mimeType: "text/plain",
    totalBytes: content.length,
  });
  chunkedUploadStore.writeChunk("owner", upload.uploadId, 0, content);
  const assembled = chunkedUploadStore.assemble("owner", upload.uploadId);
  const firstDocument = storeDocumentUpload("owner", assembled.metadata.fileName, assembled.metadata.mimeType, assembled.content);
  const firstHash = crypto.createHash("sha256").update(content).digest("hex");
  intake.markDesktopUploadAccepted(session, submission.id, upload.uploadId, firstDocument.id, "file", firstHash);
  completeDocument(firstDocument.id, "owner", completedResult(firstDocument.id, "资料一"));

  const textDocument = storeDocumentUpload("owner", "电脑粘贴文字.txt", "text/plain", Buffer.from(submission.pastedText));
  intake.markDesktopUploadAccepted(session, submission.id, null, textDocument.id, "text");
  completeDocument(textDocument.id, "owner", completedResult(textDocument.id, "补充文字"));

  const committed = intake.commitDesktopSubmission(session, submission.id);
  assert.equal(committed.stage, "COMPLETE");
  assert.equal(intake.resolveDesktopIntakeSession(session.token), null);
  assert.equal(getPersistentAgentTask(submission.agentTaskId, "owner")?.stage, "verified");
  assert.equal(listChildAgentTasks("owner", submission.agentTaskId).length, 2);
  assert.ok(listChildAgentTasks("owner", submission.agentTaskId).every((task) => task.stage === "verified"));
  assert.equal(intake.getDesktopSubmission(submission.id, "owner")?.files.find((file) => file.kind === "file")?.contentHash, firstHash);
});

test("未上传完整时禁止提交，跨账号与重复提交保持隔离和幂等", () => {
  const session = intake.createDesktopIntakeSession("owner", "Windows · Edge");
  const first = intake.createDesktopSubmission(session, {
    instruction: "",
    pastedText: "",
    expectedFileCount: 1,
    idempotencyKey: "desktop-batch-002",
  });
  const repeated = intake.createDesktopSubmission(session, {
    instruction: "不会覆盖原任务",
    pastedText: "",
    expectedFileCount: 1,
    idempotencyKey: "desktop-batch-002",
  });
  assert.equal(repeated.id, first.id);
  assert.equal(intake.getDesktopSubmission(first.id, "other"), null);
  assert.throws(() => intake.commitDesktopSubmission(session, first.id), /desktop_submission_incomplete/);

  const firstUpload = intake.createDesktopSubmissionUpload(session, first.id, {
    fileName: "可重试.txt", mimeType: "text/plain", totalBytes: 10,
  });
  intake.markDesktopUploadFailed("owner", first.id, firstUpload.uploadId, "网络中断");
  const retriedUpload = intake.createDesktopSubmissionUpload(session, first.id, {
    fileName: "可重试.txt", mimeType: "text/plain", totalBytes: 10,
  });
  assert.notEqual(retriedUpload.uploadId, firstUpload.uploadId);
  assert.equal(retriedUpload.fileId, firstUpload.fileId);
});

test.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
