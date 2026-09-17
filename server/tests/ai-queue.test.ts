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
  classifyCodexFailure,
  claimAiJob,
  completeAiJob,
  enqueueAiJob,
  failAiJob,
  findBestAiJobContextForAgentTask,
  getAiJob,
  getLatestAiJob,
  laneForKind,
  retryDelayMinutes,
} = await import("../src/ai-queue.js");

test("Agent 重试恢复最完整的原始聊天上下文，而不是采用最近一次盲重试", () => {
  const userId = `retry-context-${Date.now()}`;
  const agentTaskId = crypto.randomUUID();
  enqueueAiJob(userId, "ingest", {
    raw: "请用表格整理",
    agentTaskId,
    interactionMode: "conversation",
    conversationId: crypto.randomUUID(),
    conversationHistory: [
      { role: "user", content: "数码订阅是什么" },
      { role: "assistant", content: "最近共有 30 笔。" },
    ],
  });
  enqueueAiJob(userId, "ingest", {
    raw: "请用表格整理",
    agentTaskId,
    interactionMode: "home",
  });
  const recovered = findBestAiJobContextForAgentTask(userId, agentTaskId);
  assert.equal(recovered?.conversationHistory.length, 2);
  assert.equal(recovered?.interactionMode, "conversation");
  assert.ok(recovered?.conversationId);
  for (let index = 0; index < 2; index += 1) {
    const claimed = claimAiJob(`retry-context-cleanup-${index}`);
    assert.ok(claimed);
    failAiJob(claimed!.job.id, claimed!.leaseToken, "test cleanup", false);
  }
});

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

