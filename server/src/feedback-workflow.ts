import type { AgentRetryContext } from "./ai-queue.js";
import type { PersistedAgentTask } from "./agent-runtime.js";
import type { FeedbackTicket } from "./feedback-tickets.js";

type FeedbackExecutionOptions = {
  sourceTask: PersistedAgentTask | null;
  sourceTaskEvents: unknown[];
  recoveredContext: AgentRetryContext | null;
  ticketEvents: unknown[];
  confirmedByPrimary?: boolean;
};

function storedConversationContext(task: PersistedAgentTask | null): AgentRetryContext | null {
  if (!task || !task.input || typeof task.input !== "object") return null;
  const input = task.input as {
    conversationId?: unknown;
    conversationHistory?: unknown;
    interactionMode?: unknown;
  };
  const conversationHistory = Array.isArray(input.conversationHistory)
    ? input.conversationHistory.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const conversationId = typeof input.conversationId === "string" && input.conversationId
    ? input.conversationId
    : null;
  if (!conversationHistory.length && !conversationId) return null;
  return {
    conversationId,
    conversationHistory,
    interactionMode: typeof input.interactionMode === "string" ? input.interactionMode : "conversation",
  };
}

export function buildFeedbackExecutionInput(
  ticket: FeedbackTicket,
  options: FeedbackExecutionOptions,
): Record<string, unknown> {
  const conversationContext = storedConversationContext(options.sourceTask) || options.recoveredContext;
  return {
    ticketId: ticket.id,
    title: ticket.title,
    description: ticket.description,
    sourceTaskId: ticket.sourceTaskId,
    attachmentIds: ticket.attachments.map(item => item.id),
    handlingMode: "direct_execution",
    handlingInstruction: "像持续对话一样直接处理并验证问题；只在不可逆、高风险或缺少关键选择时请求确认",
    plan: ticket.plan,
    acceptanceChecks: ticket.acceptanceChecks,
    previousResolution: ticket.resolution,
    attempt: ticket.attempts + 1,
    confirmation: {
      grantedByPrimary: Boolean(options.confirmedByPrimary),
      question: ticket.confirmationQuestion,
    },
    sourceTask: options.sourceTask ? {
      id: options.sourceTask.id,
      capability: options.sourceTask.capability,
      standardVersion: options.sourceTask.standardVersion,
      stage: options.sourceTask.stage,
      input: options.sourceTask.input,
      result: options.sourceTask.result,
      failures: options.sourceTask.failures,
      failedChecks: options.sourceTask.failedChecks,
      events: options.sourceTaskEvents,
    } : null,
    conversationContext,
    ticketEvents: options.ticketEvents,
  };
}
