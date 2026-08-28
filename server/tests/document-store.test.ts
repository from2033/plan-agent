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
  readDocumentUpload,
  resolveDocumentEvidence,
  registerLocalDocument,
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

test("录音原文只能由所属账号完整读取", () => {
  const content = Buffer.from("fake-wav-audio", "utf8");
  const stored = storeDocumentUpload("user-1", "会议.wav", "audio/wav", content);
  assert.deepEqual(readDocumentUpload(stored.id, "user-1")?.content, content);
  assert.equal(readDocumentUpload(stored.id, "user-2"), null);
});

test("Mac 本地资料可幂等登记且不会保存原始文件内容", () => {
  const id = crypto.randomUUID();
  const registration = {
    documentId: id,
    fileName: "杜茂才.zip",
    mimeType: "application/zip",
    byteSize: 123456,
    vaultPath: "资料/医疗健康/杜茂才-DICOM.md",
    result: {
      documentId: id,
      title: "杜茂才核磁 DICOM 原始影像",
      category: "医疗健康",
      summary: "原始 DICOM 影像压缩包，仅保存在家庭 Mac。",
      people: ["杜茂才"],
      keywords: ["DICOM", "核磁共振"],
      documentDate: "2026-08-21",
      vaultPath: "资料/医疗健康/杜茂才-DICOM.md",
      attachmentPath: "附件/2026/2026-08/杜茂才.zip",
      textLength: 0,
      warnings: [],
    },
  };
  const first = registerLocalDocument("user-1", registration);
  const second = registerLocalDocument("user-1", { ...registration, byteSize: 654321 });
  assert.equal(first.id, second.id);
  assert.equal(second.byteSize, 654321);
  assert.equal(second.storageKind, "local");
  assert.equal(fs.existsSync(path.join(temporaryDir, "uploads", `${id}.paf`)), false);
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
