import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTask, verifyAgentTask } from "../src/agent-contract.js";
import { createPersistentAgentTask, getPersistentAgentTask, listAgentTaskEvents, transitionPersistentAgentTask, verifyPersistentAgentTask } from "../src/agent-runtime.js";

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

test("持久化 Agent 任务记录标准版本、事件和验收结果", () => {
  const task = createPersistentAgentTask("agent-test-user", "todo", { text: "测试待办" }, "test", "source-1");
  assert.equal(task.stage, "awaiting_confirmation");
  assert.equal(task.standardVersion, "1.0");
  assert.ok(transitionPersistentAgentTask("agent-test-user", task.id, "executing", "confirmed"));
  assert.ok(transitionPersistentAgentTask("agent-test-user", task.id, "verifying", "executed"));
  const verified = verifyPersistentAgentTask("agent-test-user", task.id, { created: true });
  assert.equal(verified?.stage, "verified");
  assert.equal(getPersistentAgentTask(task.id, "other-user"), null);
  assert.equal(listAgentTaskEvents("agent-test-user", task.id).length, 4);
});

test("Agent 任务拒绝非法状态跳转", () => {
  const task = createPersistentAgentTask("agent-test-user", "todo", { text: "测试" }, "test", "source-2");
  assert.throws(() => transitionPersistentAgentTask("agent-test-user", task.id, "verified", "非法"), /agent_invalid_transition/);
});

test("普通提问必须产生可用答案，空泛的未找到回答不能通过验收", () => {
  const failedTask = createPersistentAgentTask("agent-input-user", "input_processing", { title: "查询账单" });
  transitionPersistentAgentTask("agent-input-user", failedTask.id, "classified", "classified");
  transitionPersistentAgentTask("agent-input-user", failedTask.id, "extracted", "extracted");
  transitionPersistentAgentTask("agent-input-user", failedTask.id, "executing", "executing");
  transitionPersistentAgentTask("agent-input-user", failedTask.id, "verifying", "result_ready");
  assert.equal(verifyPersistentAgentTask("agent-input-user", failedTask.id, {
    kind: "ask",
    answer: "我找到了相关来源，但里面没有明确写出你问的这项信息。",
  })?.stage, "failed");

  const passedTask = createPersistentAgentTask("agent-input-user", "input_processing", { title: "查询账单" });
  transitionPersistentAgentTask("agent-input-user", passedTask.id, "classified", "classified");
  transitionPersistentAgentTask("agent-input-user", passedTask.id, "extracted", "extracted");
  transitionPersistentAgentTask("agent-input-user", passedTask.id, "executing", "executing");
  transitionPersistentAgentTask("agent-input-user", passedTask.id, "verifying", "result_ready");
  assert.equal(verifyPersistentAgentTask("agent-input-user", passedTask.id, {
    kind: "ask",
    answer: "数码订阅包含 App Store 礼品卡交易。",
  })?.stage, "verified");
});