test("工单执行上下文在任务数据库中加密", () => {
  const job = enqueueAiJob("user-1", "feedback_repair", {
    ticketId: crypto.randomUUID(),
    description: "刚才的表格没有使用上一轮回答，请直接重新处理。",
    conversationContext: {
      conversationHistory: [{ role: "assistant", content: "上一轮包含家庭账单明细。" }],
    },
  });
  const inspection = new DatabaseSync(process.env.DB_PATH!);
  const queued = inspection.prepare("SELECT input_json FROM ai_jobs WHERE id=?")
    .get(job.id) as unknown as { input_json: string };
  assert.match(queued.input_json, /^enc1:/);
  assert.doesNotMatch(queued.input_json, /家庭账单明细/);
  assert.match(JSON.stringify(getAiJob(job.id, "user-1")?.input), /家庭账单明细/);
  const claimed = claimAiJob("feedback-encryption-cleanup");
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
    conversationTitle: "租赁合同到期时间",
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
    radar: [
      { id: "gold", hasReliableSignal: false, summary: "今天没有足够可靠的新信号。" },
      { id: "housing", hasReliableSignal: true, summary: "住房金融政策出现需要继续核验的新变化。" },
      { id: "ai", hasReliableSignal: false, summary: "今天没有足够可靠的新信号。" },
      { id: "programmer", hasReliableSignal: false, summary: "今天没有足够可靠的新信号。" },
      { id: "policy", hasReliableSignal: true, summary: "住房政策仍处于公开讨论阶段。" },
      { id: "international", hasReliableSignal: false, summary: "今天没有足够可靠的新信号。" },
    ],
    events: [{
      sectionId: "china_policy_preview",
      title: "个人住房贷款期限调整进入公开讨论",
      summary: "媒体报道了调整方向，但尚未找到正式生效文件。",
      whyItMatters: "可能影响月供和总利息。",
      watchNext: "等待监管部门正式文件。",
      verification: "single_source",
      sourceIndexes: [0],
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

test("队列按交互、用户后台、维护顺序取任务", () => {
  const maintenance = enqueueAiJob("lane-user", "summary", { entries: [] }, 999);
  const background = enqueueAiJob("lane-user", "document", { documentId: crypto.randomUUID() }, 999);
  const interactive = enqueueAiJob("lane-user", "ingest", { raw: "现在回答我" }, 1);
  assert.equal(laneForKind(maintenance.kind), "maintenance");
  assert.equal(laneForKind(background.kind), "user_background");
  assert.equal(laneForKind(interactive.kind), "interactive");

  const first = claimAiJob("lane-worker-1");
  assert.equal(first?.job.id, interactive.id);
  assert.equal(claimAiJob("another-worker"), null, "已有 Codex 任务运行时必须全局单并发");
  failAiJob(first!.job.id, first!.leaseToken, "test cleanup", false);
  const second = claimAiJob("lane-worker-2");
  assert.equal(second?.job.id, background.id);
  failAiJob(second!.job.id, second!.leaseToken, "test cleanup", false);
  const third = claimAiJob("lane-worker-3");
  assert.equal(third?.job.id, maintenance.id);
  failAiJob(third!.job.id, third!.leaseToken, "test cleanup", false);
});

test("五十个文档任务不会堵住新交互问题", () => {
  const documents = Array.from({ length: 50 }, (_, index) =>
    enqueueAiJob("stress-user", "document", {
      documentId: crypto.randomUUID(),
      fileName: `批量资料-${index}.pdf`,
    }, 200));
  const question = enqueueAiJob("stress-user", "ingest", { raw: "一个简单问题" }, 1);
  const claimed = claimAiJob("stress-worker");
  assert.equal(claimed?.job.id, question.id);
  failAiJob(question.id, claimed!.leaseToken, "test cleanup", false);
  for (const document of documents) {
    const next = claimAiJob(`stress-cleanup-${document.id}`);
    assert.ok(next);
    failAiJob(next!.job.id, next!.leaseToken, "test cleanup", false);
  }
});

test("Codex 临时异常进入熔断和分级退避，不立即重发完整任务", () => {
  assert.equal(classifyCodexFailure("usage limit exceeded"), "quota");
  assert.equal(classifyCodexFailure("fetch failed ECONNRESET"), "network");
  assert.deepEqual([1, 2, 3, 4, 9].map(retryDelayMinutes), [1, 5, 15, 60, 60]);

  const startedAt = new Date();
  const job = enqueueAiJob("deferred-user", "ingest", { raw: "保留这个问题" });
  const claimed = claimAiJob("deferred-worker", startedAt);
  assert.equal(claimed?.job.id, job.id);
  failAiJob(job.id, claimed!.leaseToken, "network timeout", true);
  const deferred = getAiJob(job.id, "deferred-user");
  assert.equal(deferred?.status, "DEFERRED");
  assert.equal(deferred?.errorKind, "network");
  const availableAt = new Date(deferred!.availableAt!);
  assert.ok(availableAt.getTime() >= startedAt.getTime() + 59_000);
  assert.equal(claimAiJob("too-early", new Date(startedAt.getTime() + 30_000)), null);
  const resumed = claimAiJob("resume-worker", new Date(availableAt.getTime() + 1_000));
  assert.equal(resumed?.job.id, job.id);
  failAiJob(job.id, resumed!.leaseToken, "test cleanup", false);
});

test("Codex 额度耗尽即使超过重试上限也等到额度恢复，不永久失败", () => {
  const previousMaxAttempts = process.env.CODEX_WORKER_MAX_ATTEMPTS;
  process.env.CODEX_WORKER_MAX_ATTEMPTS = "1";
  try {
    const job = enqueueAiJob("quota-user", "document", { fileName: "待处理.pdf" });
    const claimed = claimAiJob("quota-worker", new Date(Date.now() + 2 * 60 * 60_000));
    assert.equal(claimed?.job.id, job.id);
    const retryAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    failAiJob(job.id, claimed!.leaseToken, "codex_quota_exhausted", true, retryAt);
    const deferred = getAiJob(job.id, "quota-user");
    assert.equal(deferred?.status, "DEFERRED");
    assert.equal(deferred?.errorKind, "quota");
    assert.equal(deferred?.availableAt, retryAt);
  } finally {
    if (previousMaxAttempts === undefined) delete process.env.CODEX_WORKER_MAX_ATTEMPTS;
    else process.env.CODEX_WORKER_MAX_ATTEMPTS = previousMaxAttempts;
  }
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
