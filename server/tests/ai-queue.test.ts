import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-queue-test-"));
process.env.DB_PATH = path.join(temporaryDir, "queue.db");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const {
  claimAiJob,
  completeAiJob,
  enqueueAiJob,
  getAiJob,
} = await import("../src/ai-queue.js");

test("资料问题和回答在任务数据库中加密，读取时可正常解密", () => {
  const question = "租赁合同什么时候到期？";
  const job = enqueueAiJob("user-1", "document_question", { question });
  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const queued = inspection.prepare("SELECT input_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { input_json: string };
  assert.match(queued.input_json, /^enc1:/);
  assert.doesNotMatch(queued.input_json, /租赁合同/);

  const claimed = claimAiJob("test-worker");
  assert.equal((claimed?.job.input as { question: string }).question, question);
  const result = {
    answer: "合同约定于 2027-08-31 到期。",
    insufficientEvidence: false,
    sources: [{
      documentId: "2b472924-15cc-4676-8d3d-f5f947e574fa",
      title: "房屋租赁合同",
      category: "合同",
      vaultPath: "资料/合同/房屋租赁合同.md",
      excerpt: "租赁期限至 2027 年 8 月 31 日。",
      relatedDocumentIds: [],
    }],
  };
  completeAiJob(job.id, claimed!.leaseToken, result);
  const completed = inspection.prepare("SELECT result_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { result_json: string };
  assert.match(completed.result_json, /^enc1:/);
  assert.doesNotMatch(completed.result_json, /2027-08-31/);
  assert.deepEqual(getAiJob(job.id, "user-1")?.result, result);
  inspection.close();
});

test("用户对上传资料的补充说明在任务数据库中加密", () => {
  const job = enqueueAiJob("user-1", "document", {
    documentId: "2b472924-15cc-4676-8d3d-f5f947e574fa",
    userNote: "目前只能在一封大药房买到。",
  });
  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const queued = inspection.prepare("SELECT input_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { input_json: string };
  assert.match(queued.input_json, /^enc1:/);
  assert.doesNotMatch(queued.input_json, /一封大药房/);
  assert.equal(
    (getAiJob(job.id, "user-1")?.input as { userNote: string }).userNote,
    "目前只能在一封大药房买到。",
  );
  inspection.close();
});

test("统一提问任务保留家庭资料的原文证据", () => {
  const job = enqueueAiJob("user-1", "ingest", {
    raw: "租赁合同什么时候到期？",
  }, 200);
  const claimed = claimAiJob("test-worker");
  const result = {
    kind: "ask" as const,
    answer: "合同于 2027 年 8 月 31 日到期。",
    sourceIds: [],
    documentSources: [{
      documentId: "2b472924-15cc-4676-8d3d-f5f947e574fa",
      title: "房屋租赁合同",
      category: "合同",
      vaultPath: "资料/合同/房屋租赁合同.md",
      excerpt: "租赁期限至 2027 年 8 月 31 日。",
      relatedDocumentIds: [],
    }],
  };
  completeAiJob(job.id, claimed!.leaseToken, result);
  assert.deepEqual(getAiJob(job.id, "user-1")?.result, result);
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
