import { registerCapabilityStandard } from "./agent-contract.js";

registerCapabilityStandard({
  capability: "tomorrow_brief",
  version: "1.2",
  description: "明日管家必须逐项覆盖所有明确的准备事项",
  requiresConfirmation: false,
  allowedSideEffects: ["publish_brief"],
  failurePolicy: "retry",
  acceptance: (input) => [{
    id: "source-coverage",
    description: "原始事项全部出现在最终清单",
    check: (result) => {
      const required = (input as { required?: string[] }).required || [];
      const checklist = ((result as { checklist?: string[] }).checklist || []).map((item) => item.replace(/^带上[：:]?/, "").replace(/[\s，。！？、,.!?：:]/g, ""));
      return required.every((item) => checklist.some((candidate) => candidate.includes(item.replace(/[\s，。！？、,.!?：:]/g, ""))));
    },
  }],
});

registerCapabilityStandard({
  capability: "input_processing",
  version: "1.0",
  description: "用户输入必须被正确分类，并产生可用答案、记录或保存结果",
  requiresConfirmation: false,
  allowedSideEffects: ["create_conversation", "create_entry", "save_knowledge"],
  failurePolicy: "retry",
  acceptance: () => [{
    id: "usable-result",
    description: "输入处理产生了可用且非答非所问的结果",
    check: (result) => {
      const value = result as { kind?: string; answer?: string; entries?: unknown[]; item?: unknown } | null;
      if (!value) return false;
      if (value.kind === "ask") {
        const answer = String(value.answer || "").trim();
        return answer.length > 0 && !/没有明确写出|无法查询|没有找到相关|未配置 AI/.test(answer);
      }
      if (value.kind === "record") return Array.isArray(value.entries) && value.entries.length > 0;
      if (value.kind === "save") return value.item != null;
      return false;
    },
  }],
});

for (const capability of ["document_action", "research", "todo", "reminder", "qq_task_sync", "desktop_action"]) {
  registerCapabilityStandard({
    capability,
    version: "1.0",
    description: `${capability} 必须完成执行并反馈结果`,
    requiresConfirmation: capability !== "qq_task_sync",
    allowedSideEffects: capability === "todo" ? ["create_todo"] : [],
    failurePolicy: "awaiting_user",
    acceptance: () => [{ id: "result-present", description: "任务产生可追踪结果", check: (result) => result != null }],
  });
}
