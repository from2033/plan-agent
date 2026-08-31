import { registerCapabilityStandard } from "./agent-contract.js";

registerCapabilityStandard({
  capability: "tomorrow_brief",
  description: "明日管家必须逐项覆盖所有明确的准备事项",
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
