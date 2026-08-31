/**
 * Personal Agent 的统一任务契约。
 * 每项能力都必须把“做什么”和“怎样算完成”显式化，避免只生成文字却没有闭环。
 */
export type AgentStage = "received" | "classified" | "extracted" | "awaiting_confirmation" | "executing" | "verified" | "follow_up" | "failed";

export interface AcceptanceCheck {
  id: string;
  description: string;
  check: (result: unknown) => boolean;
}

export interface AgentTask<TInput = unknown, TResult = unknown> {
  id: string;
  capability: string;
  input: TInput;
  stage: AgentStage;
  requiresConfirmation: boolean;
  acceptance: AcceptanceCheck[];
  result?: TResult;
  failures: string[];
}

export function createAgentTask<TInput, TResult>(params: {
  id: string;
  capability: string;
  input: TInput;
  requiresConfirmation?: boolean;
  acceptance: AcceptanceCheck[];
}): AgentTask<TInput, TResult> {
  return {
    id: params.id,
    capability: params.capability,
    input: params.input,
    stage: "received",
    requiresConfirmation: params.requiresConfirmation ?? true,
    acceptance: params.acceptance,
    failures: [],
  };
}

export function verifyAgentTask<TInput, TResult>(task: AgentTask<TInput, TResult>, result: TResult): AgentTask<TInput, TResult> {
  const failures = task.acceptance.filter((item) => !item.check(result)).map((item) => item.description);
  return { ...task, result, failures, stage: failures.length ? "failed" : "verified" };
}
