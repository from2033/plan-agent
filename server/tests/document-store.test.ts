import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-document-store-test-"));
process.env.DB_PATH = path.join(temporaryDir, "data.db");
process.env.DOCUMENT_UPLOAD_DIR = path.join(temporaryDir, "uploads");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const {
  appendDocumentNote,
  findDuplicateDocument,
  resolveDocumentEvidence,
  storeDocumentUpload,
} = await import("../src/document-store.js");

test("相同账号上传完全相同的文件时能找到已有资料", () => {
  const content = Buffer.from("same-family-document", "utf8");
  const stored = storeDocumentUpload("user-1", "药品.jpg", "image/jpeg", content, "第一次说明");
  const duplicate = findDuplicateDocument("user-1", content);
  assert.equal(duplicate?.id, stored.id);
  assert.equal(findDuplicateDocument("user-2", content), null);
  assert.equal(findDuplicateDocument("user-1", Buffer.from("different")), null);
  assert.deepEqual(stored.notes, ["第一次说明"]);
  assert.deepEqual(appendDocumentNote(stored.id, "user-1", "第二次说明")?.notes, [
    "第一次说明",
    "第二次说明",
  ]);
  assert.deepEqual(appendDocumentNote(stored.id, "user-1", "第二次说明")?.notes, [
    "第一次说明",
    "第二次说明",
  ]);
});

test("整理记录只有在关联原始资料属于同一账号时才能作为证据", () => {
  const original = storeDocumentUpload(
    "user-1",
    "核磁报告.jpg",
    "image/jpeg",
    Buffer.from("owned-report"),
  );
  assert.equal(
    resolveDocumentEvidence("user-1", crypto.randomUUID(), [original.id])?.sourceKind,
    "derived",
  );
  assert.equal(resolveDocumentEvidence("user-2", crypto.randomUUID(), [original.id]), null);
  assert.equal(resolveDocumentEvidence("user-1", crypto.randomUUID(), []), null);
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
