import assert from "node:assert/strict";
import test from "node:test";

import { buildFeedbackExecutionInput } from "../src/feedback-workflow.js";
import type { PersistedAgentTask } from "../src/agent-runtime.js";
import type { FeedbackTicket } from "../src/feedback-tickets.js";

const ticket = {
  id: "ticket-1", userId: "owner", title: "表格处理失败", description: "请直接按上一轮内容重新整理",
  sourceTaskId: "task-1", agentTaskId: null, jobId: null, status: "processing", priority: "normal",
  plan: null, acceptanceChecks: [], resolution: null, confirmationQuestion: "是否允许执行关键步骤？",
  attempts: 1, nextAttemptAt: null, attachments: [], createdAt: "2026-09-02T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z", closedAt: null,
} satisfies FeedbackTicket;

const sourceTask = {
  id: "task-1", userId: "owner", capability: "input_processing", standardVersion: "1.2",
  sourceType: "text", sourceId: null,
  input: { raw: "请用表格整理", conversationId: "conversation-1", conversationHistory: [
    { role: "user", content: "数码订阅有哪些" },
    { role: "assistant", content: "共有三类消费。" },
  ] },
  stage: "failed", requiresConfirmation: false, result: null, failures: ["requested-format"],
  parentTaskId: null, rootTaskId: null, passedChecks: [], failedChecks: ["requested-format"],
  acceptanceStatus: "failed", acceptanceDetails: [], validatorVersion: "2.0", nextAction: null,
  nextFollowUpAt: null, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
} satisfies PersistedAgentTask;

test("工单执行输入携带原任务、完整对话和处理事件", () => {
  const input = buildFeedbackExecutionInput(ticket, {
    sourceTask,
    sourceTaskEvents: [{ reason: "requested-format" }],
    recoveredContext: null,
    ticketEvents: [{ eventType: "submitted" }],
  }) as any;
  assert.equal(input.handlingMode, "direct_execution");
  assert.equal(input.sourceTask.failures[0], "requested-format");
  assert.equal(input.conversationContext.conversationHistory.length, 2);
  assert.equal(input.ticketEvents[0].eventType, "submitted");
  assert.equal(input.confirmation.grantedByPrimary, false);
});

test("主账号确认后在同一工单上下文中继续执行", () => {
  const input = buildFeedbackExecutionInput(ticket, {
    sourceTask,
    sourceTaskEvents: [],
    recoveredContext: null,
    ticketEvents: [],
    confirmedByPrimary: true,
  }) as any;
  assert.equal(input.confirmation.grantedByPrimary, true);
  assert.equal(input.confirmation.question, "是否允许执行关键步骤？");
});
