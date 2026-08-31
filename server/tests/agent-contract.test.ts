import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTask, verifyAgentTask } from "../src/agent-contract.js";

test("Agent 任务必须经过验收才能进入 verified", () => {
  const task = createAgentTask<{ items: string[] }, { checklist: string[] }>({
    id: "tomorrow-1",
    capability: "tomorrow_brief",
    input: { items: ["2本作业记录本", "告家长书"] },
    acceptance: [
      { id: "coverage", description: "每个原始事项都出现在清单中", check: (result) => result.checklist.includes("2本作业记录本") && result.checklist.includes("告家长书") },
    ],
  });
  assert.equal(verifyAgentTask(task, { checklist: ["2本作业记录本"] }).stage, "failed");
  assert.equal(verifyAgentTask(task, { checklist: ["2本作业记录本", "告家长书"] }).stage, "verified");
});
