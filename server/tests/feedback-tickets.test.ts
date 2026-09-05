import assert from "node:assert/strict";
import test from "node:test";

import {
  auditStaleFeedbackTickets,
  claimFeedbackTicketProcessing,
  createFeedbackTicket,
  dueFeedbackTickets,
  getFeedbackTicket,
  listFeedbackTicketEvents,
  transitionFeedbackTicket,
  updateFeedbackAnalysis,
} from "../src/feedback-tickets.js";
import { registeredCapabilities } from "../src/agent-contract.js";
import { enqueueAiJob } from "../src/ai-queue.js";
import "../src/agent-standards.js";

test("反馈工单保存账号、状态和完整处理事件", () => {
  const userId = `feedback-owner-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, {
    title: "明日管家漏项",
    description: "截图中有两本作业本，结果只显示一本",
  });
  assert.equal(ticket.status, "draft");
  assert.equal(getFeedbackTicket(ticket.id, "other-user", "primary"), null);
  assert.equal(getFeedbackTicket(ticket.id, "primary", "primary")?.id, ticket.id);

  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  transitionFeedbackTicket(ticket.id, "triaging", "triage_started", "开始分析");
  transitionFeedbackTicket(ticket.id, "awaiting_confirmation", "confirmation_requested", "等待确认", {
    plan: { proposedPlan: ["增加覆盖检查"] },
    acceptanceChecks: ["两本作业本均出现"],
    confirmationQuestion: "是否允许修改验收标准？",
  });
  const pending = getFeedbackTicket(ticket.id, userId, "primary");
  assert.equal(pending?.status, "awaiting_confirmation");
  assert.deepEqual(pending?.acceptanceChecks, ["两本作业本均出现"]);
  assert.ok(listFeedbackTicketEvents(ticket.id, userId, "primary").length >= 4);
});

test("额度不足的反馈会延期，并在到期后重新进入待处理集合", () => {
  const userId = `feedback-quota-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { title: "额度恢复后继续", description: "处理时额度不足" });
  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  transitionFeedbackTicket(ticket.id, "deferred", "retry_scheduled", "额度不足，稍后继续", { nextAttemptAt: retryAt });
  assert.ok(!dueFeedbackTickets(new Date(), 5_000).some(item => item.id === ticket.id));
  assert.ok(dueFeedbackTickets(new Date(Date.now() + 120_000), 5_000).some(item => item.id === ticket.id));
});

test("蓝绿实例同时续办同一工单时只有一个实例能原子认领", () => {
  const userId = `feedback-claim-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { title: "并发续办", description: "避免重复执行" });
  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  const deferred = transitionFeedbackTicket(ticket.id, "deferred", "retry_scheduled", "稍后续办", {
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  })!;
  assert.equal(claimFeedbackTicketProcessing(deferred)?.status, "processing");
  assert.equal(claimFeedbackTicketProcessing(deferred), null);
});

test("反馈工单能力公开确认、重试和关闭验收契约", () => {
  const standard = registeredCapabilities().find(item => item.capability === "feedback_ticket");
  assert.equal(standard?.version, "1.1");
  assert.match(standard?.confirmationPolicy || "", /主账号/);
  assert.match(standard?.retryPolicy || "", /额度/);
  assert.match(standard?.followUpPolicy || "", /完整历史/);
});

test("新工单可跳过只分析阶段直接进入实际处理", () => {
  const userId = `feedback-direct-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { title: "消息没有同步", description: "请直接检查并恢复" });
  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  const processing = transitionFeedbackTicket(ticket.id, "processing", "repair_started", "正在实际处理");
  assert.equal(processing?.status, "processing");
  assert.ok(listFeedbackTicketEvents(ticket.id, userId, "primary")
    .some((event: any) => event.eventType === "repair_started"));
});

test("已解决工单可由用户确认关闭或报告仍有问题后重新处理", () => {
  const userId = `feedback-satisfaction-${Date.now()}`;
  const satisfied = createFeedbackTicket(userId, { title: "确认解决", description: "修复结果需要用户确认" });
  transitionFeedbackTicket(satisfied.id, "resolved", "machine_resolved", "机器验收通过");
  assert.equal(transitionFeedbackTicket(satisfied.id, "closed", "user_satisfied", "用户确认解决")?.status, "closed");

  const unresolved = createFeedbackTicket(userId, { title: "仍有问题", description: "用户发现修复不完整" });
  transitionFeedbackTicket(unresolved.id, "resolved", "machine_resolved", "机器验收通过");
  assert.equal(transitionFeedbackTicket(unresolved.id, "processing", "user_unsatisfied", "重新打开")?.status, "processing");
});

test("无标题反馈由 Agent 自动生成标题、摘要、计划和验收标准", () => {
  const userId = `feedback-auto-summary-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, {
    transcript: "首页一直显示处理记录，把下面内容挡住了。",
    context: { page: "home", appVersion: "1.0.0", requestId: "request-1" },
  });
  assert.match(ticket.title, /首页一直显示处理记录/);
  assert.equal(ticket.context.requestId, "request-1");
  const analyzed = updateFeedbackAnalysis(ticket.id, {
    ticketTitle: "首页处理记录遮挡内容",
    issueSummary: "首页状态卡持续占据主要区域。",
    reproductionClues: ["打开首页"],
    proposedPlan: ["只显示当前任务"],
    acceptanceChecks: ["无任务时状态卡隐藏"],
  });
  assert.equal(analyzed?.title, "首页处理记录遮挡内容");
  assert.deepEqual(analyzed?.acceptanceChecks, ["无任务时状态卡隐藏"]);
});

test("处理或验收超过心跳期限的历史工单自动延期续办", () => {
  const userId = `feedback-watchdog-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { transcript: "这个工单不要永久卡住" });
  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  transitionFeedbackTicket(ticket.id, "processing", "started", "处理中");
  const future = new Date(Date.now() + 16 * 60_000);
  const repaired = auditStaleFeedbackTickets(future, 15);
  assert.ok(repaired.some(item => item.id === ticket.id && item.status === "deferred"));
  assert.equal(getFeedbackTicket(ticket.id, userId, "primary")?.nextAttemptAt, future.toISOString());
});

test("关联队列仍在等待或执行时看门狗不会重复排反馈任务", () => {
  const userId = `feedback-active-job-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { title: "等待额度", description: "队列仍有效" });
  transitionFeedbackTicket(ticket.id, "submitted", "submitted", "已提交");
  const job = enqueueAiJob(userId, "feedback_repair", { ticketId: ticket.id });
  transitionFeedbackTicket(ticket.id, "processing", "repair_started", "已排队", { jobId: job.id });
  const audited = auditStaleFeedbackTickets(new Date(Date.now() + 20 * 60_000));
  assert.ok(audited.every((item) => item.id !== ticket.id));
});
