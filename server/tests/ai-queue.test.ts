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
  failAiJob,
  getAiJob,
  getLatestAiJob,
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
  const claimed = claimAiJob("test-worker");
  assert.equal(claimed?.job.id, job.id);
  failAiJob(job.id, claimed!.leaseToken, "test cleanup", false);
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

test("全球趋势分析输入和结果加密存储且结构受校验", () => {
  const job = enqueueAiJob("world-pulse-system", "world_pulse", {
    fingerprint: "today",
    sections: [{ id: "gold_impact", headlines: [{ title: "美元走强" }] }],
  }, 55);
  const claimed = claimAiJob("test-worker");
  assert.equal(claimed?.job.id, job.id);
  const result = {
    overview: "今天主要观察美元和利率变化。",
    sections: [{
      id: "gold_impact",
      summary: "美元走强可能给黄金带来短期压力。",
      impact: "这是影响金价的一个因素，但不能单独决定走势。",
      outlook: "继续看利率和避险需求是否同向变化。",
      action: "无需行动，继续观察。",
    }],
  };
  completeAiJob(job.id, claimed!.leaseToken, result);
  assert.deepEqual(getAiJob(job.id, "world-pulse-system")?.result, result);
});

test("每日全网巡检结果加密保存并可按类型读取最新任务", () => {
  const job = enqueueAiJob("world-pulse-system", "world_discovery", {
    dayKey: "2026-08-29",
    knownHeadlines: [],
  }, 60);
  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const queued = inspection.prepare("SELECT input_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { input_json: string };
  assert.match(queued.input_json, /^enc1:/);
  const claimed = claimAiJob("test-worker");
  assert.equal(claimed?.job.id, job.id);
  const result = {
    overview: "补充发现一条需要核验的住房政策变化。",
    events: [{
      sectionId: "china_policy_preview",
      title: "个人住房贷款期限调整进入公开讨论",
      summary: "媒体报道了调整方向，但尚未找到正式生效文件。",
      whyItMatters: "可能影响月供和总利息。",
      watchNext: "等待监管部门正式文件。",
      verification: "single_source",
      sources: [{
        title: "相关报道",
        publisher: "示例媒体",
        url: "https://example.com/housing",
        publishedAt: "2026-08-29T01:00:00.000Z",
      }],
    }],
    discoveredAt: "2026-08-29T02:00:00.000Z",
  };
  completeAiJob(job.id, claimed!.leaseToken, result);
  assert.deepEqual(getLatestAiJob("world-pulse-system", "world_discovery")?.result, result);
  inspection.close();
});

test("研究主题和报告加密存储且必须有可核对来源", () => {
  const job = enqueueAiJob("user-1", "research", {
    reportId: "2b472924-15cc-4676-8d3d-f5f947e574fa",
    query: "湿疹是怎么回事",
  }, 70);
  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const queued = inspection.prepare("SELECT input_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { input_json: string };
  assert.match(queued.input_json, /^enc1:/);
  assert.doesNotMatch(queued.input_json, /湿疹/);
  const claimed = claimAiJob("test-worker");
  assert.equal(claimed?.job.id, job.id);
  const result = {
    title: "湿疹原理与日常调整",
    topicType: "medical",
    executiveSummary: "湿疹是一类常见的炎症性皮肤问题。",
    keyTakeaways: ["与皮肤屏障和免疫反应有关"],
    sections: [
      { heading: "原理", content: "皮肤屏障受损可能参与其中。" },
      { heading: "调整", content: "注意保湿并识别刺激因素。" },
    ],
    practicalActions: ["记录可能诱因"],
    cautions: ["不替代个人诊断"],
    sources: [
      { title: "Eczema", publisher: "WHO", url: "https://www.who.int/health-topics/eczema", publishedAt: "" },
      { title: "Atopic dermatitis", publisher: "NHS", url: "https://www.nhs.uk/conditions/atopic-eczema/", publishedAt: "" },
    ],
    researchedAt: "2026-08-28T14:00:00.000Z",
  };
  completeAiJob(job.id, claimed!.leaseToken, result);
  assert.deepEqual(getAiJob(job.id, "user-1")?.result, result);
  inspection.close();
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
