import assert from "node:assert/strict";
import test from "node:test";

import { createFeedbackTicket } from "../src/feedback-tickets.js";
import { recordAgentFailureSample } from "../src/agent-quality.js";
import {
  createPersistentAgentTask,
  transitionPersistentAgentTask,
  verifyPersistentAgentTask,
} from "../src/agent-runtime.js";
import {
  approveStandardProposal,
  auditActiveAcceptanceStandards,
  createStandardProposal,
  recordActiveStandardRegression,
  rollbackStandardProposal,
} from "../src/acceptance-evolution.js";
import { validateDeclarativeRules } from "../src/agent-contract.js";

function readyDateTask(userId: string) {
  const task = createPersistentAgentTask(userId, "date_resolution", { expression: "中秋" });
  transitionPersistentAgentTask(userId, task.id, "classified", "classified");
  transitionPersistentAgentTask(userId, task.id, "extracted", "extracted");
  transitionPersistentAgentTask(userId, task.id, "executing", "executing");
  transitionPersistentAgentTask(userId, task.id, "verifying", "ready");
  return task;
}

test("任务始终使用创建时固化的标准版本并保存逐条验收证据", () => {
  const userId = `acceptance-fixed-${Date.now()}`;
  const task = readyDateTask(userId);
  const checked = verifyPersistentAgentTask(userId, task.id, { date: "2026-09-25", basis: "官方日历" });
  assert.equal(checked?.standardVersion, "1.0");
  assert.equal(checked?.validatorVersion, "2.0");
  assert.equal(checked?.acceptanceDetails[0]?.id, "date-resolved");
  assert.equal(checked?.acceptanceDetails[0]?.passed, true);
});

test("候选标准影子回放不改历史任务，批准后只影响新任务并可回滚", () => {
  const userId = `acceptance-evolution-${Date.now()}`;
  const positive = readyDateTask(userId);
  verifyPersistentAgentTask(userId, positive.id, { date: "2026-09-25", basis: "官方日历" });

  const negative = readyDateTask(userId);
  const negativeResult = { date: "2026-09-25", basis: "模型猜测" };
  const negativeVerified = verifyPersistentAgentTask(userId, negative.id, negativeResult)!;
  recordAgentFailureSample(negativeVerified, "user_correction", "日期依据不能只是模型猜测", negativeResult);

  const oldTask = readyDateTask(userId);
  const ticket = createFeedbackTicket(userId, { title: "日期依据错误", description: "Agent 使用了未经核对的日期依据" });
  const proposal = createStandardProposal(userId, ticket.id, {
    capability: "date_resolution",
    baseVersion: "1.0",
    rationale: "要求日期依据包含已核对的官方来源",
    riskLevel: "low",
    rules: [{ id: "official-basis", description: "日期依据必须经过官方来源核对", type: "regex", path: "result.basis", pattern: "官方" }],
    cases: [
      { name: "official-pass", input: { expression: "中秋" }, result: { date: "2026-09-25", basis: "官方日历" }, expectedPass: true },
      { name: "guess-blocked", input: { expression: "中秋" }, result: negativeResult, expectedPass: false },
    ],
  });
  assert.equal(proposal.status, "ready");
  assert.equal(proposal.replay?.negativeBlocked, 1);
  assert.equal(proposal.replay?.positivePassed, 1);
  assert.equal(negativeVerified.stage, "verified", "影子回放不能修改历史状态");

  const active = approveStandardProposal(proposal.id)!;
  assert.equal(active.status, "active");
  assert.equal(verifyPersistentAgentTask(userId, oldTask.id, negativeResult)?.stage, "verified", "旧任务继续使用 1.0");

  const newTask = readyDateTask(userId);
  assert.equal(newTask.standardVersion, proposal.candidateVersion);
  assert.equal(verifyPersistentAgentTask(userId, newTask.id, negativeResult)?.stage, "failed");
  assert.equal(rollbackStandardProposal(proposal.id, "test_cleanup")?.status, "rolled_back");
});

test("副作用能力没有持久化回执或幂等规则时不能进入待批准", () => {
  const userId = `acceptance-side-effect-${Date.now()}`;
  const ticket = createFeedbackTicket(userId, { title: "待办重复", description: "重复创建待办" });
  const proposal = createStandardProposal(userId, ticket.id, {
    capability: "todo",
    baseVersion: "1.1",
    rationale: "尝试限制重复待办",
    riskLevel: "high",
    rules: [{ id: "todo-required", description: "待办必须有编号", type: "required", path: "result.id" }],
    cases: [
      { name: "id-pass", input: {}, result: { id: "one", type: "memo", description: "A", done: false }, expectedPass: true },
      { name: "id-block", input: {}, result: { type: "memo", description: "A", done: false }, expectedPass: false },
    ],
  });
  assert.equal(proposal.status, "draft");
  assert.ok(proposal.replay?.reasons.some(reason => /回执|幂等/.test(reason)));
  assert.throws(() => approveStandardProposal(proposal.id), /proposal_not_ready/);
});

test("新标准出现三次纠正且首次通过率下降时自动回滚", () => {
  const userId = `acceptance-rollback-${Date.now()}`;
  const positive = readyDateTask(userId);
  verifyPersistentAgentTask(userId, positive.id, { date: "2026-09-25", basis: "官方日历" });
  const negative = readyDateTask(userId);
  const bad = { date: "2026-09-25", basis: "猜测" };
  const corrected = verifyPersistentAgentTask(userId, negative.id, bad)!;
  recordAgentFailureSample(corrected, "user_correction", "依据错误", bad);
  const ticket = createFeedbackTicket(userId, { title: "依据回归", description: "新标准观察" });
  const proposal = createStandardProposal(userId, ticket.id, {
    capability: "date_resolution", baseVersion: "1.0", rationale: "观察自动回滚",
    riskLevel: "low",
    rules: [{ id: "rollback-official", description: "要求官方依据", type: "regex", path: "result.basis", pattern: "官方" }],
    cases: [
      { name: "pass", input: {}, result: { date: "2026-09-25", basis: "官方日历" }, expectedPass: true },
      { name: "block", input: {}, result: bad, expectedPass: false },
    ],
  });
  const active = approveStandardProposal(proposal.id)!;
  for (let index = 0; index < 3; index++) {
    const task = readyDateTask(userId);
    assert.equal(verifyPersistentAgentTask(userId, task.id, bad)?.stage, "failed");
    recordActiveStandardRegression(task.capability, task.standardVersion);
  }
  const rolledBack = auditActiveAcceptanceStandards();
  assert.ok(rolledBack.some(item => item.id === active.id && item.status === "rolled_back"));
  assert.equal(readyDateTask(userId).standardVersion, "1.0");
});

test("声明式规则拒绝不安全正则和伪造的回执路径", () => {
  assert.throws(() => validateDeclarativeRules([{
    id: "unsafe", description: "不安全", type: "regex", path: "result.answer", pattern: "(a+)+$",
  }]), /pattern_unsafe/);
  assert.throws(() => validateDeclarativeRules([{
    id: "fake-receipt", description: "伪造回执", type: "receipt", path: "result.receipt",
  }]), /receipt_path_untrusted/);
});
