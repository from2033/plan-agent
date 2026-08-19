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
  findDuplicateDocument,
  storeDocumentUpload,
} = await import("../src/document-store.js");

test("相同账号上传完全相同的文件时能找到已有资料", () => {
  const content = Buffer.from("same-family-document", "utf8");
  const stored = storeDocumentUpload("user-1", "药品.jpg", "image/jpeg", content);
  const duplicate = findDuplicateDocument("user-1", content);
  assert.equal(duplicate?.id, stored.id);
  assert.equal(findDuplicateDocument("user-2", content), null);
  assert.equal(findDuplicateDocument("user-1", Buffer.from("different")), null);
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
