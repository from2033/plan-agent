import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DB_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("base64");

const { ChunkedUploadStore, DOCUMENT_UPLOAD_CHUNK_SIZE } = await import("../src/chunked-upload.js");

test("长录音分片上传后按原顺序合并", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-chunk-upload-test-"));
  try {
    const store = new ChunkedUploadStore(root);
    const content = crypto.randomBytes(DOCUMENT_UPLOAD_CHUNK_SIZE + 1234);
    const transcript = "班会转写".repeat(800);
    const upload = store.create("user-1", {
      fileName: "班会.wav",
      mimeType: "audio/wav",
      userNote: transcript,
      totalBytes: content.length,
    });
    store.writeChunk("user-1", upload.id, 1, content.subarray(DOCUMENT_UPLOAD_CHUNK_SIZE));
    store.writeChunk("user-1", upload.id, 0, content.subarray(0, DOCUMENT_UPLOAD_CHUNK_SIZE));
    const assembled = store.assemble("user-1", upload.id);
    assert.deepEqual(assembled.content, content);
    assert.equal(assembled.metadata.userNote, transcript);
    store.remove("user-1", upload.id);
    assert.equal(fs.existsSync(path.join(root, upload.id)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("缺少分片或跨账号读取时拒绝合并", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-chunk-upload-test-"));
  try {
    const store = new ChunkedUploadStore(root);
    const upload = store.create("user-1", {
      fileName: "长会议.wav",
      mimeType: "audio/wav",
      totalBytes: DOCUMENT_UPLOAD_CHUNK_SIZE + 1,
    });
    store.writeChunk("user-1", upload.id, 0, Buffer.alloc(DOCUMENT_UPLOAD_CHUNK_SIZE));
    assert.throws(() => store.assemble("user-1", upload.id), /upload_incomplete/);
    assert.throws(() => store.assemble("user-2", upload.id), /upload_not_found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("分片大小必须与会话声明严格一致", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-chunk-upload-test-"));
  try {
    const store = new ChunkedUploadStore(root);
    const upload = store.create("user-1", {
      fileName: "会议.wav",
      mimeType: "audio/wav",
      totalBytes: 10,
    });
    assert.throws(() => store.writeChunk("user-1", upload.id, 0, Buffer.alloc(9)), /invalid_chunk_size/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
