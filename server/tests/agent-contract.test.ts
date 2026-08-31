import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTask, registeredCapabilities, verifyAgentTask } from "../src/agent-contract.js";
import { createPersistentAgentTask, getPersistentAgentTask, listAgentTaskEvents, schedulePersistentAgentFollowUp, transitionPersistentAgentTask, verifyPersistentAgentTask, wakeDueAgentFollowUps } from "../src/agent-runtime.js";
import { agentQualityAudit, listAgentFailureSamples, recordAgentFailureSample } from "../src/agent-quality.js";

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
  const task = createPersistentAgentTask("agent-test-user", "todo", { payload: { description: "测试待办" } }, "test", "source-1");
  assert.equal(task.stage, "awaiting_confirmation");
  assert.equal(task.standardVersion, "1.1");
  assert.ok(transitionPersistentAgentTask("agent-test-user", task.id, "executing", "confirmed"));
  assert.ok(transitionPersistentAgentTask("agent-test-user", task.id, "verifying", "executed"));
  const verified = verifyPersistentAgentTask("agent-test-user", task.id, {
    id: "entry-1", type: "memo", description: "测试待办", done: false,
  });
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

test("能力注册表公开任务契约、幂等和跟进策略", () => {
  const desktop = registeredCapabilities().find((item) => item.capability === "desktop_intake");
  assert.equal(desktop?.version, "1.1");
  assert.match(desktop?.inputContract || "", /资料/);
  assert.match(desktop?.idempotencyRule || "", /idempotencyKey/);
  assert.match(desktop?.followUpPolicy || "", /手机/);
});

test("验收失败和用户纠正进入失败样本并计入质量审计", () => {
  const userId = `agent-quality-${Date.now()}`;
  const task = createPersistentAgentTask(userId, "input_processing", { title: "测试问题" });
  transitionPersistentAgentTask(userId, task.id, "classified", "classified");
  transitionPersistentAgentTask(userId, task.id, "extracted", "extracted");
  transitionPersistentAgentTask(userId, task.id, "executing", "executing");
  transitionPersistentAgentTask(userId, task.id, "verifying", "ready");
  const failed = verifyPersistentAgentTask(userId, task.id, { kind: "ask", answer: "没有找到相关信息" });
  assert.equal(failed?.stage, "failed");
  recordAgentFailureSample(failed!, "user_correction", "没有读取领域事实源", failed?.result);
  const samples = listAgentFailureSamples(userId) as Array<{ kind: string; description: string }>;
  assert.ok(samples.some((sample) => sample.kind === "acceptance"));
  assert.ok(samples.some((sample) => sample.kind === "user_correction" && sample.description === "没有读取领域事实源"));
  const audit = agentQualityAudit(userId) as { failedTasks: number; failureTypes: unknown[] };
  assert.equal(audit.failedTasks, 1);
  assert.ok(audit.failureTypes.length >= 2);
});

test("到期跟进会主动唤醒为等待用户状态并记录事件", () => {
  const userId = `agent-follow-up-${Date.now()}`;
  const task = createPersistentAgentTask(userId, "todo", { payload: { description: "稍后处理" } });
  const followUpAt = new Date(Date.now() + 60_000);
  const scheduled = schedulePersistentAgentFollowUp(userId, task.id, followUpAt.toISOString());
  assert.equal(scheduled?.stage, "follow_up");
  assert.equal(scheduled?.nextFollowUpAt, followUpAt.toISOString());
  const awakened = wakeDueAgentFollowUps(new Date(followUpAt.getTime() + 1));
  assert.ok(awakened.some((item) => item.id === task.id && item.stage === "awaiting_user"));
  assert.ok(listAgentTaskEvents(userId, task.id).some((item) => (item as { reason?: string }).reason === "scheduled_follow_up_due"));
});
