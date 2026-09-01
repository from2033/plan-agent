import assert from "node:assert/strict";
import test from "node:test";

import {
  createFeedbackTicket,
  dueFeedbackTickets,
  getFeedbackTicket,
  listFeedbackTicketEvents,
  transitionFeedbackTicket,
} from "../src/feedback-tickets.js";
import { registeredCapabilities } from "../src/agent-contract.js";
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
  assert.ok(!dueFeedbackTickets(new Date()).some(item => item.id === ticket.id));
  assert.ok(dueFeedbackTickets(new Date(Date.now() + 120_000)).some(item => item.id === ticket.id));
});

test("反馈工单能力公开确认、重试和关闭验收契约", () => {
  const standard = registeredCapabilities().find(item => item.capability === "feedback_ticket");
  assert.equal(standard?.version, "1.0");
  assert.match(standard?.confirmationPolicy || "", /主账号/);
  assert.match(standard?.retryPolicy || "", /额度/);
  assert.match(standard?.followUpPolicy || "", /关闭/);
});
